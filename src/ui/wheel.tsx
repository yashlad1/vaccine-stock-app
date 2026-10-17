import React, { useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent, type NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, View,
} from 'react-native';
import { T } from './components';
import { type Accent, accentColor, color, radius, space, touch, type, weight } from './tokens';
import { MONTHS, dateFromParts, expiryFromMonth, formatAge } from '../domain/time';

/**
 * A scrolling wheel picker - the familiar month/year carousel.
 *
 * Hand-written on purpose, for the same reason as `top-tabs.tsx`: the obvious
 * alternative (`@react-native-picker/picker`) is a native dependency, and a
 * native dependency cannot be tested in Expo Go and rotates the OTA
 * fingerprint. A wheel is two ScrollViews with snapping.
 *
 * Two details that are correctness, not polish:
 *
 * 1. The FIRST item on each wheel is "-", meaning not set. A wheel always
 *    displays something under the selection band, so a wheel that started on a
 *    real month would silently claim an expiry the clinician never entered.
 *    Expiry is optional, and inventing one is worse than omitting it.
 * 2. Rows are `touch.min` tall and individually tappable, so the control still
 *    works for someone who finds flick-scrolling fiddly.
 */

const ITEM = touch.min;
const VISIBLE = 3;
const HEIGHT = ITEM * VISIBLE;

type Item = { value: number | null; label: string };

function Wheel({
  items, value, onChange, accent, label,
}: {
  items: Item[];
  value: number | null;
  onChange: (v: number | null) => void;
  accent: Accent;
  label: string;
}) {
  const ref = useRef<ScrollView>(null);
  const didInit = useRef(false);
  const index = Math.max(0, items.findIndex((i) => i.value === value));

  // Round rather than floor: snapToInterval lands on the nearest row, so the
  // rounded index is where the wheel has actually come to rest.
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(items.length - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.y / ITEM)));
    if (items[i].value !== value) onChange(items[i].value);
  };

  const tap = (i: number) => {
    ref.current?.scrollTo({ y: i * ITEM, animated: true });
    onChange(items[i].value);
  };

  return (
    <View style={st.col}>
      <T style={st.colLabel}>{label}</T>
      <View style={st.viewport}>
        <View
          pointerEvents="none"
          style={[st.band, { borderColor: accentColor[accent] }]}
        />
        <ScrollView
          ref={ref}
          showsVerticalScrollIndicator={false}
          snapToInterval={ITEM}
          disableIntervalMomentum
          decelerationRate="fast"
          nestedScrollEnabled
          contentContainerStyle={{ paddingVertical: ITEM }}
          // contentOffset is iOS-only, so position it once the rows exist.
          onContentSizeChange={() => {
            if (didInit.current) return;
            didInit.current = true;
            if (index > 0) ref.current?.scrollTo({ y: index * ITEM, animated: false });
          }}
          onMomentumScrollEnd={settle}
          onScrollEndDrag={settle}
        >
          {items.map((it, i) => {
            const on = it.value === value;
            return (
              <Pressable
                key={it.label}
                onPress={() => tap(i)}
                style={st.item}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${label}: ${it.value === null ? 'not set' : it.label}`}
              >
                <T
                  style={[
                    st.itemText,
                    on && { color: accentColor[accent], fontWeight: weight.semibold },
                  ]}
                >
                  {it.label}
                </T>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

export function MonthYearWheel({
  month, year, onMonth, onYear, accent = 'stock',
}: {
  month: number | null;
  year: number | null;
  onMonth: (m: number | null) => void;
  onYear: (y: number | null) => void;
  accent?: Accent;
}) {
  const monthItems = useMemo<Item[]>(
    () => [{ value: null, label: '—' }, ...MONTHS.map((m, i) => ({ value: i + 1, label: m }))],
    [],
  );
  const yearItems = useMemo<Item[]>(() => {
    const y0 = new Date().getFullYear();
    // One year back, because stock already on the shelf can be short-dated,
    // and eight forward, which covers every paediatric vaccine shelf life.
    return [
      { value: null, label: '—' },
      ...Array.from({ length: 10 }, (_, k) => y0 - 1 + k).map((y) => ({ value: y, label: String(y) })),
    ];
  }, []);

  const both = month !== null && year !== null;
  const partial = (month === null) !== (year === null);

  return (
    <View>
      <View style={st.row}>
        <Wheel items={monthItems} value={month} onChange={onMonth} accent={accent} label="Month" />
        <Wheel items={yearItems} value={year} onChange={onYear} accent={accent} label="Year" />
      </View>
      {both ? (
        // Vials print MM/YYYY and are usable THROUGH that month. Spelling out
        // the last usable day is what stops a lot being written off 30 days
        // early - the exact mistake domain/time.ts exists to prevent.
        <T style={[st.note, { color: accentColor[accent] }]}>
          Usable through {lastDayLabel(year!, month!)}
        </T>
      ) : partial ? (
        <T style={st.warn}>Pick both a month and a year, or leave both blank.</T>
      ) : (
        <T style={st.note}>No expiry recorded. You can add it later.</T>
      )}
    </View>
  );
}

/**
 * Date of birth as day, month and year. The same "not set" first row as the
 * expiry wheel, for the same reason: it is optional, and a wheel that started
 * on a real date would claim a birthday nobody entered. Newest year first,
 * because most of this clinic's children are under one.
 *
 * It reports a date only when all three make a real one that is not in the
 * future; the line beneath says which of those is wrong, and shows the age
 * once the date is good - the check she can make against the parent's answer.
 */
export function DateOfBirthWheel({
  today, initial, onChange, accent = 'dose',
}: {
  /** Local 'YYYY-MM-DD'. */
  today: string;
  initial?: string | null;
  onChange: (dob: string | null) => void;
  accent?: Accent;
}) {
  const items = useMemo(() => {
    const thisYear = Number(today.slice(0, 4));
    const none = { value: null, label: '—' };
    return {
      day: [none, ...Array.from({ length: 31 }, (_, k) => ({ value: k + 1, label: String(k + 1) }))],
      month: [none, ...MONTHS.map((m, i) => ({ value: i + 1, label: m }))],
      year: [none, ...Array.from({ length: 19 }, (_, k) => ({ value: thisYear - k, label: String(thisYear - k) }))],
    };
  }, [today]);

  // Prefill a part only if its wheel can show it. A stored date older than
  // the year wheel, or a malformed one, would otherwise sit hidden behind a
  // "-" band while the line beneath reported an age for it.
  const [y0, m0, d0] = (initial ?? '').split('-').map(Number);
  const shows = (list: Item[], v: number) => (list.some((i) => i.value === v) ? v : null);
  const [day, setDay] = useState<number | null>(() => shows(items.day, d0));
  const [month, setMonth] = useState<number | null>(() => shows(items.month, m0));
  const [year, setYear] = useState<number | null>(() => shows(items.year, y0));

  const set = (d: number | null, m: number | null, y: number | null) => {
    setDay(d);
    setMonth(m);
    setYear(y);
    const dob = d && m && y ? dateFromParts(y, m, d) : null;
    onChange(dob && dob <= today ? dob : null);
  };

  const all = day !== null && month !== null && year !== null;
  const none = day === null && month === null && year === null;
  const dob = all ? dateFromParts(year!, month!, day!) : null;

  return (
    <View>
      <View style={st.row}>
        <Wheel items={items.day} value={day} onChange={(d) => set(d, month, year)} accent={accent} label="Day" />
        <Wheel items={items.month} value={month} onChange={(m) => set(day, m, year)} accent={accent} label="Month" />
        <Wheel items={items.year} value={year} onChange={(y) => set(day, month, y)} accent={accent} label="Year" />
      </View>
      {none ? (
        <T style={st.note}>No date of birth yet. You can add it at the next visit.</T>
      ) : !all ? (
        <T style={st.warn}>Pick a day, a month and a year, or leave all three blank.</T>
      ) : !dob ? (
        <T style={st.warn}>That date does not exist. Check the day.</T>
      ) : dob > today ? (
        <T style={st.warn}>That date is in the future. Check the year.</T>
      ) : (
        <T style={[st.note, { color: accentColor[accent] }]}>Age today: {formatAge(dob, today)}</T>
      )}
    </View>
  );
}

function lastDayLabel(year: number, month: number): string {
  const [, m, d] = expiryFromMonth(year, month).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${year}`;
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  col: { flex: 1 },
  colLabel: { fontSize: type.min, fontWeight: weight.semibold, color: color.textMuted, marginBottom: space.xs },
  viewport: {
    height: HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: ITEM,
    height: ITEM,
    borderTopWidth: 2,
    borderBottomWidth: 2,
  },
  item: { height: ITEM, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: type.title, color: color.textMuted },
  note: { fontSize: type.min, color: color.textMuted, marginTop: space.sm, fontWeight: weight.semibold },
  warn: { fontSize: type.min, color: color.low, marginTop: space.sm, fontWeight: weight.semibold },
});
