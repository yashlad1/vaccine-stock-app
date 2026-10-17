import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, BigButton, Card, Chip, ErrorState, Footer, Input, Loading, T, useBottomInset } from '../../ui/components';
import { color, radius, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { searchRank } from '../../domain/search';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { isPrimaryDevice } from '../../sync/adopt';
import { listRemovedVaccines, listVaccines, restoreVaccine } from '../../db/repo/catalog';

/** "Vials of 10 · keep 20 doses" - the two numbers that drive the arithmetic. */
function describeUnit(v: { unit_mode: string; doses_per_vial: number; min_balance_doses: number }) {
  const unit = v.unit_mode === 'VIAL' ? `Vials of ${v.doses_per_vial}` : 'Single doses';
  return `${unit} · keep ${v.min_balance_doses} doses`;
}

/**
 * VACCINES - the list. Tap one to edit it; add a new one from the button.
 *
 * Hiding and removing both live on the edit screen, because they are two
 * different things and the difference is worth a sentence rather than a pair of
 * adjacent buttons:
 *
 *   Hide   - takes it out of the pickers, keeps it one tap from coming back.
 *            The right choice for "we don't stock this at the moment".
 *   Remove - takes it out of the catalog entirely.
 *
 * Even Remove is a soft delete. Every past dose references this row, so a hard
 * DELETE would orphan the ledger and break the history screen and the export.
 * The clinician sees a removal; the record keeps everything that was ever given.
 */
export default function VaccinesScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const { db, bump } = useDb();
  const toast = useToast();
  const run = useAction();
  const [q, setQ] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);

  const { data: active, loading, error, reload } = useQuery((d) => listVaccines(d, false), []);
  const { data: removed } = useQuery((d) => listRemovedVaccines(d), []);
  const { data: primary } = useQuery((d) => isPrimaryDevice(d), []);

  const rows = useMemo(() => {
    const list = showRemoved ? (removed ?? []) : (active ?? []);
    return searchRank(list, q);
  }, [active, removed, showRemoved, q]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load the catalog" />;
  if (loading && !active) return <Loading label="Loading vaccines" />;

  return (
    <View style={st.screen}>
      <FlatList
        data={rows}
        keyExtractor={(v) => v.id}
        contentContainerStyle={[centred, { paddingBottom: 140 + bottomInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={st.headerWrap}>
            <T style={st.total}>
              {(active ?? []).length} {(active ?? []).length === 1 ? 'vaccine' : 'vaccines'}
            </T>

            <Card tone="catalog" style={{ marginTop: space.md }}>
              <T style={st.noteTitle}>Check doses per vial</T>
              <T style={st.noteBody}>
                Pack sizes vary by manufacturer. A wrong number here multiplies into every stock
                count for that vaccine, so check it against your fridge before you rely on it.
              </T>
            </Card>

            <View style={{ marginTop: space.lg, gap: space.md }}>
              <Input
                placeholder="Search vaccine"
                value={q}
                onChangeText={setQ}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <View style={st.chipRow}>
                <Chip
                  accent="catalog"
                  label="In catalog"
                  selected={!showRemoved}
                  onPress={() => setShowRemoved(false)}
                />
                <Chip
                  accent="catalog"
                  label={`Removed (${(removed ?? []).length})`}
                  selected={showRemoved}
                  onPress={() => setShowRemoved(true)}
                />
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={{ padding: space.xl }}>
            <T style={st.emptyText}>
              {showRemoved
                ? 'Nothing has been removed.'
                : q
                  ? `No vaccine matches "${q}".`
                  : 'No vaccines yet. Add your first one below.'}
            </T>
          </View>
        }
        /**
         * ONE tap target per row, not three.
         *
         * A row used to carry edit, Hide and Remove side by side - three 56dp
         * targets and the name, on a 360dp screen, with the destructive one a
         * thumb-width from the reversible one. Hide was redundant anyway: the
         * edit screen has had a Shown/Hidden control the whole time. Remove now
         * lives there too, so reaching it takes a deliberate navigation rather
         * than a mis-aimed tap between patients.
         */
        renderItem={({ item }) =>
          showRemoved ? (
            <View style={st.row}>
              <View style={{ flex: 1 }}>
                <T style={st.rowName}>{item.name}</T>
                <T style={st.rowSub}>{describeUnit(item)}</T>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${item.name} back`}
                onPress={() => void run(`add ${item.name} back`, async () => {
                  await restoreVaccine(db, item.id);
                  bump();
                  toast.show(`${item.name} added back.`);
                })}
                style={({ pressed }) => [st.action, pressed && { opacity: 0.6 }]}
              >
                <T style={[st.actionText, { color: color.catalog }]}>Add back</T>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${item.name}`}
              onPress={() => router.push(`/catalog/${item.id}`)}
              style={({ pressed }) => [st.row, pressed && { backgroundColor: color.catalogSoft }]}
            >
              <View style={{ flex: 1 }}>
                <T style={st.rowName}>{item.name}</T>
                <T style={st.rowSub}>{describeUnit(item)}</T>
              </View>
              {!item.is_active ? <Badge text="HIDDEN" tone="neutral" /> : null}
              <T style={st.chevron}>›</T>
            </Pressable>
          )
        }
      />

      <Footer floating>
        {primary === false ? (
          // Only the device that started the clinic may add vaccines.
          //
          // Two devices adding the same trade name while offline produces two
          // catalog rows for one vaccine, which is precisely the misspelling
          // problem this app exists to eliminate - arriving through the sync
          // layer instead of through handwriting. Adding a vaccine is an admin
          // action performed a few times a year, so confining it to one device
          // costs nothing and removes the hazard.
          <T style={st.notPrimary}>
            New vaccines are added on the main clinic phone, so the list stays the same everywhere.
            Everything else works normally here.
          </T>
        ) : (
          <BigButton
            accent="catalog"
            label="Add a new vaccine"
            sublabel="Trade name, how it is counted, safety limit"
            onPress={() => router.push('/catalog/new')}
          />
        )}
      </Footer>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  headerWrap: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md },
  total: { fontSize: type.hero, fontWeight: weight.bold, color: color.text },
  noteTitle: { fontSize: type.label, fontWeight: weight.bold, color: color.catalog },
  noteBody: { fontSize: type.min, color: color.text, lineHeight: 21, marginTop: space.xs },
  chipRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  emptyText: { fontSize: type.body, color: color.textMuted, textAlign: 'center', lineHeight: 26 },

  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowName: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  rowSub: { fontSize: type.label, color: color.textMuted, marginTop: 2 },
  action: {
    minHeight: 56,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  actionText: { fontSize: type.label, fontWeight: weight.semibold },
  chevron: { fontSize: type.title, color: color.textMuted, marginTop: -2 },
  notPrimary: { fontSize: type.label, color: color.textMuted, lineHeight: 24, textAlign: 'center' },

});
