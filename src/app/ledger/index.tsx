import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Badge, Empty, ErrorState, Loading, SecondaryButton, T, useBottomInset } from '../../ui/components';
import { useAction } from '../../ui/use-action';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { newId } from '../../domain/ids';
import { reverseMovement } from '../../domain/ledger';
import { formatAge, formatDate, formatTime12h } from '../../domain/time';

interface LedgerLine {
  id: string;
  local_date: string;
  local_time: string;
  movement_type: string;
  delta_doses: number;
  vaccine_name: string;
  lot_number: string | null;
  patient_label: string | null;
  dob: string | null;
  note: string | null;
  reverses_id: string | null;
  is_reversed: number;
}

/**
 * The full audit trail, corrections included.
 *
 * Because undo writes a reversing entry rather than deleting, a correction
 * remains possible here forever - the 8-second snackbar is only the fast path.
 */
export default function LedgerScreen() {
  const run = useAction();
  const bottomInset = useBottomInset();
  const { db, deviceId, bump } = useDb();

  const { data, loading, error, reload } = useQuery((d) =>
    d.all<LedgerLine>(
      `SELECT m.id, m.local_date, m.local_time, m.movement_type, m.delta_doses,
              v.name AS vaccine_name, l.lot_number, m.patient_label, p.dob,
              m.note, m.reverses_id,
              EXISTS(SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) AS is_reversed
         FROM stock_movements m
         JOIN vaccines v ON v.id = m.vaccine_id
         LEFT JOIN lots l ON l.id = m.lot_id
         LEFT JOIN patients p ON p.id = m.patient_id
        ORDER BY m.recorded_at DESC
        LIMIT 500`,
    ),
  );

  if (error) return <ErrorState error={error} onRetry={reload} what="load your entries" />;
  if (loading && !data) return <Loading />;
  if (!data?.length) return <Empty title="No entries yet" />;

  const label: Record<string, string> = {
    OPENING_BALANCE: 'Opening balance',
    RECEIPT: 'Received',
    ADMINISTRATION: 'Given',
    WASTAGE: 'Wasted',
    ADJUSTMENT: 'Stock adjustment',
    REVERSAL: 'Correction',
  };

  return (
    <FlatList
      style={st.screen}
      data={data}
      keyExtractor={(m) => m.id}
      contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}
      renderItem={({ item }) => {
        const undone = item.is_reversed === 1;
        return (
          <View style={[st.row, undone && st.rowUndone]}>
            <View style={{ flex: 1 }}>
              <T style={st.title}>
                {label[item.movement_type] ?? item.movement_type} · {item.vaccine_name}
              </T>
              <T style={st.meta}>
                {formatDate(new Date(`${item.local_date}T00:00:00`).getTime())},{' '}
                {formatTime12h(item.local_time)}
                {item.lot_number ? ` · batch ${item.lot_number}` : ''}
                {item.patient_label ? ` · ${item.patient_label}` : ''}
                {item.movement_type === 'ADMINISTRATION' && formatAge(item.dob, item.local_date)
                  ? ` · ${formatAge(item.dob, item.local_date)}`
                  : ''}
              </T>
              {!undone && item.movement_type !== 'REVERSAL' ? (
                <SecondaryButton
                  label="Correct this entry"
                  onPress={() =>
                    void run('correct this entry', async () => {
                      await reverseMovement(db, { deviceId }, { clientActionId: newId(), movementId: item.id });
                      bump();
                    })
                  }
                />
              ) : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: space.xs }}>
              <T style={[st.delta, { color: item.delta_doses > 0 ? color.ok : color.danger }]}>
                {item.delta_doses > 0 ? '+' : ''}
                {item.delta_doses}
              </T>
              {undone ? <Badge text="CORRECTED" tone="neutral" /> : null}
              {item.reverses_id ? <Badge text="CORRECTION" tone="low" /> : null}
            </View>
          </View>
        );
      }}
    />
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  rowUndone: { opacity: 0.6 },
  title: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  meta: { fontSize: type.min, color: color.textMuted, marginTop: 2 },
  delta: { fontSize: type.title, fontWeight: weight.bold },
});
