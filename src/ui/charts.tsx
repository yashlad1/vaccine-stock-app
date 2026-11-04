import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { T } from './components';
import { type Accent, accentSoft, color, space, touch, type, weight } from './tokens';

/**
 * Bar charts out of plain Views, no SVG.
 *
 * react-native-svg is a native dependency: it breaks Expo Go and rotates the
 * OTA fingerprint, the same trade the top tabs and the expiry wheel refused.
 * Bars are rectangles, so a View with a percentage size is the whole chart.
 *
 * Colour never carries a value on its own: every bar has its number written
 * beside it, and a selection is also bold and named in the screen's headline.
 */

/** The tallest column. Its count sits on top, inside the plot. */
const BAR_MAX = 104;
/** Room above the tallest bar for its count at font scale 1.6x. */
const PLOT = BAR_MAX + 46;
/** Thin marks: the 56dp column is the target, not the ink. */
const BAR_THICK = 24;
/** So one dose next to forty is still a visible bar, not a gap. */
const MIN_BAR = 4;

export interface ChartDatum {
  key: string;
  label: string;
  doses: number;
}

/**
 * One column per period, oldest on the left, opened scrolled to the latest.
 * Re-key it when the periods change so it scrolls back to the latest again.
 */
export function ColumnChart({
  data,
  selected,
  onSelect,
  describe,
  accent = 'dose',
}: {
  data: ChartDatum[];
  selected: string;
  onSelect: (key: string) => void;
  accent?: Accent;
  /** Spoken label for a column, e.g. "Week of 13 Oct, 42 doses". */
  describe: (d: ChartDatum) => string;
}) {
  const ref = useRef<ScrollView>(null);
  const opened = useRef(false);
  const max = Math.max(0, ...data.map((d) => d.doses));

  return (
    <ScrollView
      ref={ref}
      horizontal
      // Once only: a later layout pass must not yank her back from an old week.
      onContentSizeChange={() => {
        if (opened.current) return;
        opened.current = true;
        ref.current?.scrollToEnd({ animated: false });
      }}
      contentContainerStyle={st.columns}
    >
      {data.map((d) => {
        const on = d.key === selected;
        const [top, bottom] = d.label.split(' ');
        const h = d.doses ? Math.max(MIN_BAR, Math.round((d.doses / max) * BAR_MAX)) : 0;
        return (
          <Pressable
            key={d.key}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={describe(d)}
            onPress={() => onSelect(d.key)}
            style={({ pressed }) => [
              st.column,
              on ? { backgroundColor: accentSoft[accent] } : pressed ? st.pressed : null,
            ]}
          >
            <View style={st.plot}>
              <T style={[st.count, on && st.bold]}>{d.doses}</T>
              <View
                style={[st.bar, { height: h, backgroundColor: on ? color.more : color.borderControl }]}
              />
            </View>
            <View style={st.axis}>
              <T style={[st.tick, on && st.tickOn]}>{top}</T>
              <T style={[st.tick, on && st.tickOn]}>{bottom}</T>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * A labelled horizontal bar: name and figure on one line, a thin bar under it.
 * `fraction` is the bar's length from 0 to 1; the caller picks what it is a
 * share of. Read-only: it sits at its text height, so a list of them stays one
 * glance.
 */
export function BarRow({
  label,
  value,
  fraction,
  muted,
  accessibilityLabel,
}: {
  label: string;
  value: string;
  fraction: number;
  /** A grey bar: unselected, or "Not recorded" rather than a real group. */
  muted?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <View accessible accessibilityLabel={accessibilityLabel ?? `${label}, ${value}`} style={st.row}>
      <View style={st.rowTop}>
        <T style={st.rowLabel}>{label}</T>
        <T style={st.rowValue}>{value}</T>
      </View>
      <View style={st.track}>
        {fraction > 0 ? (
          <View
            style={[
              st.fill,
              {
                width: `${Math.max(1, Math.round(fraction * 100))}%`,
                minWidth: MIN_BAR,
                backgroundColor: muted ? color.borderControl : color.more,
              },
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  columns: { alignItems: 'stretch' },
  column: {
    minWidth: touch.min,
    minHeight: touch.min,
    paddingHorizontal: space.xs,
    alignItems: 'center',
  },
  pressed: { backgroundColor: color.pressed },
  plot: { height: PLOT, justifyContent: 'flex-end', alignItems: 'center' },
  count: { fontSize: type.label, fontWeight: weight.semibold, color: color.text, marginBottom: space.xs },
  bar: { width: BAR_THICK },
  // One hairline under every column, so the baselines read as one axis.
  axis: {
    alignSelf: 'stretch',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  tick: { fontSize: type.label, color: color.textMuted, fontWeight: weight.semibold },
  tickOn: { color: color.text, fontWeight: weight.bold },
  bold: { fontWeight: weight.bold },

  row: {
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  rowLabel: { flex: 1, fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  rowValue: { fontSize: type.body, fontWeight: weight.bold, color: color.text },
  track: { height: space.sm },
  fill: { height: space.sm },
});
