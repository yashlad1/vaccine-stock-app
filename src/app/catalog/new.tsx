import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { BigButton, Field, Footer, Input, KeyboardSafe, T } from '../../ui/components';
import { CountingFields } from '../../ui/vaccine-fields';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { insertVaccine, setVaccinePrice } from '../../db/repo/catalog';
import { parseRupees } from '../../domain/money';
import type { UnitMode } from '../../domain/types';

/**
 * Add a vaccine to the catalog.
 *
 * Reachable ONLY from the Vaccines tab - never from a dose or stock entry
 * screen. If an entry screen could create a catalog row we would have
 * re-invented free-text vaccine names, which is the misspelling problem this
 * app exists to eliminate.
 */
export default function NewVaccineScreen() {
  const router = useRouter();
  const { db, deviceId, bump } = useDb();
  const toast = useToast();

  const [name, setName] = useState('');
  const [generic, setGeneric] = useState('');
  const [unitMode, setUnitMode] = useState<UnitMode>('DOSE');
  const [dosesPerVial, setDosesPerVial] = useState(10);
  const [minBalance, setMinBalance] = useState(5);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const parsedPrice = parseRupees(price);

  const save = async () => {
    setError(null);
    if (parsedPrice === undefined) return;
    try {
      const id = await insertVaccine(
        db,
        {
          name: name.trim(),
          generic_name: generic.trim() || undefined,
          unit_mode: unitMode,
          doses_per_vial: unitMode === 'DOSE' ? 1 : dosesPerVial,
          min_balance_doses: minBalance,
        },
        deviceId,
      );
      if (parsedPrice !== null) await setVaccinePrice(db, id, parsedPrice);
      bump();
      toast.show(`${name.trim()} added.`);
      router.back();
    } catch (e) {
      // The unique index is what makes duplicates impossible; say so plainly
      // rather than showing a raw constraint error.
      setError(
        String(e).includes('UNIQUE')
          ? `"${name.trim()}" is already in the catalog. Search for it on the Vaccines tab.`
          : 'Could not add this vaccine. Please check the details and try again.',
      );
    }
  };

  return (
    <KeyboardSafe>
      <ScrollView
        contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="Trade name" hint="Exactly as printed on the vial, e.g. Pentavac PFS.">
          <Input
            value={name}
            onChangeText={setName}
            placeholder="Trade name"
            autoCapitalize="words"
            autoCorrect={false}
            autoFocus
          />
        </Field>

        <Field label="Also known as" hint="Optional. Helps you find it when searching.">
          <Input
            value={generic}
            onChangeText={setGeneric}
            placeholder="e.g. DTwP-HepB-Hib"
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </Field>

        <CountingFields
          unitMode={unitMode}
          onUnitMode={setUnitMode}
          dosesPerVial={dosesPerVial}
          onDosesPerVial={setDosesPerVial}
          vialQuickValues={[5, 10, 20]}
          minBalance={minBalance}
          onMinBalance={setMinBalance}
          price={price}
          onPrice={setPrice}
          priceInvalid={parsedPrice === undefined}
        />

        {error ? <T style={st.error}>{error}</T> : null}
      </ScrollView>

      <Footer>
        <BigButton
          accent="catalog"
          label="Add vaccine"
          onPress={save}
          disabled={!name.trim() || parsedPrice === undefined}
          sublabel={name.trim() ? undefined : 'Enter the trade name first'}
        />
      </Footer>
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  error: { fontSize: type.label, color: color.danger, fontWeight: weight.semibold, lineHeight: 22 },
});
