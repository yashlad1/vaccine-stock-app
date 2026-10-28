import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ErrorState, Input, Loading, Screen, T, useBottomInset } from '../../ui/components';
import { color, radius, space, touch, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useQuery } from '../../db/provider';
import { stockOnHand } from '../../domain/reports';
import { searchRank } from '../../domain/search';
import { describeStockRow } from '../../domain/stock';

/** Pick which vaccine arrived. Same grid idea as Give Dose, reused. */
export default function ReceivePickScreen() {
  const bottomInset = useBottomInset();
  const router = useRouter();
  const [q, setQ] = useState('');
  const { data: rows, loading, error, reload } = useQuery((db) => stockOnHand(db, { activeOnly: true }), []);

  const filtered = useMemo(() => {
    return searchRank(rows ?? [], q);
  }, [rows, q]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load your vaccines" />;
  if (loading && !rows) return <Loading />;

  return (
    <Screen>
      <View style={{ padding: space.lg }}>
        <T style={st.hint}>Which vaccine arrived?</T>
        <Input placeholder="Search vaccine" value={q} onChangeText={setQ} autoCorrect={false} autoCapitalize="none" />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.vaccine_id}
        contentContainerStyle={[centred, { paddingHorizontal: space.lg, paddingBottom: space.xxl + bottomInset }]}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const d = describeStockRow(item);
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace(`/receive/${item.vaccine_id}`)}
              style={({ pressed }) => [st.row, pressed && { backgroundColor: color.stockSoft }]}
            >
              <View style={{ flex: 1 }}>
                <T style={st.name}>{item.name}</T>
                <T style={st.sub}>
                  {d.primary}
                </T>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  hint: { fontSize: type.title, fontWeight: weight.semibold, color: color.text, marginBottom: space.md },
  row: {
    minHeight: touch.min + 8,
    justifyContent: 'center',
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    borderRadius: radius.sm,
  },
  name: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  sub: { fontSize: type.label, color: color.textMuted, marginTop: 2 },
});
