import { StyleSheet, View } from 'react-native';
import { Chip, Field, Input, Stepper, T } from './components';
import { color, space, type, weight } from './tokens';
import type { UnitMode } from '../domain/types';

/**
 * How a vaccine is counted, its safety limit and its price: the field block
 * that Add and Edit vaccine share. The doses-per-vial quick values differ
 * (a brand-new vaccine has no 1-dose vial), so the screen passes them in.
 */
export function CountingFields({
  unitMode,
  onUnitMode,
  dosesPerVial,
  onDosesPerVial,
  vialQuickValues,
  minBalance,
  onMinBalance,
  price,
  onPrice,
  priceInvalid,
}: {
  unitMode: UnitMode;
  onUnitMode: (m: UnitMode) => void;
  dosesPerVial: number;
  onDosesPerVial: (n: number) => void;
  vialQuickValues: number[];
  minBalance: number;
  onMinBalance: (n: number) => void;
  price: string;
  onPrice: (t: string) => void;
  priceInvalid: boolean;
}) {
  return (
    <>
      <Field label="How is it counted?">
        <View style={st.chipRow}>
          <Chip accent="catalog" label="Single doses" selected={unitMode === 'DOSE'} onPress={() => onUnitMode('DOSE')} />
          <Chip accent="catalog" label="Multi-dose vials" selected={unitMode === 'VIAL'} onPress={() => onUnitMode('VIAL')} />
        </View>
      </Field>

      {unitMode === 'VIAL' ? (
        <Field label="Doses per vial" hint="Check the box. This multiplies every count.">
          <Stepper accent="catalog" value={dosesPerVial} onChange={onDosesPerVial} min={1} max={50} quickValues={vialQuickValues} />
        </Field>
      ) : null}

      <Field label="Safety limit (doses)" hint="Warn me when stock falls to this level or below.">
        <Stepper accent="catalog" value={minBalance} onChange={onMinBalance} min={0} max={200} quickValues={[0, 5, 10, 20]} />
      </Field>

      <Field label="Price per dose (₹)" hint="Optional. Used for the sales value on Trends.">
        <Input value={price} onChangeText={onPrice} keyboardType="number-pad" />
        {priceInvalid ? <T style={st.error}>Enter the price in whole rupees, like 1250.</T> : null}
      </Field>
    </>
  );
}

const st = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { fontSize: type.label, color: color.danger, fontWeight: weight.semibold, lineHeight: 22 },
});
