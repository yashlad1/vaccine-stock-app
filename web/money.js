/**
 * Money on the dashboard: doses and their sales value by week or month.
 *
 * Pure functions, no DOM, so src/domain/dashboard-money.db.test.ts can run them
 * in Node. Loaded as a plain <script> in the browser.
 *
 * The rules are CLAUDE.md section 9 (Trends):
 *  - a dose is worth the price STAMPED on it. `null` means "Price not set" and
 *    is counted on its own line, NEVER as 0. A real 0 is a real value.
 *  - percents only for groups of 20 doses or more.
 *  - comparisons are neutral: no arrows, more is neither good nor bad.
 *
 * Not possible here: telling a government (UIP) dose from a clinic one. That is
 * `lots.funding_source`, and the page can read only the three views. So a UIP
 * dose carrying a price counts at that price; the screen says so.
 */
const Money = (() => {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const PERCENT_FROM = 20;
  const p2 = (n) => String(n).padStart(2, '0');
  const utc = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const addDays = (ymd, n) => iso(new Date(utc(ymd).getTime() + n * 86400000));

  /** Weeks start on Monday, months on the 1st. */
  function periodStart(ymd, grain) {
    if (grain === 'month') return `${ymd.slice(0, 7)}-01`;
    return addDays(ymd, -((utc(ymd).getUTCDay() + 6) % 7));
  }

  function periodEnd(start, grain) {
    if (grain === 'week') return addDays(start, 6);
    const d = utc(start);
    return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  }

  function previousStart(start, grain) {
    if (grain === 'week') return addDays(start, -7);
    const d = utc(start);
    return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
  }

  /** The last `n` period starts, newest first. */
  function recentPeriods(today, grain, n) {
    const out = [periodStart(today, grain)];
    while (out.length < n) out.push(previousStart(out[out.length - 1], grain));
    return out;
  }

  function periodLabel(start, grain) {
    const [y, m, d] = start.split('-').map(Number);
    return grain === 'week' ? `${d} ${MONTHS[m - 1]}` : `${MONTHS[m - 1]} ${y}`;
  }

  /** Rupees in Indian digit grouping: ₹1,23,450. */
  function rupees(n) {
    const digits = String(Math.round(Math.abs(n)));
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return `${n < 0 ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}`;
  }

  /** price_rupees arrives as a number, a numeric string, or null. Only null/blank is "not set". */
  function stamp(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Doses and value for the rows dated within [from, to].
   * `rows`: { local_date, delta_doses, price_rupees }.
   * `unpriced` is its own count and never adds to `value`.
   */
  function tally(rows, from, to) {
    let doses = 0; let priced = 0; let unpriced = 0; let value = 0;
    for (const r of rows) {
      if (r.local_date < from || r.local_date > to) continue;
      const n = Math.abs(Number(r.delta_doses) || 0);
      const price = stamp(r.price_rupees);
      doses += n;
      if (price === null) { unpriced += n; } else { priced += n; value += n * price; }
    }
    return { doses, priced, unpriced, value };
  }

  /** One entry per period, newest first. */
  function series(rows, today, grain, n) {
    return recentPeriods(today, grain, n).map((start) => ({
      start,
      label: periodLabel(start, grain),
      ...tally(rows, start, periodEnd(start, grain)),
    }));
  }

  /** "67%" of 3 doses misleads: a percent only from 20 doses. Else null. */
  function share(part, whole) {
    return whole >= PERCENT_FROM ? Math.round((part / whole) * 100) : null;
  }

  /**
   * Doses against the period before, over the SAME days while this one is still
   * running (80 so far against a whole month of 200 reads as a crash). Null
   * when the earlier period is outside the loaded rows or had no doses.
   */
  function compare(rows, today, grain, start, loadedFrom) {
    const prev = previousStart(start, grain);
    if (prev < loadedFrom) return null;
    const end = periodEnd(start, grain);
    const soFar = today <= end;
    const curEnd = soFar ? today : end;
    const prevLast = periodEnd(prev, grain);
    const sameDays = addDays(prev, Math.round((utc(curEnd) - utc(start)) / 86400000));
    const prevEnd = soFar && sameDays < prevLast ? sameDays : prevLast;
    const previous = tally(rows, prev, prevEnd).doses;
    if (!previous) return null;
    const current = tally(rows, start, curEnd).doses;
    const than = soFar ? `the same days last ${grain}` : `the ${grain} before`;
    const diff = current - previous;
    if (!diff) return `Same as ${than}`;
    const word = diff > 0 ? 'more' : 'fewer';
    const pct = previous >= PERCENT_FROM ? Math.round((Math.abs(diff) / previous) * 100) : 0;
    return `${Math.abs(diff)} ${word} than ${than}${pct ? ` (${pct}% ${word})` : ''}`;
  }

  return { periodStart, periodEnd, previousStart, recentPeriods, periodLabel, rupees, tally, series, share, compare };
})();

if (typeof module !== 'undefined') module.exports = Money;
