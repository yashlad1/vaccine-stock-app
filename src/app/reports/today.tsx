import React, { useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { BigButton, Empty, ErrorState, Input, Loading, Row, SecondaryButton, T, useBottomInset } from '../../ui/components';
import { useAction } from '../../ui/use-action';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { asOfLabel, dosesGiven, dosesGivenTotals, missingChildEntries, movementStrip } from '../../domain/reports';
import { fillMissingChild } from '../../domain/ledger';
import { formatAge, formatDate, formatDayLabel, formatTime12h, todayLocal } from '../../domain/time';
import { MovementStrip } from '../../ui/movement-strip';

/** "Vaccines given today, time, count" - the notebook page, arithmetic included. */
export default function TodayScreen() {
  const run = useAction();
  const bottomInset = useBottomInset();
  const { db, bump } = useDb();
  const today = todayLocal();
  const missingMode = useLocalSearchParams<{ missing?: string }>().missing === '1';
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const { data: lines, loading, error, reload } = useQuery(
    (d) => (missingMode ? missingChildEntries(d, 100) : dosesGiven(d, today)),
    [today, missingMode],
  );
  const { data: totals } = useQuery((d) => dosesGivenTotals(d, today), [today]);
  const { data: strip } = useQuery((d) => movementStrip(d, today, undefined, false), [today]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load today's doses" />;
  if (loading && !lines) return <Loading />;

  const total = (totals ?? []).reduce((n, t) => n + t.doses, 0);

  return (
    <ScrollView style={st.screen} contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}>
      <Stack.Screen options={{ title: missingMode ? 'Missing child names' : 'Given today' }} />
      {missingMode ? (
        <T style={st.total}>Doses with no name</T>
      ) : (
        <>
          {/* Same order as the Stock tab: when it was measured, then the number. */}
          <T style={st.day}>
            {formatDayLabel()} · {asOfLabel()}
          </T>
          <T style={st.total}>
            {total} {total === 1 ? 'dose' : 'doses'} given
          </T>
        </>
      )}

      {!missingMode && strip ? <MovementStrip strip={strip} accent={color.dose} label="Stock today" /> : null}

      {!missingMode && totals?.length ? (
        <>
          <T style={st.section}>By vaccine</T>
          {totals.map((t) => (
            <Row key={t.vaccine_id} title={t.name} right={<T style={st.count}>{t.doses}</T>} />
          ))}
        </>
      ) : null}

      <T style={st.section}>{missingMode ? 'Add a name to each' : 'Every dose'}</T>
      {lines?.length ? (
        lines.map((l) => (
          <View key={l.id} style={[st.line, missingMode ? st.lineStacked : null]}>
            {/* Missing-names rows carry a date too; stacked above the row it cannot squeeze it at 1.6x. */}
            {missingMode ? (
              <T style={st.time}>
                {`${formatDate(new Date(`${l.local_date}T00:00:00`).getTime())}, ${formatTime12h(l.local_time)}`}
              </T>
            ) : (
              <T style={st.time}>{formatTime12h(l.local_time)}</T>
            )}
            <View style={missingMode ? undefined : { flex: 1 }}>
              <T style={st.vaccine}>
                {l.vaccine_name}
                {l.doses > 1 ? ` × ${l.doses}` : ''}
              </T>
              {/* Only what is actually known. Joining present parts avoids
                  both "no name recorded" and a leading "· batch ..." . The
                  age is the child's age ON THIS DOSE, from the date of birth. */}
              {(() => {
                const parts = [
                  l.patient_label,
                  formatAge(l.dob, l.local_date),
                  l.note,
                  l.lot_number ? `batch ${l.lot_number}` : null,
                ].filter(Boolean);
                return parts.length ? <T style={st.meta}>{parts.join(' · ')}</T> : null;
              })()}
              {editing === l.id ? (
                <View style={{ gap: space.sm, marginTop: space.sm }}>
                  <Input
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    placeholder="Child's name"
                    autoCapitalize="words"
                    autoCorrect={false}
                    autoFocus
                  />
                  <BigButton
                    accent="more"
                    label="Save name"
                    onPress={() => void run("save this child's name", async () => {
                      await fillMissingChild(db, { movementId: l.id, patientLabel: nameDraft.trim() });
                      bump();
                      setEditing(null);
                      setNameDraft('');
                    })}
                    disabled={!nameDraft.trim()}
                  />
                </View>
              ) : l.needs_detail ? (
                <SecondaryButton
                  accent="more"
                  label="Add the child's name"
                  onPress={() => {
                    setEditing(l.id);
                    setNameDraft('');
                  }}
                />
              ) : null}
            </View>
          </View>
        ))
      ) : (
        missingMode ? (
          <Empty title="Every dose has a name" />
        ) : (
          <Empty title="No doses recorded yet today" hint="Tap a vaccine on the Give dose tab." />
        )
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  day: { fontSize: type.label, color: color.textMuted, fontWeight: weight.semibold },
  total: { fontSize: type.hero, fontWeight: weight.bold, color: color.text },
  section: { fontSize: type.label, fontWeight: weight.bold, color: color.text, marginTop: space.xl, marginBottom: space.sm },
  count: { fontSize: type.title, fontWeight: weight.bold, color: color.text },
  line: {
    flexDirection: 'row',
    // Without this the children stretch to the row height; a pill-radius
    // badge then rendered as a full-height grey oval.
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  lineStacked: { flexDirection: 'column', alignItems: 'stretch', gap: space.xs },
  time: { fontSize: type.label, color: color.textMuted, minWidth: 76, fontWeight: weight.semibold },
  vaccine: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  meta: { fontSize: type.min, color: color.textMuted, marginTop: 2 },
});
