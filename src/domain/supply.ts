import type { Db } from '../db/driver';
import type { StockRow } from './types';
import { addDays, daysBetween } from './time';

/**
 * Supply answers: how long a vaccine lasts, what to order, which batch to use
 * first, and how many days it was out. Rules borrowed from the systems that
 * already do this for vaccines, not invented here:
 *
 *   - Rate of use counts only days the vaccine was in stock. A day out of
 *     stock is not a day nobody wanted it (the "adjusted consumption" rule in
 *     quantification guides; mSupply and OpenLMIS do the same).
 *   - Order = enough for the next four weeks minus what is on hand: the UIP
 *     handbook's indent rule (need + buffer - balance), at the 3-4 weeks of
 *     supply clinics are advised to hold.
 *   - Stock that will expire before the current rate reaches it is called out
 *     per batch (mSupply's "effective stock"), first expiry used first.
 *
 * Only active vaccines, matching the Stock list. Balances sum the raw ledger
 * (reversals cancel); doses given use the effective view (an undone dose was
 * not given). One load, then plain functions, so it is all Node-testable.
 */

/** Eight weeks: long enough to smooth a slow week, short enough to follow a season. */
export const RATE_WINDOW_DAYS = 56;
/** Order up to four weeks of use. She restocks about weekly. */
export const ORDER_COVER_DAYS = 28;
/** Suggest an order when stock runs out within two weeks, or is at the safety limit. */
export const ORDER_WHEN_DAYS_LEFT = 14;
/** Batches expiring within this many days are listed under "Use soon". */
export const USE_SOON_DAYS = 60;
/** Fewer doses than this in the window is not a rate, it is an anecdote. */
const MIN_SAMPLE_DOSES = 4;

export interface DayDelta {
  local_date: string;
  /** Net change to the balance that day (raw ledger). */
  delta: number;
  /** Doses given that day (effective view). */
  given: number;
}

export interface Ledger {
  /** Per vaccine, sorted by date. Only days with a movement appear. */
  days: Map<string, DayDelta[]>;
  names: Map<string, string>;
}

export async function loadLedger(db: Db): Promise<Ledger> {
  const active = `vaccine_id IN (SELECT id FROM vaccines WHERE deleted_at IS NULL AND is_active = 1)`;
  const [vaccines, deltas, given] = await Promise.all([
    db.all<{ id: string; name: string }>(
      `SELECT id, name FROM vaccines WHERE deleted_at IS NULL AND is_active = 1`,
    ),
    db.all<{ vaccine_id: string; local_date: string; n: number }>(
      `SELECT vaccine_id, local_date, SUM(delta_doses) AS n FROM stock_movements
        WHERE stock_source = 'CLINIC_STOCK' AND ${active}
        GROUP BY vaccine_id, local_date`,
    ),
    db.all<{ vaccine_id: string; local_date: string; n: number }>(
      `SELECT vaccine_id, local_date, -SUM(delta_doses) AS n FROM v_movement_effective
        WHERE movement_type = 'ADMINISTRATION' AND ${active}
        GROUP BY vaccine_id, local_date`,
    ),
  ]);

  const byKey = new Map<string, DayDelta & { vaccine_id: string }>();
  const at = (vaccine_id: string, local_date: string) => {
    const k = `${vaccine_id}|${local_date}`;
    let d = byKey.get(k);
    if (!d) byKey.set(k, (d = { vaccine_id, local_date, delta: 0, given: 0 }));
    return d;
  };
  for (const r of deltas) at(r.vaccine_id, r.local_date).delta += r.n;
  for (const r of given) at(r.vaccine_id, r.local_date).given += r.n;

  const days = new Map<string, DayDelta[]>();
  for (const { vaccine_id, ...d } of byKey.values()) {
    if (!days.has(vaccine_id)) days.set(vaccine_id, []);
    days.get(vaccine_id)!.push(d);
  }
  for (const list of days.values()) list.sort((a, b) => a.local_date.localeCompare(b.local_date));
  return { days, names: new Map(vaccines.map((v) => [v.id, v.name])) };
}

/**
 * Walk one vaccine day by day from `from` to `to` (inclusive). A day is OUT
 * when it held no stock at any point: nothing at the start, nothing at the
 * end, and nothing given in between.
 */
function eachDay(
  list: DayDelta[],
  from: string,
  to: string,
  fn: (day: { given: number; out: boolean }) => void,
) {
  let balance = 0;
  let i = 0;
  while (i < list.length && list[i].local_date < from) balance += list[i++].delta;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const opening = balance;
    let given = 0;
    while (i < list.length && list[i].local_date === date) {
      balance += list[i].delta;
      given += list[i].given;
      i++;
    }
    fn({ given, out: opening <= 0 && balance <= 0 && given === 0 });
  }
}

/** Doses per in-stock day over the eight weeks before today, or null when too few to say. */
export function usageRate(ledger: Ledger, vaccineId: string, today: string): number | null {
  let doses = 0;
  let inStock = 0;
  eachDay(ledger.days.get(vaccineId) ?? [], addDays(today, -RATE_WINDOW_DAYS), addDays(today, -1), (d) => {
    doses += d.given;
    if (!d.out) inStock++;
  });
  return doses >= MIN_SAMPLE_DOSES && inStock > 0 ? doses / inStock : null;
}

/**
 * Days with no stock at all, from `from` to `to` inclusive. Counted from the
 * vaccine's first entry: before its first delivery it was not stocked yet,
 * which is not the same as running out.
 */
export function daysOut(ledger: Ledger, vaccineId: string, from: string, to: string): number {
  const list = ledger.days.get(vaccineId) ?? [];
  if (!list.length) return 0;
  const start = list[0].local_date > from ? list[0].local_date : from;
  let n = 0;
  eachDay(list, start, to, (d) => {
    if (d.out) n++;
  });
  return n;
}

/**
 * Vaccines that ran out during a period, most days first. Only vaccines in
 * use - given in the period or the eight weeks before it - because a vaccine
 * the clinic stopped stocking is not "out", it is retired. `to` past today is
 * cut to today: the future has not run out of anything yet.
 */
export function stockOuts(
  ledger: Ledger,
  from: string,
  to: string,
  today: string,
): { vaccine_id: string; name: string; days: number }[] {
  const end = to < today ? to : today;
  if (end < from) return [];
  const out: { vaccine_id: string; name: string; days: number }[] = [];
  for (const [vaccine_id, name] of ledger.names) {
    let used = 0;
    eachDay(ledger.days.get(vaccine_id) ?? [], addDays(from, -RATE_WINDOW_DAYS), end, (d) => {
      used += d.given;
    });
    if (!used) continue;
    const days = daysOut(ledger, vaccine_id, from, end);
    if (days) out.push({ vaccine_id, name, days });
  }
  return out.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
}

/** "Lasts about 3 weeks", in weeks because she restocks weekly; null when there is nothing to last. */
export function lastsLabel(onHand: number, perDay: number | null): string | null {
  if (onHand <= 0) return null; // the OUT / CHECK badge already says it
  if (perDay === null) return 'Not used enough to tell';
  const days = onHand / perDay;
  if (days < 7) return 'Lasts under a week';
  if (days < 14) return 'Lasts about 1 week';
  if (days <= RATE_WINDOW_DAYS) return `Lasts about ${Math.round(days / 7)} weeks`;
  return 'Lasts more than 8 weeks';
}

export interface OrderLine {
  vaccine_id: string;
  name: string;
  onHand: number;
  /** Doses to order, whole vials for a vial-mode vaccine. 0 when `belowZero`. */
  order: number;
  perDay: number | null;
  /** The count is negative: a delivery was not logged, so any order figure would be wrong. */
  belowZero: boolean;
}

/** One vaccine's line for "Order this week", or null when it does not need ordering yet. */
export function suggestOrder(row: StockRow, perDay: number | null): OrderLine | null {
  const base = { vaccine_id: row.vaccine_id, name: row.name, onHand: row.on_hand_doses, perDay };
  if (row.on_hand_doses < 0) return { ...base, order: 0, belowZero: true };
  if (perDay === null) return null;
  const due =
    row.on_hand_doses <= row.min_balance_doses || row.on_hand_doses / perDay < ORDER_WHEN_DAYS_LEFT;
  if (!due) return null;
  let order = Math.ceil(perDay * ORDER_COVER_DAYS) - row.on_hand_doses;
  if (order <= 0) return null;
  // Vials come whole; the doctor still reads doses (invariant 4).
  if (row.unit_mode === 'VIAL' && row.doses_per_vial > 1) {
    order = Math.ceil(order / row.doses_per_vial) * row.doses_per_vial;
  }
  return { ...base, order, belowZero: false };
}

/** Every active vaccine that needs ordering: below zero first, then soonest to run out. */
export function orderList(rows: StockRow[], ledger: Ledger, today: string): OrderLine[] {
  const lines = rows
    .filter((r) => r.is_active)
    .map((r) => suggestOrder(r, usageRate(ledger, r.vaccine_id, today)))
    .filter((l): l is OrderLine => l !== null);
  const daysLeft = (l: OrderLine) => (l.perDay ? l.onHand / l.perDay : Infinity);
  return lines.sort(
    (a, b) => Number(b.belowZero) - Number(a.belowZero) || daysLeft(a) - daysLeft(b) || a.name.localeCompare(b.name),
  );
}

export interface ExpiringLot {
  lot_id: string;
  vaccine_id: string;
  name: string;
  lot_number: string;
  expiry_date: string;
  onHand: number;
  expired: boolean;
  /** Doses this batch will still hold at expiry at the current rate; null when the rate is unknown. */
  mayWaste: number | null;
}

/**
 * Batches with stock that expire within USE_SOON_DAYS, soonest first.
 *
 * First expiry is assumed used first, so a later batch only starts being used
 * once the earlier ones are gone. An expired batch can no longer be used, so
 * all of it is at risk.
 */
// ponytail: per-batch balances trust the batch on each dose; a dose logged as
// "Not sure" leaves its batch looking fuller than the fridge. Every dose in the
// clinic's records names its batch (27 Oct 2026); spread by FEFO if that changes.
export async function expiringLots(db: Db, ledger: Ledger, today: string): Promise<ExpiringLot[]> {
  const rows = await db.all<Omit<ExpiringLot, 'expired' | 'mayWaste'>>(
    `SELECT b.lot_id, b.vaccine_id, v.name, b.lot_number, b.expiry_date, b.on_hand_doses AS onHand
       FROM v_lot_balance b
       JOIN vaccines v ON v.id = b.vaccine_id
      WHERE v.deleted_at IS NULL AND v.is_active = 1
        AND b.on_hand_doses > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?
      ORDER BY b.expiry_date, b.lot_number`,
    [addDays(today, USE_SOON_DAYS)],
  );

  const usedFirst = new Map<string, number>();
  return rows.map((lot) => {
    const expired = lot.expiry_date < today;
    if (expired) return { ...lot, expired, mayWaste: lot.onHand };
    const perDay = usageRate(ledger, lot.vaccine_id, today);
    if (perDay === null) return { ...lot, expired, mayWaste: null };
    const before = usedFirst.get(lot.vaccine_id) ?? 0;
    usedFirst.set(lot.vaccine_id, before + lot.onHand);
    // Through the printed day: expiry is stored as the last usable day.
    const reach = Math.floor(perDay * (daysBetween(today, lot.expiry_date) + 1)) - before;
    return { ...lot, expired, mayWaste: Math.max(0, lot.onHand - Math.max(0, reach)) };
  });
}
