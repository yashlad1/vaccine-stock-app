import type { Db } from '../db/driver';
import type { StockRow } from './types';
import { todayLocal } from './time';

/**
 * The three reports the clinician actually asked for, plus the one that makes
 * them trustworthy.
 *
 * THE SUBTLETY THAT WOULD OTHERWISE BECOME A BUG:
 *   - BALANCES sum the raw table. Reversals cancel arithmetically, which is the
 *     entire reason reversing entries are the right design.
 *   - ACTIVITY COUNTS ("how many doses were given today") MUST go through
 *     v_movement_effective, or "3 given, 1 undone" renders as 3.
 */

// ---------------------------------------------------------------------------
// Report 1: "Vaccine stock, names, unique values"
// ---------------------------------------------------------------------------

/**
 * Uniqueness here is STRUCTURAL, not a report property. A vaccine appears
 * exactly once because it IS one catalog row. There is no de-duplication step,
 * no fuzzy grouping, no "BCG" vs "B.C.G" vs "BCG vaccine" cleanup - those
 * strings can never be created in the first place.
 */
export function stockOnHand(db: Db, opts: { activeOnly?: boolean } = {}): Promise<StockRow[]> {
  return db.all<StockRow>(
    `SELECT s.*, v.aliases AS aliases FROM v_stock_on_hand s
       JOIN vaccines v ON v.id = s.vaccine_id
      ${opts.activeOnly ? 'WHERE s.is_active = 1' : ''}
      ORDER BY s.name COLLATE NOCASE`,
  );
}

export function vaccinesInStock(db: Db): Promise<StockRow[]> {
  return db.all<StockRow>(
    `SELECT s.*, v.aliases AS aliases FROM v_stock_on_hand s
       JOIN vaccines v ON v.id = s.vaccine_id
      WHERE s.on_hand_doses <> 0 ORDER BY s.name COLLATE NOCASE`,
  );
}

/**
 * Ordering for the Give Dose grid: what this clinic actually gives, first.
 *
 * A single clinic gives the same 6-8 vaccines for the overwhelming majority of
 * doses, so pinning those to the first screenful makes the common dose entry a
 * zero-scroll single tap. Deterministic (30-day dose count, then name) so it is
 * testable rather than mysterious.
 *
 * Usage counts up to YESTERDAY (`beforeLocalDate` is exclusive, pass today).
 * Counting today made a tile jump past its neighbours right after a dose, so
 * the grid moved between one child and the next and broke muscle memory.
 */
export function vaccinesByUsage(db: Db, sinceLocalDate: string, beforeLocalDate: string): Promise<(StockRow & { recent_doses: number })[]> {
  return db.all(
    // `aliases` is joined rather than read from the view: the view predates
    // the search work and section 2 keeps migrations additive, so replacing it
    // would cost a DROP for a column one query wants.
    `SELECT s.*, v.aliases AS aliases, COALESCE(u.recent_doses, 0) AS recent_doses
       FROM v_stock_on_hand s
       JOIN vaccines v ON v.id = s.vaccine_id
       LEFT JOIN (
         SELECT vaccine_id, -SUM(delta_doses) AS recent_doses
           FROM v_movement_effective
          WHERE movement_type = 'ADMINISTRATION' AND local_date >= ? AND local_date < ?
          GROUP BY vaccine_id
       ) u ON u.vaccine_id = s.vaccine_id
      WHERE s.is_active = 1
      ORDER BY recent_doses DESC, s.name COLLATE NOCASE`,
    [sinceLocalDate, beforeLocalDate],
  );
}

// ---------------------------------------------------------------------------
// Report 2: "Vaccines given today, time, count"
// ---------------------------------------------------------------------------

export interface DoseLine {
  id: string;
  local_time: string;
  vaccine_name: string;
  lot_number: string | null;
  patient_label: string | null;
  doses: number;
  needs_detail: number;
  local_date: string;
  /** The child's date of birth, for the age at this dose (`formatAge`). */
  dob: string | null;
}

/** The notebook page, replicated - but with the arithmetic done for you. */
export function dosesGiven(db: Db, localDate: string): Promise<DoseLine[]> {
  return db.all<DoseLine>(
    `SELECT m.id, m.local_time, v.name AS vaccine_name, l.lot_number,
            m.patient_label,
            -m.delta_doses AS doses, m.needs_detail, m.local_date, p.dob
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
       LEFT JOIN lots  l ON l.id = m.lot_id
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE m.movement_type = 'ADMINISTRATION' AND m.local_date = ?
      ORDER BY m.occurred_at ASC`,
    [localDate],
  );
}

export function dosesGivenTotals(
  db: Db,
  localDate: string,
): Promise<{ vaccine_id: string; name: string; doses: number }[]> {
  return db.all(
    `SELECT m.vaccine_id, v.name, -SUM(m.delta_doses) AS doses
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
      WHERE m.movement_type = 'ADMINISTRATION' AND m.local_date = ?
      GROUP BY m.vaccine_id
      ORDER BY doses DESC, v.name COLLATE NOCASE`,
    [localDate],
  );
}

// ---------------------------------------------------------------------------
// Report 3: "Vaccines remaining today, time, count"
// ---------------------------------------------------------------------------

/**
 * "Remaining today" is genuinely ambiguous - on-hand right now, or opening
 * balance minus what went out? Rather than pick one and be wrong half the time,
 * we show the primary number (on-hand now) together with the derivation that
 * produces it:
 *
 *   Opening 30 · +Received 20 · -Given 7 · -Wasted 3 · = Now 40
 *
 * This is literally what the paper notebook was trying to be. It makes the
 * arithmetic self-checking and removes the "which remaining did you mean"
 * argument by showing both readings reconciling on one line.
 */
export interface MovementStrip {
  /** First day covered. */
  from: string;
  /** Last day covered; the same as `from` for a one-day strip. */
  localDate: string;
  opening: number;
  received: number;
  given: number;
  wasted: number;
  adjusted: number;
  /** Reversals booked in the range against movements dated BEFORE it. */
  corrections: number;
  /** opening + received - given - wasted + adjusted + corrections */
  now: number;
}

/** One day's strip: the Stock tab and Given today. */
export function movementStrip(db: Db, localDate: string, vaccineId?: string): Promise<MovementStrip> {
  return periodStrip(db, localDate, localDate, vaccineId);
}

/**
 * The same equation over a range, `from` to `to` inclusive: the UIP
 * handbook's monthly summary (start, received, given, wasted, end). `opening`
 * is the balance before `from` and `now` the balance at the end of `to`, so a
 * range that is still running ends on today's balance.
 */
export async function periodStrip(
  db: Db,
  from: string,
  to: string,
  vaccineId?: string,
): Promise<MovementStrip> {
  // Whole-clinic: only vaccines the Stock list shows, so a removed vaccine's
  // leftover doses are not counted anywhere (the remove dialog promises that).
  // A single vaccine keeps its own numbers whatever its state.
  const vFilter = vaccineId
    ? 'AND vaccine_id = ?'
    : 'AND vaccine_id IN (SELECT id FROM vaccines WHERE deleted_at IS NULL AND is_active = 1)';
  const vArg = vaccineId ? [vaccineId] : [];

  // `now` is read straight off the ledger rather than accumulated from the
  // parts. That makes it authoritative - it is the same number the Stock tab
  // shows - and it lets `corrections` absorb the residual, so the strip
  // RECONCILES BY CONSTRUCTION and cannot silently disagree with itself.
  const nowRow = await db.first<{ n: number }>(
    `SELECT COALESCE(SUM(delta_doses),0) AS n FROM stock_movements
      WHERE local_date <= ? AND stock_source = 'CLINIC_STOCK' ${vFilter}`,
    [to, ...vArg],
  );

  // Opening balance sums the RAW table: a reversal dated before the range has
  // already cancelled its original arithmetically.
  const openingRow = await db.first<{ n: number }>(
    `SELECT COALESCE(SUM(delta_doses),0) AS n FROM stock_movements
      WHERE local_date < ? AND stock_source = 'CLINIC_STOCK' ${vFilter}`,
    [from, ...vArg],
  );

  // The range's activity uses the EFFECTIVE view, so a dose recorded and
  // undone inside it does not inflate "given".
  const rows = await db.all<{ movement_type: string; n: number }>(
    `SELECT movement_type, COALESCE(SUM(delta_doses),0) AS n
       FROM v_movement_effective
      WHERE local_date >= ? AND local_date <= ? AND stock_source = 'CLINIC_STOCK' ${vFilter}
      GROUP BY movement_type`,
    [from, to, ...vArg],
  );
  const by = (t: string) => rows.find((r) => r.movement_type === t)?.n ?? 0;
  // Guard against -0: SUM of nothing negated renders as "-0 doses" on screen.
  const flip = (n: number) => (n === 0 ? 0 : -n);

  const opening = openingRow?.n ?? 0;
  const now = nowRow?.n ?? 0;
  const received = by('RECEIPT') + by('OPENING_BALANCE');
  const given = flip(by('ADMINISTRATION'));
  const wasted = flip(by('WASTAGE'));
  const adjusted = by('ADJUSTMENT');

  // What the activity lines above cannot show: the arithmetic effect of
  // reversals that undo entries from BEFORE the range. The original still
  // sits inside `opening` while the reversal is dated inside the range, so
  // without this term the strip would present a derivation that does not add up.
  const corrections = now - (opening + received - given - wasted + adjusted);

  return { from, localDate: to, opening, received, given, wasted, adjusted, corrections, now };
}

/** Every report renders its as-of time. A stock number without one is a rumour. */
export function asOfLabel(at: number = Date.now()): string {
  const d = new Date(at);
  const h = d.getHours();
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `as of ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

export function todaysStrip(db: Db, at: number = Date.now(), tz?: number) {
  return movementStrip(db, todayLocal(at, tz));
}

/** Entries where the child was skipped, for day-end completion. */
export function missingChildEntries(db: Db, limit = 50): Promise<DoseLine[]> {
  return db.all<DoseLine>(
    `SELECT m.id, m.local_time, v.name AS vaccine_name, l.lot_number,
            m.patient_label,
            -m.delta_doses AS doses, m.needs_detail, m.local_date, p.dob
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
       LEFT JOIN lots  l ON l.id = m.lot_id
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE m.needs_detail = 1
      ORDER BY m.occurred_at DESC
      LIMIT ?`,
    [limit],
  );
}
