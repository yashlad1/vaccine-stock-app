import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, T } from './components';
import { color, space, type, weight } from './tokens';
import type { MovementStrip as Strip } from '../domain/reports';

/**
 * The self-checking movement equation from CLAUDE.md section 9:
 *
 *   Opening 162 · +Received 20 · −Given 7 · −Wasted 0 · = 175 now
 *
 * Two things this component exists to hold in one place.
 *
 * ONE: the figures section 9 calls the point of the report must not be the
 * smallest, faintest type on the screen. Numbers that matter are 22-28pt bold
 * by rule, and an equation is read term by term, so each term gets its own
 * labelled column and the row wraps instead of reflowing mid-sum.
 *
 * TWO: every term is rendered, including `adjusted` and `corrections`. `now`
 * is read straight off the ledger rather than accumulated from the parts, so
 * dropping a term does not change the total - it just makes the visible sum
 * stop adding up, which is the one thing a self-checking strip may never do.
 */
export function MovementStrip({
  strip,
  accent = color.stock,
  label = 'Today',
}: {
  strip: Strip;
  /** The screen's own accent, so the total belongs to the screen it sits on. */
  accent?: string;
  label?: string;
}) {
  return (
    <Card tone="soft" style={{ marginTop: space.md }}>
      <T style={st.label}>{label}</T>
      <View style={st.row}>
        <Term label="Opening" value={strip.opening} />
        <Term label="+ Received" value={strip.received} />
        <Term label="− Given" value={strip.given} />
        <Term label="− Wasted" value={strip.wasted} />
        {strip.adjusted !== 0 ? <Term label="Adjusted" value={strip.adjusted} signed /> : null}
        {strip.corrections !== 0 ? (
          <Term label="Corrections" value={strip.corrections} signed />
        ) : null}
        <Term label="= Now" value={strip.now} colour={accent} />
      </View>
    </Card>
  );
}

/** One term of the equation: a label, then the figure under it. */
function Term({
  label,
  value,
  signed,
  colour,
}: {
  label: string;
  value: number;
  signed?: boolean;
  colour?: string;
}) {
  return (
    <View>
      <T style={st.termLabel}>{label}</T>
      <T style={[st.termValue, colour ? { fontSize: type.big, color: colour } : null]}>
        {signed && value > 0 ? '+' : ''}
        {value}
      </T>
    </View>
  );
}

const st = StyleSheet.create({
  label: { fontSize: type.label, fontWeight: weight.semibold, color: color.text, marginBottom: space.xs },
  // columnGap carries the separation the `·` used to, so no glyph has to.
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: space.md,
    columnGap: space.xl,
    marginTop: space.sm,
  },
  termLabel: { fontSize: type.min, color: color.textMuted, fontWeight: weight.semibold },
  termValue: { fontSize: type.title, fontWeight: weight.semibold, color: color.text, fontVariant: ['tabular-nums'] },
});
