import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton, Chip, Empty, ErrorState, Field, Footer, Input, Loading, SecondaryButton, Stepper, T } from '../../ui/components';
import { color, radius, space, touch, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { newId } from '../../domain/ids';
import { recordAdministration, reverseMovement, findRecentSimilar } from '../../domain/ledger';
import { lotsInStock, lastUsedLot, isExpired } from '../../db/repo/lots';
import { type Patient, createPatient, recentPatients, searchPatients, setPatientDob } from '../../db/repo/patients';
import { bumpDosesSinceBackup } from '../../db/repo/settings';
import { describeStock } from '../../domain/stock';
import { expiryToMonthLabel, formatAge, todayLocal } from '../../domain/time';
import { DateOfBirthWheel } from '../../ui/wheel';
import type { StockRow } from '../../domain/types';

/**
 * The dose modal. Target: 3 taps from launch (tile -> child chip -> GIVE), or
 * 2 if she skips the child.
 *
 * No confirmation dialog. The write happens on GIVE and the snackbar is the
 * confirmation, because a confirm on the common path trains people to tap
 * through confirms.
 */
export default function DoseScreen() {
  const { vaccineId } = useLocalSearchParams<{ vaccineId: string }>();
  const router = useRouter();
  const { db, deviceId, bump } = useDb();
  const toast = useToast();
  const run = useAction();
  const today = todayLocal();

  const [doses, setDoses] = useState(1);
  const [lotId, setLotId] = useState<string | null | undefined>(undefined);
  const [childId, setChildId] = useState<string | null>(null);
  const [childLabel, setChildLabel] = useState<string | null>(null);
  const [childQuery, setChildQuery] = useState('');
  /** The date of birth already on file, and one entered here to save with the dose. */
  const [childDob, setChildDob] = useState<string | null>(null);
  const [newDob, setNewDob] = useState<string | null>(null);
  const [editingDob, setEditingDob] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: vaccine, error, reload } = useQuery(
    (d) => d.first<StockRow>(`SELECT * FROM v_stock_on_hand WHERE vaccine_id = ?`, [vaccineId]),
    [vaccineId],
  );
  const { data: lots } = useQuery((d) => lotsInStock(d, vaccineId), [vaccineId]);
  const { data: preferredLot } = useQuery((d) => lastUsedLot(d, vaccineId), [vaccineId]);
  const { data: recent } = useQuery((d) => recentPatients(d, 12), []);
  const { data: matches } = useQuery(
    (d) => (childQuery.trim().length >= 2 ? searchPatients(d, childQuery.trim(), 8) : Promise.resolve([])),
    [childQuery],
  );

  // Preselect the most-recently-used lot, so lot choice is usually zero taps.
  const effectiveLot = lotId !== undefined ? lotId : (preferredLot?.lot_id ?? lots?.[0]?.lot_id ?? null);
  const selected = useMemo(() => lots?.find((l) => l.lot_id === effectiveLot) ?? null, [lots, effectiveLot]);
  const expired = selected ? isExpired(selected, today) : false;

  const pick = (p: Pick<Patient, 'id' | 'name' | 'dob'>) => {
    setChildId(p.id);
    setChildLabel(p.name);
    setChildDob(p.dob);
    setNewDob(null);
    setEditingDob(false);
  };

  if (error) return <ErrorState error={error} onRetry={reload} what="load this vaccine" />;
  if (!vaccine) return <Loading label="Loading vaccine" />;

  const stock = describeStock(
    vaccine.on_hand_doses,
    vaccine.unit_mode,
    vaccine.doses_per_vial,
    vaccine.min_balance_doses,
  );
  const wouldGoNegative = vaccine.on_hand_doses - doses < 0;

  /**
   * `skipChild` is passed explicitly by the Skip button. It must not be
   * inferred from `childLabel` being empty: the search box may hold a
   * half-typed name, and a button that says "no name" has to mean it.
   */
  const write = async (skipChild: boolean) => {
    if (saving) return;
    setSaving(true);
    // A failed write must SAY so. Silently doing nothing here is the worst
    // outcome in the app: she would assume the dose was recorded, and stock
    // would start drifting from the fridge.
    const ok = await run('record this dose', async () => {
      // Minted here, at the tap, and reused for any retry of THIS intent.
      const clientActionId = newId();

      const similar = await findRecentSimilar(db, {
        vaccineId, movementType: 'ADMINISTRATION', deltaDoses: -doses,
      });

      const label = skipChild ? null : (childLabel ?? (childQuery.trim() || null));
      const { movement, created } = await recordAdministration(
        db,
        { deviceId },
        {
          clientActionId,
          vaccineId,
          lotId: effectiveLot,
          doses,
          patientId: skipChild ? null : childId,
          patientLabel: label,
        },
      );
      // Only a real write moves the backup nag; a replayed intent is a no-op.
      if (created) await bumpDosesSinceBackup(db, doses);

      // AFTER the dose, and its failure is not the dose's failure: invariant 5
      // says nothing about a birthday may stop a vaccination being recorded.
      // Reported inside the one toast so the undo on it is not replaced.
      const dobToSave = !skipChild && childId && newDob && newDob !== childDob ? newDob : null;
      const dobSaved = dobToSave
        ? await setPatientDob(db, childId!, dobToSave).then(() => true, () => false)
        : true;
      bump();

      const age = skipChild ? null : formatAge(dobSaved ? (dobToSave ?? childDob) : childDob, today);
      const who = label ? ` to ${label}${age ? ` (${age})` : ''}` : '';
      const note = similar ? ' (a similar dose was recorded moments ago)' : '';
      const dobNote = dobSaved ? '' : ' The date of birth did not save. Add it next time.';
      toast.show(`${doses} × ${vaccine.name} recorded${who}.${note}${dobNote}`, async () => {
        // Undo writes a REVERSING ENTRY. It never deletes, so the correction is
        // auditable and stays available from the Ledger screen forever.
        await run('undo that dose', async () => {
          const r = await reverseMovement(db, { deviceId }, { clientActionId: newId(), movementId: movement.id });
          if (r.created) await bumpDosesSinceBackup(db, -doses);
          bump();
        });
      });
    });
    setSaving(false);
    // Only leave the screen if it actually saved, so a failure leaves her
    // where she can read the message and try again.
    if (ok) router.back();
  };

  /**
   * An expired batch CONFIRMS; it never blocks.
   *
   * Invariant 5: recording a dose must never be blocked. If the only batch in
   * the fridge is past its printed month - or the app's expiry data is simply
   * wrong - refusing the write means the dose goes unlogged, and an unlogged
   * dose is the drift this whole app exists to prevent. CLAUDE.md section 8
   * lists "expired lot" among the few genuine reasons to confirm, so confirm
   * is exactly what this does.
   */
  const give = (skipChild: boolean) => {
    if (!expired) return void write(skipChild);
    Alert.alert(
      'This batch has expired',
      `${selected?.lot_number ?? 'This batch'} expired ${expiryToMonthLabel(selected!.expiry_date!)}.` +
        '\n\nRecord the dose anyway, or go back and pick another batch?',
      [
        { text: 'Pick another batch', style: 'cancel' },
        { text: 'Record anyway', style: 'destructive', onPress: () => void write(skipChild) },
      ],
    );
  };

  return (
    <View style={st.screen}>
      <ScrollView contentContainerStyle={[st.content, centred]} keyboardShouldPersistTaps="handled">
        {/* The vaccine name IS the confirmation, and it costs no tap. */}
        <T style={st.name}>{vaccine.name}</T>
        <T style={st.stock}>
          {stock.primary} in stock
        </T>

        <Field
          label="Batch / lot"
          hint={lots?.length ? undefined : 'No batch recorded yet. You can still log the dose.'}
        >
          {lots?.length ? (
            <View style={st.chipRow}>
              {lots.map((l) => (
                <Chip
                  key={l.lot_id}
                  label={l.lot_number}
                  sublabel={`${l.on_hand_doses} left${l.expiry_date ? ` · exp ${expiryToMonthLabel(l.expiry_date)}` : ''}`}
                  selected={effectiveLot === l.lot_id}
                  onPress={() => setLotId(l.lot_id)}
                />
              ))}
              <Chip label="Not sure" selected={effectiveLot === null} onPress={() => setLotId(null)} />
            </View>
          ) : null}
          {expired ? (
            <T style={st.warn}>
              This batch expired {expiryToMonthLabel(selected!.expiry_date!)}. Pick another batch if
              you have one. You can still record the dose.
            </T>
          ) : null}
        </Field>

        <Field label="Child" hint="Optional. You can add the name later.">
          {childLabel ? (
            <View style={st.chipRow}>
              <Chip label={childLabel} selected onPress={() => undefined} />
              <SecondaryButton
                label="Change"
                onPress={() => {
                  setChildId(null);
                  setChildLabel(null);
                  setChildQuery('');
                  setChildDob(null);
                  setNewDob(null);
                }}
              />
            </View>
          ) : (
            <>
              <Input
                placeholder="Type 2 letters, or a phone number"
                value={childQuery}
                onChangeText={setChildQuery}
                autoCorrect={false}
                autoCapitalize="words"
                accessibilityLabel="Search or add child"
              />
              {matches?.length ? (
                <View style={st.chipRow}>
                  {matches.map((p) => (
                    <Chip
                      key={p.id}
                      label={p.name}
                      // Age tells siblings and namesakes apart faster than a
                      // date of birth would (clinic-queue's Age component).
                      sublabel={formatAge(p.dob, today) ?? undefined}
                      onPress={() => pick(p)}
                    />
                  ))}
                </View>
              ) : null}
              {childQuery.trim().length >= 2 && !matches?.some((m) => m.name.toLowerCase() === childQuery.trim().toLowerCase()) ? (
                <Pressable
                  accessibilityRole="button"
                  style={st.addRow}
                  onPress={async () => {
                    const name = childQuery.trim();
                    const id = await createPatient(db, { name }, deviceId);
                    pick({ id, name, dob: null });
                    bump();
                  }}
                >
                  <T style={st.addText}>+ Add "{childQuery.trim()}" as a new child</T>
                </Pressable>
              ) : null}
              {!childQuery && recent?.length ? (
                <View style={st.chipRow}>
                  {recent.map((p) => (
                    <Chip
                      key={p.id}
                      label={p.name}
                      // Age tells siblings and namesakes apart faster than a
                      // date of birth would (clinic-queue's Age component).
                      sublabel={formatAge(p.dob, today) ?? undefined}
                      onPress={() => pick(p)}
                    />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </Field>

        {childId ? (
          childDob && !editingDob ? (
            <Field label="Age">
              <View style={st.chipRow}>
                <T style={st.age}>{formatAge(childDob, today) ?? 'Check the date of birth'}</T>
                <SecondaryButton label="Change date of birth" onPress={() => setEditingDob(true)} />
              </View>
            </Field>
          ) : (
            <Field label="Date of birth" hint="Optional. Saved with the child, so the age fills in by itself next time.">
              <DateOfBirthWheel today={today} initial={childDob} onChange={setNewDob} />
            </Field>
          )
        ) : null}

        <Field label="Doses">
          <Stepper value={doses} onChange={setDoses} min={1} max={20} />
        </Field>

        {wouldGoNegative ? (
          <T style={st.warn}>
            This will take stock below zero ({vaccine.on_hand_doses - doses} doses). That usually
            means a delivery was never logged. The dose will still be recorded.
          </T>
        ) : null}
      </ScrollView>

      <Footer gap={space.md}>
        {!childLabel ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => give(true)}
            disabled={saving}
            style={st.skip}
          >
            <T style={st.skipText}>Skip, no name</T>
          </Pressable>
        ) : null}
        <BigButton
          label={`Give ${doses} ${doses === 1 ? 'dose' : 'doses'}`}
          onPress={() => give(false)}
          disabled={saving}
        />
      </Footer>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, paddingBottom: space.xxl },
  name: { fontSize: type.hero, fontWeight: weight.semibold, color: color.text },
  stock: { fontSize: type.label, color: color.textMuted, marginTop: space.xs, marginBottom: space.xl },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  age: { fontSize: type.title, fontWeight: weight.semibold, color: color.text, fontVariant: ['tabular-nums'] },
  warn: { fontSize: type.label, fontWeight: weight.semibold, color: color.low, marginTop: space.sm },
  addRow: { minHeight: touch.min, justifyContent: 'center', marginTop: space.sm },
  addText: { fontSize: type.body, fontWeight: weight.semibold, color: color.dose },
  skip: { minHeight: touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  skipText: { fontSize: type.body, fontWeight: weight.semibold, color: color.dose },
});
