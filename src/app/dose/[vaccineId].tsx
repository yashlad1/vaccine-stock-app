import React, { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton, Badge, Chip, ErrorState, Field, Footer, Input, Loading, SecondaryButton, Stepper, T } from '../../ui/components';
import { color, radius, space, touch, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { newId } from '../../domain/ids';
import { reverseMovement, findRecentSimilar } from '../../domain/ledger';
import { lotsInStock, lastUsedLot, isExpired } from '../../db/repo/lots';
import { type Patient, type Sex, createPatient, recentPatients, searchPatients, setPatientDob, setPatientSex } from '../../db/repo/patients';
import { bumpDosesSinceBackup } from '../../db/repo/settings';
import { describeStock } from '../../domain/stock';
import { addDays, expiryToMonthLabel, formatAge, todayLocal } from '../../domain/time';
import { type DoseNote, stripDoseToken } from '../../domain/names';
import { type Visit, type VisitIds, coGiven, recordVisit, visitIds } from '../../domain/visits';
import { DateOfBirthWheel } from '../../ui/wheel';
import type { StockRow } from '../../domain/types';

/** The dose-number chips, and the note each writes on the dose. */
const DOSE_CHIPS: { label: string; note: DoseNote }[] = [
  { label: '1st', note: 'Dose 1' },
  { label: '2nd', note: 'Dose 2' },
  { label: '3rd', note: 'Dose 3' },
  { label: 'Booster', note: 'Booster' },
];

const dosesText = (n: number) => `${n} ${Math.abs(n) === 1 ? 'dose' : 'doses'}`;

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
  /** undefined = not touched, so a dose number typed into the name preselects; null = cleared. */
  const [doseNote, setDoseNote] = useState<DoseNote | null | undefined>(undefined);
  /** Vaccine ids ticked under "Also giving now". */
  const [extras, setExtras] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  /**
   * The ids of the last failed tap on Give. A retry with the same inputs
   * replays them, so a write that half-happened is a no-op instead of a second
   * dose; changed inputs get new ones (`visitIds`). The screen closes on
   * success, which ends the intent.
   */
  const lastIds = useRef<VisitIds | null>(null);
  /**
   * Set in the same tick as the tap. `saving` is state, so two taps in one
   * frame both read it as false, and both saved the typed child.
   */
  const busy = useRef(false);

  /** "Asha 2 Dose" searches, and is saved, as "Asha"; the "2" goes to the dose number. */
  const typed = stripDoseToken(childQuery);

  const { data: vaccine, error, reload } = useQuery(
    (d) => d.first<StockRow>(`SELECT * FROM v_stock_on_hand WHERE vaccine_id = ?`, [vaccineId]),
    [vaccineId],
  );
  const { data: lots } = useQuery((d) => lotsInStock(d, vaccineId), [vaccineId]);
  const { data: preferredLot } = useQuery((d) => lastUsedLot(d, vaccineId), [vaccineId]);
  const { data: recent } = useQuery((d) => recentPatients(d, today, 3), [today]);
  const { data: matches } = useQuery(
    (d) => (typed.name.length >= 2 ? searchPatients(d, typed.name, 8) : Promise.resolve([])),
    [typed.name],
  );
  const { data: suggestions } = useQuery(
    async (d) => {
      const rows = await coGiven(d, vaccineId, addDays(today, -90));
      // Each added vaccine takes the batch its own screen would preselect.
      return Promise.all(
        rows.map(async (r) => ({
          ...r,
          lot: (await lastUsedLot(d, r.vaccine_id)) ?? (await lotsInStock(d, r.vaccine_id))[0] ?? null,
        })),
      );
    },
    [vaccineId, today],
  );

  // Preselect the most-recently-used lot, so lot choice is usually zero taps.
  const effectiveLot = lotId !== undefined ? lotId : (preferredLot?.lot_id ?? lots?.[0]?.lot_id ?? null);
  const selected = useMemo(() => lots?.find((l) => l.lot_id === effectiveLot) ?? null, [lots, effectiveLot]);
  const expired = selected ? isExpired(selected, today) : false;
  // FEFO as a hint only. lotsInStock is ordered by expiry with undated last;
  // an expired batch is skipped, since Give would warn about it.
  const useFirstId = lots && lots.length > 1 ? lots.find((l) => l.expiry_date && !isExpired(l, today))?.lot_id : undefined;
  const anotherBatch = !!lots && lots.length > 1;
  // One batch, expired, is still a choice: it, or "Not sure" for a batch the
  // app does not have. A plain line would leave every dose raising the confirm.
  const batchChips = anotherBatch || (lots?.length === 1 && isExpired(lots[0], today));

  const typedIsSaved = !!matches?.some((m) => m.name.toLowerCase() === typed.name.toLowerCase());
  const typedNew = childQuery.trim().length >= 2 && !typedIsSaved;
  /**
   * The optional details show once a child is chosen or a new name typed. Not
   * when the typed name IS a saved child: that child's chip, with the age, is
   * right there. What is hidden is never written.
   */
  const childDetails = !!childId || typedNew;
  const effectiveDose = childDetails ? (doseNote !== undefined ? doseNote : typed.dose) : null;
  const chosenExtras = childDetails ? (suggestions ?? []).filter((s) => extras.includes(s.vaccine_id)) : [];
  // The one rule for saving a typed name as a child, used by the hint and by write().
  const savesTypedChild = !childId && typedNew && !!(newDob || newSex || effectiveDose);

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
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    // A failed write must SAY so. Silently doing nothing here is the worst
    // outcome in the app: she would assume the dose was recorded, and stock
    // would start drifting from the fridge.
    const ok = await run('record this dose', async () => {
      const also = skipChild ? [] : chosenExtras;
      // A failed nudge lookup is no reason to lose the dose (invariant 5).
      const similar = await findRecentSimilar(db, {
        vaccineId, movementType: 'ADMINISTRATION', deltaDoses: -doses,
      }).catch(() => null);

      // The ledger keeps the name exactly as typed, dose number and all.
      const label = skipChild ? null : (childLabel ?? (childQuery.trim() || null));

      // A typed name with a date of birth, a sex or a dose number becomes a
      // saved child (without the dose number in the name), so the age is on
      // this dose and the child is one tap on the next vaccine today. On the
      // server, 198 of 204 doses had a typed name and none a saved child:
      // typing IS the common path. If saving the child fails, the dose still
      // records with the name alone (invariant 5).
      let patientId = skipChild ? null : childId;
      let dobSaved = true;
      let sexSaved = true;
      if (!skipChild && savesTypedChild && label) {
        patientId = await createPatient(db, { name: typed.name, dob: newDob, sex: newSex }, deviceId).then(
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

      const visit: Visit = {
        vaccineId,
        doses,
        lotId: effectiveLot,
        patientId,
        patientLabel: label,
        note: skipChild ? null : effectiveDose,
        extras: also.map((x) => ({ vaccineId: x.vaccine_id, lotId: x.lot?.lot_id ?? null })),
      };
      const ids = (lastIds.current = visitIds(lastIds.current, visit));
      // The only write whose failure is this Give's failure. Past it, the dose
      // is in the ledger, and nothing below may say otherwise.
      const r = await recordVisit(db, { deviceId }, ids, visit);

      // Described from the rows the ledger holds, a replay included.
      const nameOf = (id: string) => (id === vaccineId ? vaccine.name : (also.find((x) => x.vaccine_id === id)?.name ?? ''));
      const written = [r.main, ...r.extras].map(({ movement: m, created }) => {
        const n = -m.delta_doses;
        const name = nameOf(m.vaccine_id);
        return { id: m.id, created, doses: n, name, what: n === 1 ? name : `${n} doses of ${name}` };
      });
      const { what } = written[0];
      const failed = r.failed.map(nameOf);
      // A retry replays this Give's own row; that is not a second dose.
      const doubleTap = !!similar && similar.id !== r.main.movement.id;

      // AFTER the dose, and its failure is not the dose's failure: invariant 5
      // says nothing about a birthday may stop a vaccination being recorded.
      // Reported inside the one toast so the undo on it is not replaced.
      const dobToSave = !skipChild && childId && newDob && newDob !== childDob ? newDob : null;
      if (dobToSave) dobSaved = await setPatientDob(db, childId!, dobToSave).then(() => true, () => false);
      const sexToSave = !skipChild && childId && newSex && newSex !== childSex ? newSex : null;
      if (sexToSave) sexSaved = await setPatientSex(db, childId!, sexToSave).then(() => true, () => false);
      bump();

      const m = r.main.movement;
      const who = m.patient_label ? stripDoseToken(m.patient_label).name : null;
      // An age only for a saved child: an unlinked dose has no date of birth behind it.
      const age = m.patient_id ? formatAge(dobSaved ? (newDob ?? childDob) : childDob, today) : null;
      const doseNo = DOSE_CHIPS.find((c) => c.note === m.note);
      const detailsLost = !(dobSaved && sexSaved);
      // Warnings first: the toast holds three lines and the end may be cut.
      const message = [
        failed.length ? `${failed.join(', ')} not saved. Give ${failed.length === 1 ? 'it' : 'them'} again.` : null,
        written.length > 1
          ? `${doubleTap ? 'Given again? Tap Undo if it was a double tap. ' : ''}${detailsLost ? "Child's details not saved. " : ''}` +
            `${written.length} vaccines given${who ? ` to ${who}` : ''}: ${written.map((w) => w.what).join(', ')}.`
          : doubleTap
            ? `${what} given again. Tap Undo if it was a double tap.`
            : detailsLost
              ? `${what} given. Child's details not saved.`
              : who
                ? `${what} given to ${who}${age ? `, ${age}` : ''}${doseNo ? `, ${doseNo.label.toLowerCase()} dose` : ''}.`
                : `${what} given.`,
      ].filter(Boolean).join(' ');

      toast.show(message, async () => {
        // Undo writes a REVERSING ENTRY for every dose this Give wrote. It
        // never deletes, so the correction is auditable and stays available
        // from the Ledger screen forever.
        await run('undo that dose', async () => {
          const notUndone: string[] = [];
          let undoneDoses = 0;
          for (const w of written) {
            try {
              const rev = await reverseMovement(db, { deviceId }, { clientActionId: newId(), movementId: w.id });
              if (rev.created) undoneDoses += w.doses;
            } catch (e) {
              // One vaccine keeps the plain error toast. Several: undo the
              // rest, then name what is left.
              if (written.length === 1) throw e;
              notUndone.push(w.name);
            }
          }
          // Bookkeeping: its failure is not the undo's failure.
          if (undoneDoses) await bumpDosesSinceBackup(db, -undoneDoses).catch(() => undefined);
          bump();
          if (notUndone.length) {
            toast.showError(
              `Could not undo ${notUndone.join(', ')}. Undo ${notUndone.length === 1 ? 'it' : 'them'} from All entries on More.`,
            );
          }
        });
      });
    });
    setSaving(false);
    // Only leave the screen if it actually saved, so a failure leaves her
    // where she can read the message and try again. After a save the guard
    // stays up: a tap still queued (a second expired-batch dialog) must not
    // write again or go back a second screen.
    if (ok) router.back();
    else busy.current = false;
  };

  /**
   * An expired batch CONFIRMS; it never blocks.
   *
   * Invariant 5: recording a dose must never be blocked. If the only batch in
   * the fridge is past its printed month - or the app's expiry data is simply
   * wrong - refusing the write means the dose goes unlogged, and an unlogged
   * dose is the drift this whole app exists to prevent. CLAUDE.md section 8
   * lists "expired lot" among the few genuine reasons to confirm, so confirm
   * is exactly what this does. An added vaccine's batch joins the same
   * dialog: one confirm, never a second.
   */
  const give = (skipChild: boolean) => {
    const staleExtras = skipChild ? [] : chosenExtras.filter((x) => x.lot && isExpired(x.lot, today));
    if (!expired && !staleExtras.length) return void write(skipChild);
    const lines = [
      ...(expired
        ? [`${staleExtras.length ? `${vaccine.name}: ` : ''}${selected?.lot_number ?? 'This batch'} expired ${expiryToMonthLabel(selected!.expiry_date!)}.`]
        : []),
      ...staleExtras.map((x) => `${x.name}: ${x.lot!.lot_number} expired ${expiryToMonthLabel(x.lot!.expiry_date!)}.`),
    ];
    const pickAnother = anotherBatch && !staleExtras.length;
    Alert.alert(
      lines.length > 1 ? 'These batches have expired' : 'This batch has expired',
      lines.join('\n') +
        (pickAnother ? '\n\nRecord the dose anyway, or go back and pick another batch?' : '\n\nRecord anyway, or go back?'),
      [
        { text: pickAnother ? 'Pick another batch' : 'Go back', style: 'cancel' },
        { text: 'Record anyway', style: 'destructive', onPress: () => void write(skipChild) },
      ],
    );
  };

  const clearChild = () => {
    setNewDob(null);
    setNewSex(null);
    setDoseNote(undefined);
    setExtras([]);
  };

  return (
    <View style={st.screen}>
      <Stack.Screen options={{ title: `Give ${vaccine.name}` }} />
      <ScrollView contentContainerStyle={[st.content, centred]} keyboardShouldPersistTaps="handled">
        {/* The vaccine name IS the confirmation, and it costs no tap. */}
        <View style={st.head}>
          <View style={st.headRow}>
            <T style={st.name}>{vaccine.name}</T>
            <T style={[st.stock, { color: stockInk }]}>{stock.primary} in stock</T>
            {stock.badge ? <Badge text={stock.badge} tone={stock.level === 'LOW' ? 'low' : 'danger'} /> : null}
          </View>
          {wouldGoNegative ? (
            <T style={st.danger}>
              Stock will go below zero, to {vaccine.on_hand_doses - doses}. A delivery was probably not
              added. Tapping Give still records the dose.
            </T>
          ) : null}
        </View>

        {/* A batch is a choice when there are two, or one has expired; one is a line, none a sentence. */}
        {lots && batchChips ? (
          <Field dense label="Batch / lot">
            <View style={st.chipRow}>
              {lots.map((l) => (
                <Chip
                  key={l.lot_id}
                  label={l.lot_number}
                  sublabel={`${l.on_hand_doses} left${l.expiry_date ? ` · exp ${expiryToMonthLabel(l.expiry_date)}` : ''}${l.lot_id === useFirstId ? ' · use first' : ''}`}
                  selected={effectiveLot === l.lot_id}
                  onPress={() => setLotId(l.lot_id)}
                />
              ))}
              <Chip label="Not sure" selected={effectiveLot === null} onPress={() => setLotId(null)} />
            </View>
          </Field>
        ) : lots?.length === 1 ? (
          <T style={st.batch}>
            Batch {lots[0].lot_number}
            {lots[0].expiry_date ? ` · exp ${expiryToMonthLabel(lots[0].expiry_date)}` : ''}
          </T>
        ) : lots ? (
          <T style={[st.batch, st.muted]}>No batch recorded for this vaccine.</T>
        ) : null}
        {expired ? (
          <T style={[st.danger, st.afterBatch]}>
            This batch expired {expiryToMonthLabel(selected!.expiry_date!)}.{' '}
            {anotherBatch ? 'Pick another batch if you have one.' : 'If you are using another batch, pick Not sure.'}{' '}
            You can still record the dose.
          </T>
        ) : null}

        <Field dense label="Child">
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
                  setChildSex(null);
                  clearChild();
                }}
              />
            </View>
          ) : (
            <>
              <Input
                placeholder="Child's name"
                value={childQuery}
                onChangeText={(t) => {
                  setChildQuery(t);
                  // The details go away below two letters; so do their values.
                  if (t.trim().length < 2) clearChild();
                }}
                autoCorrect={false}
                autoCapitalize="words"
                accessibilityLabel="Child's name"
              />
              {matches?.length ? (
                <View style={[st.chipRow, st.below]}>
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
              {savesTypedChild ? <T style={st.hint}>New child. Saved when you tap Give.</T> : null}
              {!childQuery && recent?.length ? (
                <>
                  <T style={st.hint}>Given a dose today</T>
                  <View style={[st.chipRow, st.below]}>
                    {recent.map((p) => (
                      <Chip
                        key={p.id}
                        label={p.name}
                        sublabel={formatAge(p.dob, today) ?? undefined}
                        onPress={() => pick(p)}
                      />
                    ))}
                  </View>
                </>
              ) : null}
            </>
          )}
        </Field>

        {childId && childDob && !editingDob ? (
          <Field dense label="Age">
            <View style={st.chipRow}>
              <T style={st.age}>{formatAge(childDob, today) ?? 'Check the date of birth'}</T>
              <SecondaryButton label="Change date of birth" onPress={() => setEditingDob(true)} />
            </View>
          </Field>
        ) : childDetails ? (
          // Keyed so a different child starts blank.
          <Field dense label="Date of birth">
            <DateOfBirthWheel key={childId ?? 'typed'} today={today} initial={childDob} onChange={setNewDob} />
          </Field>
        ) : null}

        {childDetails ? (
          <>
            <Field dense label="Boy or girl">
              <View style={st.chipRow}>
                <Chip label="Boy" selected={(newSex ?? childSex) === 'M'} onPress={() => setNewSex('M')} />
                <Chip label="Girl" selected={(newSex ?? childSex) === 'F'} onPress={() => setNewSex('F')} />
              </View>
            </Field>
            <Field dense label="Which dose">
              <View style={st.chipRow}>
                {DOSE_CHIPS.map((c) => (
                  <Chip
                    key={c.note}
                    label={c.label}
                    selected={effectiveDose === c.note}
                    // Tapping the chosen one clears it.
                    onPress={() => setDoseNote(effectiveDose === c.note ? null : c.note)}
                  />
                ))}
              </View>
            </Field>
            {suggestions?.length ? (
              <Field dense label="Also giving now">
                <View style={st.chipRow}>
                  {suggestions.map((s) => (
                    <Chip
                      key={s.vaccine_id}
                      label={s.name}
                      // OUT can still be chosen: a dose is never blocked (invariant 5).
                      sublabel={s.on_hand_doses === 0 ? 'OUT' : dosesText(s.on_hand_doses)}
                      selected={extras.includes(s.vaccine_id)}
                      onPress={() =>
                        setExtras((xs) =>
                          xs.includes(s.vaccine_id) ? xs.filter((x) => x !== s.vaccine_id) : [...xs, s.vaccine_id],
                        )
                      }
                    />
                  ))}
                </View>
              </Field>
            ) : null}
          </>
        ) : null}

        <Field dense label="Doses">
          <Stepper value={doses} onChange={setDoses} min={1} max={20} />
        </Field>
      </ScrollView>

      <Footer gap={space.md}>
        {/* With a name typed, Give records it; "no name" would contradict the box. */}
        {!childLabel && !childQuery.trim() ? (
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
          // Doses first, the unit of the whole app: one dose of each added vaccine.
          label={
            chosenExtras.length
              ? `Give ${dosesText(doses + chosenExtras.length)} (${chosenExtras.length + 1} vaccines)`
              : `Give ${dosesText(doses)}`
          }
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
  head: { marginBottom: space.md },
  headRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs },
  name: { fontSize: type.hero, fontWeight: weight.bold, color: color.text },
  stock: { fontSize: type.label, color: color.textMuted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  below: { marginTop: space.sm },
  batch: { fontSize: type.label, fontWeight: weight.semibold, color: color.text, marginBottom: space.md },
  muted: { color: color.textMuted, fontWeight: weight.regular },
  afterBatch: { marginTop: 0, marginBottom: space.md },
  hint: { fontSize: type.min, color: color.textMuted, marginTop: space.sm },
  age: { fontSize: type.title, fontWeight: weight.bold, color: color.text },
  danger: { fontSize: type.label, fontWeight: weight.semibold, color: color.danger, marginTop: space.sm },
  skip: { minHeight: touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  skipText: { fontSize: type.body, fontWeight: weight.semibold, color: color.dose },
});
