import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Empty, ErrorState, Input, Loading, Row, T, useBottomInset } from '../../ui/components';
import { color, space, type } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useQuery } from '../../db/provider';
import { searchPatients } from '../../db/repo/patients';
import { loadSyncConfig } from '../../sync/config';
import { formatAge, todayLocal } from '../../domain/time';

export default function ChildrenScreen() {
  const bottomInset = useBottomInset();
  const [q, setQ] = useState('');
  const today = todayLocal();
  const { data: serverOn } = useQuery(async (db) => (await loadSyncConfig(db)) !== null);
  const { data, loading, error, reload } = useQuery(
    (db) => searchPatients(db, q.trim(), q.trim() ? 100 : 200),
    [q],
  );

  if (error) return <ErrorState error={error} onRetry={reload} what="load the children list" />;
  if (loading && !data) return <Loading />;

  return (
    <View style={st.screen}>
      <View style={{ padding: space.lg }}>
        <Input
          placeholder="Search by name or phone"
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
          autoCapitalize="words"
        />
      </View>
      <FlatList
        data={data ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={[centred, { paddingHorizontal: space.lg, paddingBottom: space.xxl + bottomInset }]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Empty
            title={q ? `No child matches "${q}"` : 'No children saved yet'}
            hint="Children are added while recording a dose."
          />
        }
        renderItem={({ item }) => (
          <Row
            title={item.name}
            subtitle={
              [formatAge(item.dob, today), item.guardian_phone].filter(Boolean).join(' · ') ||
              'No date of birth yet'
            }
          />
        )}
      />
      <T style={[st.note, { paddingBottom: space.lg + bottomInset }]}>
        {serverOn
          ? 'Names are saved on this phone and the clinic server. Keep a screen lock on the phone.'
          : 'Names are only on this phone. Back them up regularly, and keep a screen lock on the phone.'}
      </T>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  note: { fontSize: type.min, color: color.textMuted, padding: space.lg },
});
