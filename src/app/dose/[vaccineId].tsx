import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton, Badge, Chip, Empty, ErrorState, Field, Footer, Input, Loading, SecondaryButton, Stepper, T } from '../../ui/components';
import { color, radius, space, touch, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { newId } from '../../domain/ids';
import { recordAdministration, reverseMovement, findRecentSimilar } from '../../domain/ledger';
import { lotsInStock, lastUsedLot, isExpired } from '../../db/repo/lots';
import { type Patient, type Sex, createPatient, recentPatients, searchPatients, setPatientDob, setPatientSex } from '../../db/repo/patients';
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
  /** Boy or girl: on file, and one chosen here to save with the dose. */
  const [childSex, setChildSex] = useState<Sex | null>(null);
  const [newSex, setNewSex] = useState<Sex | null>(null);
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

  const typedIsSaved = !!matches?.some((m) => m.name.toLowerCase() === childQuery.trim().toLowerCase());

  const pick = (p: Pick<Patient, 'id' | 'name' | 'dob' | 'sex'>) => {
    setChildId(p.id);
    setChildLabel(p.name);
    setChildDob(p.dob);
    setNewDob(null);
    setChildSex(p.sex);
    setNewSex(null);
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
  const stockInk = stock.level === 'OK' ? color.textMuted : stock.level === 'LOW' ? color.low : color.danger;

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

      // A typed name with a date of birth becomes a saved child, so the age is
      // on this dose and fills in by itself next visit. On the server, 198 of
      // 204 doses had a typed name and none a saved child: typing IS the
      // common path, so this is where the age has to work. If saving the child
      // fails, the dose still records with the name alone (invariant 5).
      let patientId = skipChild ? null : childId;
      let dobSaved = true;
      let sexSaved = true;
      if (!skipChild && !childId && label && (newDob || newSex)) {
        patientId = await createPatient(db, { name: label, dob: newDob, sex: newSex }, deviceId).then(
          (id) => {
            // Held on screen, so a retry after a failed dose write reuses this
            // child instead of saving the same name twice.
            pick({ id, name: label, dob: newDob, sex: newSex });
            return id;
          },
          () => {
            dobSaved = false;
            sexSaved = false;
            return null;
          },
        );
      }

      const { movement, created } = await recordAdministration(
        db,
        { deviceId },
        {
          clientActionId,
          vaccineId,
          lotId: effectiveLot,
          doses,
          patientId,
          patientLabel: label,
        },
      );
      // Only a real write moves the backup nag; a replayed intent is a no-op.
      if (created) await bumpDosesSinceBackup(db, doses);

      // AFTER the dose, and its failure is not the dose's failure: invariant 5
      // says nothing about a birthday may stop a vaccination being recorded.
      // Reported inside the one toast so the undo on it is not replaced.
      const dobToSave = !skipChild && childId && newDob && newDob !== childDob ? newDob : null;
      if (dobToSave) dobSaved = await setPatientDob(db, childId!, dobToSave).then(() => true, () => false);
      const sexToSave = !skipChild && childId && newSex && newSex !== childSex ? newSex : null;
      if (sexToSave) sexSaved = await setPatientSex(db, childId!, sexToSave).then(() => true, () => false);
      bump();

      const age = skipChild ? null : formatAge(dobSaved ? (newDob ?? childDob) : childDob, today);
      // The toast holds two lines, so the warning comes first and the rest is short.
      const what = doses === 1 ? vaccine.name : `${doses} doses of ${vaccine.name}`;
      const message = similar
        ? `${what} given again. Tap Undo if it was a double tap.`
        : !(dobSaved && sexSaved)
          ? `${what} given. Child's details not saved.`
          : label
            ? `${what} given to ${label}${age ? `, ${age}` : ''}.`
            : `${what} given.`;
      toast.show(message, async () => {
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
        <View style={st.stockBlock}>
          <View style={st.stockRow}>
            <T style={[st.stock, { color: stockInk }]}>{stock.primary} in stock</T>
            {stock.badge ? <Badge text={stock.badge} tone={stock.level === 'LOW' ? 'low' : 'danger'} /> : null}
          </View>
          {wouldGoNegative ? (
            <T style={st.danger}>
              Stock will go below zero, to {vaccine.on_hand_doses - doses}. A delivery was probably
              not logged. The dose is still recorded.
            </T>
          ) : null}
        </View>

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
            <T style={st.danger}>
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
                  setChildSex(null);
                  setNewSex(null);
                }}
              />
            </View>
          ) : (
            <>
              <Input
                placeholder="Type 2 letters, or a phone number"
                value={childQuery}
                onChangeText={(t) => {
                  setChildQuery(t);
                  // The wheel goes away below two letters; so does its date.
                  if (t.trim().length < 2) {
                    setNewDob(null);
                    setNewSex(null);
                  }
                }}
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
              {childQuery.trim().length >= 2 && !typedIsSaved ? (
                <Pressable
                  accessibilityRole="button"
                  style={st.addRow}
                  onPress={async () => {
                    const name = childQuery.trim();
                    const id = await createPatient(db, { name }, deviceId);
                    pick({ id, name, dob: null, sex: null });
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

        {childId && childDob && !editingDob ? (
          <Field label="Age">
            <View style={st.chipRow}>
              <T style={st.age}>{formatAge(childDob, today) ?? 'Check the date of birth'}</T>
              <SecondaryButton label="Change date of birth" onPress={() => setEditingDob(true)} />
            </View>
          </Field>
        ) : childId || (childQuery.trim().length >= 2 && !typedIsSaved) ? (
          // Also for a name that is only typed: that is how almost every dose
          // is entered. Not when the typed name IS a saved child - the chip
          // with that child's age is right above, and a date here would save
          // the same child twice. Keyed so a different child starts blank.
          <Field label="Date of birth" hint="Optional. Saved with the child, so the age fills in by itself next time.">
            <DateOfBirthWheel key={childId ?? 'typed'} today={today} initial={childDob} onChange={setNewDob} />
          </Field>
        ) : null}

        {childId || (childQuery.trim().length >= 2 && !typedIsSaved) ? (
          <Field label="Boy or girl" hint="Optional.">
            <View style={st.chipRow}>
              <Chip label="Boy" selected={(newSex ?? childSex) === 'M'} onPress={() => setNewSex('M')} />
              <Chip label="Girl" selected={(newSex ?? childSex) === 'F'} onPress={() => setNewSex('F')} />
            </View>
          </Field>
        ) : null}

        <Field label="Doses">
          <Stepper value={doses} onChange={setDoses} min={1} max={20} />
        </Field>
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
  name: { fontSize: type.hero, fontWeight: weight.bold, color: color.text },
  stockBlock: { marginTop: space.xs, marginBottom: space.xl },
  stockRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  stock: { fontSize: type.label, color: color.textMuted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  age: { fontSize: type.title, fontWeight: weight.bold, color: color.text },
  danger: { fontSize: type.label, fontWeight: weight.semibold, color: color.danger, marginTop: space.sm },
  addRow: { minHeight: touch.min, justifyContent: 'center', marginTop: space.sm },
  addText: { fontSize: type.body, fontWeight: weight.semibold, color: color.dose },
  skip: { minHeight: touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  skipText: { fontSize: type.body, fontWeight: weight.semibold, color: color.dose },
});
