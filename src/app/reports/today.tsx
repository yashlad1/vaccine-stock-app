import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { BigButton, Card, Empty, ErrorState, Input, Loading, Row, SecondaryButton, SectionTitle, T, useBottomInset } from '../../ui/components';
import { useAction } from '../../ui/use-action';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { asOfLabel, dosesGiven, dosesGivenTotals, movementStrip } from '../../domain/reports';
import { fillMissingChild } from '../../domain/ledger';
import { formatAge, formatDayLabel, formatTime12h, todayLocal } from '../../domain/time';
import { MovementStrip } from '../../ui/movement-strip';

/** "Vaccines given today, time, count" - the notebook page, arithmetic included. */
export default function TodayScreen() {
  const run = useAction();
  const bottomInset = useBottomInset();
  const { db, bump } = useDb();
  const today = todayLocal();
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const { data: lines, loading, error, reload } = useQuery((d) => dosesGiven(d, today), [today]);
  const { data: totals } = useQuery((d) => dosesGivenTotals(d, today), [today]);
  const { data: strip } = useQuery((d) => movementStrip(d, today), [today]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load today's doses" />;
  if (loading && !lines) return <Loading />;

  const total = (totals ?? []).reduce((n, t) => n + t.doses, 0);

  return (
    <ScrollView style={st.screen} contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}>
      {/* Same order as the Stock tab: when it was measured, then the number. */}
      <T style={st.day}>
        {formatDayLabel()} · {asOfLabel()}
      </T>
      <T style={st.total}>
        {total} {total === 1 ? 'dose' : 'doses'} given
      </T>

      {strip ? <MovementStrip strip={strip} accent={color.dose} label="Stock today" /> : null}

      {totals?.length ? (
        <>
          <SectionTitle>By vaccine</SectionTitle>
          <Card style={st.panel}>
            {totals.map((t, i) => (
              <Row
                key={t.vaccine_id}
                title={t.name}
                right={<T style={st.count}>{t.doses}</T>}
                last={i === totals.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle>Every dose</SectionTitle>
      {lines?.length ? (
        <Card style={st.panel}>
          {lines.map((l, i) => (
            <View key={l.id} style={[st.line, i === lines.length - 1 && { borderBottomWidth: 0 }]}>
              <T style={st.time}>{formatTime12h(l.local_time)}</T>
              <View style={{ flex: 1 }}>
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
                    label="Add the child's name"
                    onPress={() => {
                      setEditing(l.id);
                      setNameDraft('');
                    }}
                  />
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      ) : (
        <Empty title="No doses recorded yet today" hint="Tap a vaccine on the Give dose tab." />
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  day: { fontSize: type.label, color: color.textMuted, fontWeight: weight.semibold },
  total: { fontSize: type.hero, fontWeight: weight.semibold, color: color.text },
  // Rows run edge to edge inside the panel; the panel supplies the side padding.
  panel: { paddingVertical: 0 },
  count: { fontSize: type.title, fontWeight: weight.semibold, color: color.text },
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
  time: { fontSize: type.label, color: color.textMuted, minWidth: 76, fontWeight: weight.semibold, fontVariant: ['tabular-nums'] },
  vaccine: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  meta: { fontSize: type.min, color: color.textMuted, marginTop: 2 },
});
