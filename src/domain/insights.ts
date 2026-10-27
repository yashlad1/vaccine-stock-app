import type { Db } from '../db/driver';
import type { Sex } from '../db/repo/patients';
import { MONTHS, addDays, ageInMonths, daysBetween } from './time';

/**
 * Trends: which vaccines go out most, to which ages, to boys or girls, by week
 * or by month.
 *
 * Counts DOSES GIVEN, not money. Prices are not modelled (billing is out of
 * scope, CLAUDE.md section 3), so "sold the most" is the dose count.
 *
 * Activity, so it reads v_movement_effective: a dose recorded and undone is
 * not a dose given. Soft-deleted vaccines stay in, because they were given.
 *
 * One query for the whole window, then plain functions over the rows. A year
 * of a busy clinic is a few thousand rows, so re-tallying on every tap is
 * cheaper than a query per chart, and the arithmetic is testable without SQL.
 */

export type Grain = 'week' | 'month';

export interface InsightDose {
  local_date: string;
  vaccine_id: string;
  vaccine_name: string;
  doses: number;
  dob: string | null;
  sex: Sex | null;
  /** Rupees per dose: its stamp, else today's price; 0 for a government dose; null when not set. */
  price: number | null;
}

export interface Tally {
  key: string;
  label: string;
  doses: number;
}

/** Age and sex come from a saved child, so a typed-only name lands here. */
export const NOT_RECORDED = 'Not recorded';
/** The tally key for NOT_RECORDED; match on this, not on the wording. */
export const NOT_RECORDED_KEY = 'unknown';

/** Periods on the chart, at either grain. */
export const PERIODS = 12;

/**
 * Below this many doses a percent says more than the data does: 2 of 3 is
 * "67%", which reads like a finding.
 */
export const PERCENT_FROM = 20;

/**
 * One vaccine as the doctor knows it. Removing a vaccine and adding it back
 * (the documented undo) makes a second row with the same name, so one
 * vaccine's history spans two ids; Trends groups by this. Identity stays by
 * id everywhere else.
 */
export function vaccineKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function dosesSince(db: Db, fromLocalDate: string): Promise<InsightDose[]> {
  // A dose keeps the price it was given at; one from before prices existed
  // has no stamp and takes today's (CLAUDE.md section 9, Trends). A
  // government dose was free to the family whatever the vaccine costs.
  return db.all<InsightDose>(
    `SELECT m.local_date, m.vaccine_id, v.name AS vaccine_name,
            -m.delta_doses AS doses, p.dob, p.sex,
            CASE WHEN l.funding_source = 'GOVT_UIP' THEN 0
                 ELSE COALESCE(m.price_rupees, v.price_rupees) END AS price
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
       LEFT JOIN lots l ON l.id = m.lot_id
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE m.movement_type = 'ADMINISTRATION' AND m.local_date >= ?`,
    [fromLocalDate],
  );
}

// ---------------------------------------------------------------------------
// Periods. Keys are the period's first local date, so they sort as strings.
// ---------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

function utc(localDate: string): Date {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** Weeks start on Monday; months on the 1st. */
export function periodStart(localDate: string, grain: Grain): string {
  if (grain === 'month') return `${localDate.slice(0, 7)}-01`;
  const d = utc(localDate);
  return iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
}

/** The last `n` periods up to and including today's, oldest first. */
export function recentPeriods(today: string, grain: Grain, n: number): string[] {
  const start = utc(periodStart(today, grain));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(
      grain === 'week'
        ? iso(new Date(start.getTime() - i * 7 * DAY))
        : iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1))),
    );
  }
  return out;
}

/**
 * The first day of the data the screen loads. Twelve months reach further
 * back than twelve weeks plus the week before them, so one read serves both
 * grains and every comparison inside them.
 */
export function windowStart(today: string): string {
  return recentPeriods(today, 'month', PERIODS)[0];
}

/** The last day of the period that starts on `start`. */
export function periodEnd(start: string, grain: Grain): string {
  if (grain === 'week') return addDays(start, 6);
  const d = utc(start);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

function previousStart(start: string, grain: Grain): string {
  if (grain === 'week') return addDays(start, -7);
  const d = utc(start);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
}

/** Week: "13 Oct" (its Monday). Month: "Oct 2026". */
export function periodLabel(start: string, grain: Grain): string {
  const [y, m, d] = start.split('-').map(Number);
  return grain === 'week' ? `${d} ${MONTHS[m - 1]}` : `${MONTHS[m - 1]} ${y}`;
}

/** Doses per period, one entry per period even when it is zero. */
export function series(rows: InsightDose[], grain: Grain, periods: string[]): Tally[] {
  const by = new Map(periods.map((p) => [p, 0]));
  for (const r of rows) {
    const k = periodStart(r.local_date, grain);
    if (by.has(k)) by.set(k, by.get(k)! + r.doses);
  }
  return periods.map((p) => ({ key: p, label: periodLabel(p, grain), doses: by.get(p)! }));
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

/**
 * Bands that follow the schedule rather than the calendar: the infant
 * primary series, the 9-month and first-year doses, the 2-year boosters,
 * school-entry boosters, then adolescent HPV and Td.
 */
const AGE_GROUPS: { key: string; label: string; under: number }[] = [
  { key: 'u6m', label: 'Under 6 months', under: 6 },
  { key: '6-11m', label: '6 to 11 months', under: 12 },
  { key: '1y', label: '1 year', under: 24 },
  { key: '2-4y', label: '2 to 4 years', under: 60 },
  { key: '5-9y', label: '5 to 9 years', under: 120 },
  { key: '10y', label: '10 years and over', under: Infinity },
];

export function ageGroup(dob: string | null, onLocalDate: string): string | null {
  const months = ageInMonths(dob, onLocalDate);
  return months === null ? null : AGE_GROUPS.find((g) => months < g.under)!.key;
}

export interface Sales {
  key: string;
  label: string;
  rupees: number;
}

export interface Summary {
  total: number;
  /** Most given first; only vaccines that were given. Keyed by `vaccineKey`. */
  byVaccine: Tally[];
  /** Rupees from the doses that have a price. */
  sales: number;
  /** Highest first; vaccines with at least one priced dose, same keys as byVaccine. */
  byVaccineSales: Sales[];
  /** Doses with no price. Shown as "Price not set", never as ₹0. */
  unpriced: number;
  /** Every band in order, zeros included, then "Not recorded" if any. */
  byAge: Tally[];
  /** Boys, Girls, then "Not recorded" if any. */
  bySex: Tally[];
}

/**
 * Everything the screen shows for one period, optionally one vaccine
 * (`vaccine` is a byVaccine key, so it selects every row with that name).
 */
export function summarise(
  rows: InsightDose[],
  opts: { grain: Grain; period: string; vaccine?: string | null },
): Summary {
  const picked = rows.filter(
    (r) =>
      periodStart(r.local_date, opts.grain) === opts.period &&
      (!opts.vaccine || vaccineKey(r.vaccine_name) === opts.vaccine),
  );

  const vaccines = new Map<string, Tally & Sales & { at: string; priced: boolean }>();
  const ages = new Map(AGE_GROUPS.map((g) => [g.key, 0]));
  let ageUnknown = 0;
  const sexes = { M: 0, F: 0 };
  let sexUnknown = 0;
  let total = 0;
  let sales = 0;
  let unpriced = 0;

  for (const r of picked) {
    total += r.doses;
    const key = vaccineKey(r.vaccine_name);
    let v = vaccines.get(key);
    if (!v) {
      v = { key, label: r.vaccine_name.trim(), doses: 0, rupees: 0, at: r.local_date, priced: false };
      vaccines.set(key, v);
    }
    // Two rows may differ in case; show the spelling of the latest dose.
    if (r.local_date > v.at) {
      v.at = r.local_date;
      v.label = r.vaccine_name.trim();
    }
    v.doses += r.doses;
    if (r.price === null) {
      unpriced += r.doses;
    } else {
      v.priced = true;
      v.rupees += r.doses * r.price;
      sales += r.doses * r.price;
    }

    const g = ageGroup(r.dob, r.local_date);
    if (g) ages.set(g, ages.get(g)! + r.doses);
    else ageUnknown += r.doses;

    if (r.sex === 'M' || r.sex === 'F') sexes[r.sex] += r.doses;
    else sexUnknown += r.doses;
  }

  const unknown = (n: number): Tally[] => (n ? [{ key: NOT_RECORDED_KEY, label: NOT_RECORDED, doses: n }] : []);

  const list = [...vaccines.values()];
  return {
    total,
    byVaccine: list
      .map(({ key, label, doses }) => ({ key, label, doses }))
      .sort((a, b) => b.doses - a.doses || a.label.localeCompare(b.label)),
    sales,
    byVaccineSales: list
      .filter((v) => v.priced)
      .map(({ key, label, rupees }) => ({ key, label, rupees }))
      .sort((a, b) => b.rupees - a.rupees || a.label.localeCompare(b.label)),
    unpriced,
    byAge: [
      ...AGE_GROUPS.map((g) => ({ key: g.key, label: g.label, doses: ages.get(g.key)! })),
      ...unknown(ageUnknown),
    ],
    bySex: [
      { key: 'M', label: 'Boys', doses: sexes.M },
      { key: 'F', label: 'Girls', doses: sexes.F },
      ...unknown(sexUnknown),
    ],
  };
}

/** Whole-number share for a label. Rounded, so a column may sum to 99 or 101. */
export function percent(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Busier than last time?
// ---------------------------------------------------------------------------

export interface Comparison {
  current: number;
  previous: number;
  /** The period is still running, so both sides count only its days so far. */
  soFar: boolean;
}

/**
 * Doses in `period` against the period before it, like for like.
 *
 * A period still running is compared over the SAME days of the one before
 * (1-14 Oct against 1-14 Sep), never against the whole of it: 80 so far
 * against 200 last month reads as a slump that is only a calendar. Null when
 * the period before starts outside the loaded rows or had no doses, because
 * "up from nothing" is not a comparison.
 */
// ponytail: today counts as a whole day on both sides, so early in the day an
// open period leans towards "fewer". Compare by time of day if that misleads.
export function compareWithPrevious(
  rows: InsightDose[],
  opts: { grain: Grain; period: string; today: string; from: string },
): Comparison | null {
  const prev = previousStart(opts.period, opts.grain);
  if (prev < opts.from) return null;
  const end = periodEnd(opts.period, opts.grain);
  const prevLast = periodEnd(prev, opts.grain);
  const soFar = opts.today <= end;
  const curEnd = soFar ? opts.today : end;
  // A shorter month before (Feb against 30 Mar) is cut at its own end.
  const sameDays = addDays(prev, daysBetween(opts.period, curEnd));
  const prevEnd = soFar && sameDays < prevLast ? sameDays : prevLast;

  const sum = (from: string, to: string) =>
    rows.reduce((n, r) => (r.local_date >= from && r.local_date <= to ? n + r.doses : n), 0);
  const previous = sum(prev, prevEnd);
  return previous ? { current: sum(opts.period, curEnd), previous, soFar } : null;
}

/** "14 more than the same days last month (11% more)", in neutral words: more is not better. */
export function comparisonLabel(c: Comparison, grain: Grain): string {
  const than = c.soFar ? `the same days last ${grain}` : `the ${grain} before`;
  const diff = c.current - c.previous;
  if (!diff) return `Same as ${than}`;
  const word = diff > 0 ? 'more' : 'fewer';
  const pct = c.previous >= PERCENT_FROM ? percent(Math.abs(diff), c.previous) : 0;
  return `${Math.abs(diff)} ${word} than ${than}${pct ? ` (${pct}% ${word})` : ''}`;
}
