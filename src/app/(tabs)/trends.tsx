import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Card, Chip, ErrorState, Loading, Row, SecondaryButton, SectionTitle, T, useBottomInset } from '../../ui/components';
import { BarRow, ColumnChart } from '../../ui/charts';
import { MovementStrip } from '../../ui/movement-strip';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useQuery } from '../../db/provider';
import { asOfLabel, periodStrip, type MovementStrip as Strip } from '../../domain/reports';
import { type Ledger, loadLedger, stockOuts } from '../../domain/supply';
import { formatRupees } from '../../domain/money';
import { todayLocal } from '../../domain/time';
import {
  NOT_RECORDED_KEY, PERCENT_FROM, PERIODS, type Grain, type Tally, compareWithPrevious,
  comparisonLabel, dosesSince, percent, periodEnd, periodLabel, periodStart, recentPeriods, series,
  summarise, type Summary, vaccineKey, windowStart,
} from '../../domain/insights';

type Pane = 'vaccines' | 'children' | 'stock';

/** Rows before "Show all", as on Add stock. */
const CAP = 10;

/** "Week of 13 Oct" or "Oct 2026": the eyebrow and the chart's spoken labels. */
const heading = (period: string, grain: Grain) =>
  grain === 'week' ? `Week of ${periodLabel(period, grain)}` : periodLabel(period, grain);
/** The same, mid-sentence: "the week of 13 Oct" or "Oct 2026". */
const inPeriod = (period: string, grain: Grain) =>
  grain === 'week' ? `the week of ${periodLabel(period, grain)}` : periodLabel(period, grain);
const doses = (n: number) => `${n} ${n === 1 ? 'dose' : 'doses'}`;
const these = (n: number) => (n === 1 ? 'this dose' : `these ${n} doses`);

/** The top CAP, plus the selected one when it sits below the cut. */
function capped<R extends { key: string }>(list: R[], all: boolean, keep?: string): R[] {
  if (all || list.length <= CAP) return list;
  const extra = list.slice(CAP).find((v) => v.key === keep);
  return extra ? [...list.slice(0, CAP), extra] : list.slice(0, CAP);
}

/**
 * Trends: which vaccines go out most, to which children, and what the stock
 * did, week by week or month by month. Read-only; nothing here writes.
 *
 * One view at a time under the chart. Seven stacked sections made her scroll
 * past the stock to find the ages, and back again.
 */
export default function TrendsScreen() {
  const bottomInset = useBottomInset();
  const today = todayLocal();
  const [grain, setGrain] = useState<Grain>('week');
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<Pane>('vaccines');
  const [vaccine, setVaccine] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bySales, setBySales] = useState(false);
  const [allRows, setAllRows] = useState(false);

  // Doses load once for the whole window, so every tap is arithmetic in render.
  const from = windowStart(today);
  const { data, loading, error, reload } = useQuery((d) => dosesSince(d, from), [from]);
  const { data: ledger } = useQuery((d) => loadLedger(d));

  const rows = data ?? [];
  const periods = recentPeriods(today, grain, PERIODS);
  const period = picked && periods.includes(picked) ? picked : periods[periods.length - 1];
  const end = periodEnd(period, grain);
  const open = today <= end;
  const all = summarise(rows, { grain, period });
  // A later undo can empty the chosen vaccine's period; fall back quietly then.
  const chosen = all.byVaccine.find((v) => v.key === vaccine);

  // The strip is per catalog row: the one on her list now, else the removed
  // one whose name this is.
  const stripId = chosen
    ? ([...(ledger?.names ?? [])].find(([, n]) => vaccineKey(n) === chosen.key)?.[0] ??
      rows.find((r) => vaccineKey(r.vaccine_name) === chosen.key)?.vaccine_id)
    : undefined;
  // It reads the raw ledger, so it is its own query. Keyed, so a result for
  // the last tap never shows under the new heading.
  const stripKey = `${period}|${end}|${stripId ?? ''}`;
  const { data: stripRead } = useQuery(
    async (d) => ({ key: stripKey, strip: await periodStrip(d, period, end, stripId) }),
    [stripKey],
  );
  const strip = stripRead?.key === stripKey ? stripRead.strip : null;

  if (error) return <ErrorState error={error} onRetry={reload} what="load the trends" />;
  if (loading && !data) return <Loading label="Loading trends" />;

  const shown = chosen ? summarise(rows, { grain, period, vaccine: chosen.key }) : all;
  const compared = compareWithPrevious(rows, { grain, period, today, from });
  const priced = rows.some((r) => r.price !== null);

  // Moving to a period where the chosen vaccine was not given clears it and
  // says so, rather than showing every vaccine where hers used to be.
  const goTo = (g: Grain, p: string | null) => {
    const list = recentPeriods(today, g, PERIODS);
    const target = p ?? list[list.length - 1];
    const given = (key: string) =>
      rows.some((r) => vaccineKey(r.vaccine_name) === key && periodStart(r.local_date, g) === target);
    if (chosen && !given(chosen.key)) {
      setVaccine(null);
      setNotice(`${chosen.label} was not given in ${inPeriod(target, g)}. Showing all vaccines.`);
    } else {
      setNotice(null);
    }
    setGrain(g);
    setPicked(p);
  };

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Same order as Stock: when it was measured, then the number. The
          eyebrow names the period, so the selected column is never told
          apart by colour alone. */}
      <T style={st.eyebrow}>
        {heading(period, grain)} · {asOfLabel()}
      </T>
      <T style={st.total}>
        {doses(all.total)} <T style={st.totalTail}>{open ? 'so far' : 'given'}</T>
      </T>
      {/* Neutral ink, no arrow, for doses and rupees alike: more is neither
          good nor bad, and red already means OUT in this app. */}
      {compared ? <T style={st.sub}>{comparisonLabel(compared, grain)}</T> : null}
      {all.byVaccineSales.length ? (
        <T style={st.money}>
          {formatRupees(all.sales)} in vaccine sales{open ? ' so far' : ''}
        </T>
      ) : null}

      <View style={st.chips}>
        <Chip accent="trends" label="By week" selected={grain === 'week'} onPress={() => goTo('week', null)} />
        <Chip accent="trends" label="By month" selected={grain === 'month'} onPress={() => goTo('month', null)} />
      </View>

      <Card style={{ marginTop: space.md }}>
        <ColumnChart
          key={grain}
          accent="trends"
          data={series(rows, grain, periods)}
          selected={period}
          onSelect={(p) => goTo(grain, p)}
          describe={(t) => `${heading(t.key, grain)}, ${doses(t.doses)}`}
        />
      </Card>
      {notice ? <T style={st.notice}>{notice}</T> : null}

      <View style={st.chips}>
        <Chip accent="trends" label="Vaccines" selected={view === 'vaccines'} onPress={() => setView('vaccines')} />
        <Chip accent="trends" label="Children" selected={view === 'children'} onPress={() => setView('children')} />
        <Chip accent="trends" label="Stock" selected={view === 'stock'} onPress={() => setView('stock')} />
      </View>

      {/* The filter follows her into Children and Stock, so its way out does too. */}
      {chosen ? (
        <View style={st.filter}>
          <T style={st.filterText}>Only {chosen.label}</T>
          <SecondaryButton accent="trends" label="Show all vaccines" onPress={() => setVaccine(null)} />
        </View>
      ) : null}

      {view === 'stock' ? (
        <StockView
          strip={strip}
          ledger={ledger}
          label={`${chosen ? `${chosen.label} stock` : 'Stock'} in ${inPeriod(period, grain)}${open ? `, ${asOfLabel()}` : ''}`}
          left={shown.total - (strip?.given ?? shown.total)}
          outs={(ledger ? stockOuts(ledger, period, end, today) : []).filter(
            (o) => !chosen || vaccineKey(o.name) === chosen.key,
          )}
          chosen={chosen?.label}
          when={inPeriod(period, grain)}
          end={end}
        />
      ) : all.total === 0 ? (
        <T style={st.plain}>No doses in {inPeriod(period, grain)}.</T>
      ) : view === 'children' ? (
        <>
          <SectionTitle>{chosen ? `Age, ${chosen.label}` : 'Age'}</SectionTitle>
          {shown.byAge.every((t) => t.key === NOT_RECORDED_KEY || !t.doses) ? (
            <T style={st.plain}>Age is not recorded for {these(shown.total)} yet.</T>
          ) : (
            <Shares tallies={shown.byAge.filter((t) => t.doses)} total={shown.total} />
          )}

          <SectionTitle>{chosen ? `Boys and girls, ${chosen.label}` : 'Boys and girls'}</SectionTitle>
          {shown.bySex.every((t) => t.key === NOT_RECORDED_KEY || !t.doses) ? (
            <T style={st.plain}>Boy or girl is not recorded for {these(shown.total)} yet.</T>
          ) : (
            <Shares tallies={shown.bySex} total={shown.total} />
          )}

          {/* Most doses so far carry only a typed name. Saying where the data
              comes from is the honest answer to "why is so much missing". */}
          <T style={st.note}>Age and boy or girl come from the child&apos;s details on the dose screen.</T>
        </>
      ) : (
        <VaccinesView
          summary={all}
          priced={priced}
          bySales={priced && bySales}
          setBySales={setBySales}
          all={allRows}
          showAll={() => setAllRows(true)}
          chosen={chosen?.key}
          onPick={(key) => {
            setNotice(null);
            setVaccine(key === chosen?.key ? null : key);
          }}
        />
      )}
    </ScrollView>
  );
}

/** Most given, with rupees beside the doses once any vaccine has a price. */
function VaccinesView({
  summary,
  priced,
  bySales,
  setBySales,
  all,
  showAll,
  chosen,
  onPick,
}: {
  summary: Summary;
  priced: boolean;
  bySales: boolean;
  setBySales: (on: boolean) => void;
  all: boolean;
  showAll: () => void;
  chosen?: string;
  onPick: (key: string) => void;
}) {
  const rupees = new Map(summary.byVaccineSales.map((v) => [v.key, v.rupees]));
  // Unpriced vaccines sort below every priced one, ₹0 government doses included.
  const list = bySales
    ? [...summary.byVaccine].sort(
        (a, b) => (rupees.get(b.key) ?? -1) - (rupees.get(a.key) ?? -1) || b.doses - a.doses,
      )
    : summary.byVaccine;
  const top = bySales ? Math.max(0, ...rupees.values()) : (list[0]?.doses ?? 0);

  return (
    <>
      <SectionTitle>Most given</SectionTitle>
      {priced ? (
        <View style={[st.chips, { marginTop: 0, marginBottom: space.sm }]}>
          <Chip accent="trends" label="Most doses" selected={!bySales} onPress={() => setBySales(false)} />
          <Chip accent="trends" label="Most sales" selected={bySales} onPress={() => setBySales(true)} />
        </View>
      ) : null}
      <T style={st.hint}>Tap a vaccine to see only its children and stock.</T>
      {capped(list, all, chosen).map((v) => {
        const r = rupees.get(v.key);
        const value = r === undefined ? String(v.doses) : `${v.doses} · ${formatRupees(r)}`;
        return (
          <BarRow
            key={v.key}
            accent="trends"
            label={v.label}
            value={value}
            fraction={top ? (bySales ? (r ?? 0) : v.doses) / top : 0}
            selected={v.key === chosen}
            muted={!!chosen && v.key !== chosen}
            onPress={() => onPick(v.key)}
            accessibilityLabel={`${v.label}, ${doses(v.doses)}${r === undefined ? '' : `, ${formatRupees(r)}`}`}
          />
        );
      })}
      {list.length > CAP && !all ? <SecondaryButton accent="trends" label={`Show all ${list.length}`} onPress={showAll} /> : null}
      {priced && summary.unpriced ? (
        <BarRow label="Price not set" value={doses(summary.unpriced)} fraction={0} muted />
      ) : null}
    </>
  );
}

/** The handbook's period summary, then what ran out. */
function StockView({
  strip,
  ledger,
  label,
  left,
  outs,
  chosen,
  when,
  end,
}: {
  strip: Strip | null;
  ledger: Ledger | null;
  label: string;
  /** Doses given that the strip leaves out, because their vaccine was removed. */
  left: number;
  outs: { vaccine_id: string; name: string; days: number }[];
  chosen?: string;
  when: string;
  end: string;
}) {
  if (!strip || !ledger) return null;
  const quiet = [strip.opening, strip.received, strip.given, strip.wasted, strip.adjusted, strip.corrections, strip.now]
    .every((n) => n === 0);
  // A period that ends before the first entry has no stock story to tell.
  const firstEntry = [...ledger.days.values()].reduce(
    (m, l) => (l.length && l[0].local_date < m ? l[0].local_date : m),
    end,
  );
  if (quiet) return <T style={[st.plain, { marginTop: space.lg }]}>No stock was recorded in {when}.</T>;
  return (
    <>
      <MovementStrip strip={strip} accent={color.trends} label={label} openingLabel="Start" nowLabel="End" />
      {/* Stock counts the vaccines on her list; doses given count every dose,
          removed vaccines included. Say so when they differ, or the page
          shows two "given" numbers for one period. */}
      {left > 0 ? <T style={st.note}>Given leaves out {doses(left)} of vaccines you have since removed.</T> : null}

      {end >= firstEntry ? (
        <>
          <SectionTitle>{chosen ? `Ran out, ${chosen}` : 'Ran out'}</SectionTitle>
          {outs.length ? (
            outs.map((o, i) => (
              <Row
                key={o.vaccine_id}
                dense
                title={o.name}
                right={<T style={st.days}>{o.days === 1 ? '1 day' : `${o.days} days`}</T>}
                last={i === outs.length - 1}
              />
            ))
          ) : (
            <T style={st.plain}>{chosen ? 'Did not run out' : 'Did not run out of anything'}</T>
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * Count on every row, and the percent only once the group is big enough to
 * carry one. The bar is the share of the total either way.
 */
function Shares({ tallies, total }: { tallies: Tally[]; total: number }) {
  const withPercent = total >= PERCENT_FROM;
  return tallies.map((t) => {
    const pct = percent(t.doses, total);
    return (
      <BarRow
        key={t.key}
        accent="trends"
        label={t.label}
        value={withPercent ? `${t.doses} · ${pct}%` : String(t.doses)}
        fraction={total ? t.doses / total : 0}
        // Missing data, not a group: grey, so it reads as a gap to fill.
        muted={t.key === NOT_RECORDED_KEY}
        accessibilityLabel={`${t.label}, ${doses(t.doses)}${withPercent ? `, ${pct} percent` : ''}`}
      />
    );
  });
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  eyebrow: { fontSize: type.min, color: color.textMuted, fontWeight: weight.semibold },
  total: { fontSize: type.hero, fontWeight: weight.bold, color: color.text, marginTop: 2 },
  totalTail: { fontSize: type.title, fontWeight: weight.semibold },
  sub: { fontSize: type.body, color: color.textMuted, fontWeight: weight.semibold },
  money: { fontSize: type.body, color: color.text, fontWeight: weight.bold, marginTop: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  notice: { fontSize: type.label, color: color.text, marginTop: space.sm },
  filter: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, marginTop: space.xs },
  filterText: { fontSize: type.body, fontWeight: weight.bold, color: color.text },
  hint: { fontSize: type.min, color: color.textMuted, marginBottom: space.xs },
  note: { fontSize: type.min, color: color.textMuted, lineHeight: 21, marginTop: space.md },
  plain: { fontSize: type.body, color: color.text, marginTop: space.md },
  days: { fontSize: type.body, fontWeight: weight.bold, color: color.text },
});
