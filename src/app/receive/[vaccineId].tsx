import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BigButton, Chip, ErrorState, Field, Footer, Input, KeyboardSafe, Loading, Stepper, T } from '../../ui/components';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { newId } from '../../domain/ids';
import { recordReceipt, reverseMovement } from '../../domain/ledger';
import { findOrCreateLot } from '../../db/repo/lots';
import { describeStock, dosesFromVials } from '../../domain/stock';
import { lastsLabel, loadLedger, usageRate } from '../../domain/supply';
import { MonthYearWheel } from '../../ui/wheel';
import { expiryFromMonth, todayLocal } from '../../domain/time';
import type { FundingSource, StockRow } from '../../domain/types';

const dosesText = (n: number) => `${n} ${n === 1 ? 'dose' : 'doses'}`;

/**
 * Log a delivery. This is where the expensive keystrokes live - once per box,
 * at a desk - which is precisely why lot capture belongs here and not at the
 * point of care with a crying infant.
 */
export default function ReceiveScreen() {
  const { vaccineId } = useLocalSearchParams<{ vaccineId: string }>();
  const router = useRouter();
  const run = useAction();
  const { db, deviceId, bump } = useDb();
  const toast = useToast();

  const [qty, setQty] = useState(1);
  const [lotNumber, setLotNumber] = useState('');
  const [expMonth, setExpMonth] = useState<number | null>(null);
  const [expYear, setExpYear] = useState<number | null>(null);
  const [funding, setFunding] = useState<FundingSource>('PRIVATE');
  const [saving, setSaving] = useState(false);

  const { data: vaccine, error, reload } = useQuery(
    (d) => d.first<StockRow>(`SELECT * FROM v_stock_on_hand WHERE vaccine_id = ?`, [vaccineId]),
    [vaccineId],
  );

  const { data: lasts } = useQuery(
    async (d) => lastsLabel(vaccine?.on_hand_doses ?? 0, usageRate(await loadLedger(d), vaccineId, todayLocal())),
    [vaccineId, vaccine?.on_hand_doses],
  );

  if (error) return <ErrorState error={error} onRetry={reload} what="load this vaccine" />;
  if (!vaccine) return <Loading />;

  const byVial = vaccine.unit_mode === 'VIAL' && vaccine.doses_per_vial > 1;
  // The app multiplies. She never does.
  const doses = byVial ? dosesFromVials(vaccine.doses_per_vial, qty) : qty;
  const after = describeStock(
    vaccine.on_hand_doses + doses,
    vaccine.unit_mode,
    vaccine.doses_per_vial,
    vaccine.min_balance_doses,
  );

  const save = async () => {
    if (saving || !lotNumber.trim()) return;
    setSaving(true);
    const ok = await run('add this delivery to stock', async () => {
      const lotId = await findOrCreateLot(
        db,
        {
          vaccineId,
          lotNumber: lotNumber.trim().toUpperCase(),
          // Stored as the LAST day of the printed month; see domain/time.ts.
          expiryDate: expMonth && expYear ? expiryFromMonth(expYear, expMonth) : null,
          fundingSource: funding,
        },
        deviceId,
      );
      const { movement } = await recordReceipt(db, { deviceId }, {
        clientActionId: newId(),
        vaccineId,
        lotId,
        doses,
      });
      bump();
      toast.show(`Added ${doses} ${doses === 1 ? 'dose' : 'doses'} of ${vaccine.name}.`, async () => {
        await run('undo that delivery', async () => {
          await reverseMovement(db, { deviceId }, { clientActionId: newId(), movementId: movement.id });
          bump();
        });
      });
    });
    setSaving(false);
    if (ok) router.back();
  };

  return (
    <KeyboardSafe>
      <ScrollView contentContainerStyle={[st.content, centred]} keyboardShouldPersistTaps="handled">
        <T style={st.name}>{vaccine.name}</T>
        <T style={st.sub}>
          {byVial ? `Counted in vials of ${vaccine.doses_per_vial} doses` : 'Counted in single doses'}
        </T>

        <Field label="Batch / lot number" hint="As printed on the box.">
          <Input
            value={lotNumber}
            onChangeText={setLotNumber}
            placeholder="e.g. AB1234"
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Batch or lot number"
          />
        </Field>

        <Field label="Expiry" hint="Month and year, as printed on the vial.">
          <MonthYearWheel
            accent="stock"
            month={expMonth}
            year={expYear}
            onMonth={setExpMonth}
            onYear={setExpYear}
          />
        </Field>

        <Field label="Where it came from">
          <View style={st.chipRow}>
            <Chip accent="stock" label="Bought" selected={funding === 'PRIVATE'} onPress={() => setFunding('PRIVATE')} />
            <Chip
              accent="stock"
              label="Government (free)"
              selected={funding === 'GOVT_UIP'}
              onPress={() => setFunding('GOVT_UIP')}
            />
          </View>
        </Field>

        <Field label={byVial ? 'How many vials?' : 'How many doses?'}>
          <Stepper accent="stock" value={qty} onChange={setQty} min={1} max={500} quickValues={[1, 5, 10, 20, 50]} />
        </Field>

        <T style={st.fact}>In stock now: {describeStock(vaccine.on_hand_doses, vaccine.unit_mode, vaccine.doses_per_vial, vaccine.min_balance_doses).primary}</T>
        <T style={st.fact}>Safety limit: {dosesText(vaccine.min_balance_doses)}</T>
        {lasts ? <T style={st.fact}>{lasts}</T> : null}
        <T style={st.after}>After adding: {after.primary}</T>
      </ScrollView>

      <Footer>
        <BigButton
          accent="stock"
          label="Add to stock"
          sublabel={lotNumber.trim() ? undefined : 'Enter the batch number first'}
          onPress={save}
          disabled={saving || !lotNumber.trim()}
        />
      </Footer>
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxl },
  name: { fontSize: type.big, fontWeight: weight.bold, color: color.text },
  sub: { fontSize: type.label, color: color.textMuted, marginTop: space.xs, marginBottom: space.xl },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  fact: { fontSize: type.label, color: color.textMuted, marginBottom: space.xs },
  after: { fontSize: type.body, fontWeight: weight.semibold, color: color.stock },
});
