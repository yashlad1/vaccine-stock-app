/**
 * Rupees, in Indian digit grouping: ₹1,23,450.
 *
 * By hand, not Intl, for the reason formatDate gives in time.ts: Node's full
 * ICU and Android's Hermes build disagree, so Intl output is neither testable
 * in CI nor stable on the device.
 */
export function formatRupees(rupees: number): string {
  const sign = rupees < 0 ? '-' : '';
  const digits = String(Math.round(Math.abs(rupees)));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}₹${rest ? `${rest},${last3}` : last3}`;
}

/** A typed price: whole rupees, or null for blank. Anything else is not a price. */
export function parseRupees(text: string): number | null | undefined {
  const t = text.trim().replace(/[₹,\s]/g, '');
  if (!t) return null;
  return /^\d{1,7}$/.test(t) ? Number(t) : undefined;
}
