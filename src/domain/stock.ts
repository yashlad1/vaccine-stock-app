import type { StockRow } from './types';

/**
 * THE CLINICIAN NEVER MULTIPLIES.
 *
 * Doses are the ledger unit, always. Vials are a packaging fact that this
 * module converts. Vial-to-dose arithmetic done in a hurry, in the head, is
 * where most of the paper notebook's errors came from - so if a screen ever
 * asks a human to multiply, the screen is wrong.
 */

export type StockLevel = 'NEGATIVE' | 'OUT' | 'LOW' | 'OK';

export interface StockDisplay {
  doses: number;
  /** Always dose-denominated: "18 doses". The number that can be acted on. */
  primary: string;
  level: StockLevel;
  /** Colour is never the only signal; this word always accompanies it. */
  badge?: string;
}

export function dosesFromVials(dosesPerVial: number, vials: number): number {
  return dosesPerVial * vials;
}

/**
 * Low-stock boundary is `<=`, not `<`. Off-by-one here means a vaccine runs out
 * silently, which is the whole thing we are trying to prevent.
 */
export function stockLevel(onHandDoses: number, minBalanceDoses: number): StockLevel {
  if (onHandDoses < 0) return 'NEGATIVE';
  if (onHandDoses === 0) return 'OUT';
  if (minBalanceDoses > 0 && onHandDoses <= minBalanceDoses) return 'LOW';
  return 'OK';
}

/** "1 dose", "12 doses". `Math.abs` so a negative balance of -1 still reads singular. */
export const plural = (n: number, one: string, many: string) => `${n} ${Math.abs(n) === 1 ? one : many}`;

/** A ledger amount with its unit and an explicit sign: "+10 doses", "-1 dose". */
export const formatDelta = (n: number) => `${n > 0 ? '+' : ''}${plural(n, 'dose', 'doses')}`;

export function describeStock(doses: number, minBalanceDoses: number): StockDisplay {
  const level = stockLevel(doses, minBalanceDoses);
  const badge = level === 'NEGATIVE' ? 'CHECK' : level === 'OK' ? undefined : level;
  return { doses, primary: plural(doses, 'dose', 'doses'), level, badge };
}

export function describeStockRow(row: StockRow): StockDisplay {
  return describeStock(row.on_hand_doses, row.min_balance_doses);
}

/**
 * Why the Add stock headline and the strip under it differ.
 *
 * The headline counts a below-zero vaccine as 0 - a missing delivery is not
 * stock to subtract - while the strip sums the ledger raw, so the same
 * vaccine subtracts there. Both are right, and a total that disagrees with
 * the line under it is a total she stops believing. Returns '' when they
 * agree, which is the normal case.
 */
export function belowZeroNote(onHand: readonly number[]): string {
  const below = onHand.filter((n) => n < 0);
  if (below.length === 0) return '';
  const short = -below.reduce((a, n) => a + n, 0);
  const who = below.length === 1 ? 'One vaccine is' : `${below.length} vaccines are`;
  return `${who} below zero by ${short === 1 ? '1 dose' : `${short} doses`}, so the line above is that much lower. A delivery was probably not logged.`;
}
