import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton, Chip, ErrorState, Field, Footer, Input, Loading, SecondaryButton, Stepper, T } from '../../ui/components';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { removeVaccine, restoreVaccine, setVaccinePrice, vaccineUsage } from '../../db/repo/catalog';
import { parseRupees } from '../../domain/money';
import type { UnitMode, Vaccine } from '../../domain/types';

/**
 * Editing the catalog. `doses_per_vial` is the field that matters most: it is
 * the multiplier behind every vial-mode stock number, so a wrong value here
 * corrupts the arithmetic everywhere.
 */
export default function EditVaccineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const run = useAction();
  const { db, bump } = useDb();
  const toast = useToast();

  const { data: vaccine, error, reload } = useQuery(
    (d) => d.first<Vaccine>(`SELECT * FROM vaccines WHERE id = ?`, [id]),
    [id],
  );

  const [name, setName] = useState('');
  const [unitMode, setUnitMode] = useState<UnitMode>('DOSE');
  const [dosesPerVial, setDosesPerVial] = useState(1);
  const [minBalance, setMinBalance] = useState(0);
  const [active, setActive] = useState(true);
  const [price, setPrice] = useState('');

  useEffect(() => {
    if (!vaccine) return;
    setName(vaccine.name);
    setUnitMode(vaccine.unit_mode);
    setDosesPerVial(vaccine.doses_per_vial);
    setMinBalance(vaccine.min_balance_doses);
    setActive(vaccine.is_active === 1);
    setPrice(vaccine.price_rupees == null ? '' : String(vaccine.price_rupees));
  }, [vaccine]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load this vaccine" />;
  if (!vaccine) return <Loading />;

  const parsedPrice = parseRupees(price);

  const save = () => void run('save this vaccine', async () => {
    if (parsedPrice === undefined) return;
    // A single-dose presentation cannot claim more than one dose per vial; the
    // database enforces this too, so keep the UI consistent with it.
    const dpv = unitMode === 'DOSE' ? 1 : Math.max(1, dosesPerVial);
    await db.run(
      `UPDATE vaccines
          SET name = ?, unit_mode = ?, doses_per_vial = ?, min_balance_doses = ?,
              is_active = ?, updated_at = ?
        WHERE id = ?`,
      [name.trim(), unitMode, dpv, minBalance, active ? 1 : 0, Date.now(), id],
    );
    await setVaccinePrice(db, id, parsedPrice);
    bump();
    toast.show(`Saved ${name.trim()}.`);
    router.back();
  });

  /**
   * Removing, with the consequence stated in real numbers.
   *
   * "Are you sure?" is not information. What she needs to know is whether
   * stock is about to stop being counted and how much history the row is
   * carrying - so the dialog says both, and says plainly that nothing is
   * erased. The undo is a toast because the removal is a soft delete: adding
   * it back is a single write, available here or from the Removed list later.
   */
  const confirmRemove = () => void run('check this vaccine', async () => {
    const usage = await vaccineUsage(db, id);
    const lines = [`"${vaccine.name}" will be removed from every list and picker.`];
    if (usage.onHandDoses !== 0) {
      lines.push(
        `\nWARNING: ${usage.onHandDoses} doses are currently in stock. That stock will no longer be counted anywhere.`,
      );
    }
    if (usage.movements > 0) {
      lines.push(
        `\n${usage.dosesGiven} doses given and ${usage.movements} entries stay in your records. Nothing is erased. You can add it back at any time.`,
      );
    } else {
      lines.push('\nIt has never been used, so nothing is lost.');
    }

    Alert.alert(`Remove ${vaccine.name}?`, lines.join(''), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void run(`remove ${vaccine.name}`, async () => {
            await removeVaccine(db, id);
            bump();
            router.back();
            toast.show(`${vaccine.name} removed.`, async () => {
              await run(`add ${vaccine.name} back`, async () => {
                await restoreVaccine(db, id);
                bump();
              });
            });
          }),
      },
    ]);
  });

  return (
    <View style={st.screen}>
      <ScrollView contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl }]}>
        <Field label="Trade name" hint="Exactly as printed on the vial.">
          <Input value={name} onChangeText={setName} autoCapitalize="words" autoCorrect={false} />
        </Field>

        <Field label="How is it counted?">
          <View style={st.chipRow}>
            <Chip accent="catalog" label="Single doses" selected={unitMode === 'DOSE'} onPress={() => setUnitMode('DOSE')} />
            <Chip accent="catalog" label="Multi-dose vials" selected={unitMode === 'VIAL'} onPress={() => setUnitMode('VIAL')} />
          </View>
        </Field>

        {unitMode === 'VIAL' ? (
          <Field label="Doses per vial" hint="Check the box. This multiplies every count.">
            <Stepper accent="catalog" value={dosesPerVial} onChange={setDosesPerVial} min={1} max={50} quickValues={[1, 5, 10, 20]} />
          </Field>
        ) : null}

        <Field label="Safety limit (doses)" hint="Warn me when stock falls to this level or below.">
          <Stepper accent="catalog" value={minBalance} onChange={setMinBalance} min={0} max={200} quickValues={[0, 5, 10, 20]} />
        </Field>

        <Field label="Price per dose (₹)" hint="Optional. Used for the sales value on Trends.">
          <Input value={price} onChangeText={setPrice} keyboardType="number-pad" />
          {parsedPrice === undefined ? <T style={st.error}>Enter the price in whole rupees, like 1250.</T> : null}
        </Field>

        <Field label="Show in the list?" hint="Hiding keeps all history; it never deletes anything.">
          <View style={st.chipRow}>
            <Chip accent="catalog" label="Shown" selected={active} onPress={() => setActive(true)} />
            <Chip accent="catalog" label="Hidden" selected={!active} onPress={() => setActive(false)} />
          </View>
        </Field>

        {/* Well away from SAVE, which keeps the 64dp thumb zone to itself. */}
        <View style={st.removeBlock}>
          <T style={st.removeHint}>
            Removing takes this vaccine out of every list. Everything it has recorded stays in your
            records, and you can add it back at any time.
          </T>
          <SecondaryButton label={`Remove ${vaccine.name}`} danger onPress={confirmRemove} />
        </View>
      </ScrollView>
      <Footer>
        <BigButton accent="catalog" label="Save changes" onPress={save} disabled={!name.trim() || parsedPrice === undefined} />
      </Footer>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { fontSize: type.label, color: color.danger, fontWeight: weight.semibold, lineHeight: 22 },
  removeBlock: { marginTop: space.xxl, gap: space.sm },
  removeHint: { fontSize: type.min, color: color.textMuted, lineHeight: 21 },
});
