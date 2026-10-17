/**
 * Local-date handling.
 *
 * We compute local_date / local_time ONCE, at write time, and store them.
 * "Vaccines given today" is then an indexed equality test on a stored string:
 * deterministic, unit-testable, and immune to the phone's timezone changing
 * later. Doing it at query time with date('now','localtime') depends on the
 * device's *current* timezone and cannot be tested in CI.
 */

export interface LocalStamp {
  occurredAt: number; // epoch ms UTC
  localDate: string; // 'YYYY-MM-DD'
  localTime: string; // 'HH:MM'
  tzOffsetMinutes: number; // minutes to ADD to UTC to get local (IST = +330)
}

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * Stamp an instant. `tzOffsetMinutes` defaults to the device's current offset;
 * pass it explicitly in tests to pin behaviour.
 */
export function stamp(at: number = Date.now(), tzOffsetMinutes?: number): LocalStamp {
  // getTimezoneOffset() is minutes to add to LOCAL to get UTC, i.e. inverted.
  const off = tzOffsetMinutes ?? -new Date(at).getTimezoneOffset();
  const shifted = new Date(at + off * 60_000);
  return {
    occurredAt: at,
    localDate: `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`,
    localTime: `${p2(shifted.getUTCHours())}:${p2(shifted.getUTCMinutes())}`,
    tzOffsetMinutes: off,
  };
}

/** The local date 'today' is in, for report queries. */
export function todayLocal(at: number = Date.now(), tzOffsetMinutes?: number): string {
  return stamp(at, tzOffsetMinutes).localDate;
}

/**
 * Vials print MM/YYYY and are usable THROUGH that month, so the stored expiry
 * is the LAST day of the printed month. Storing the 1st would write off a whole
 * lot 30 days early, every single time - real money and a real stock-out.
 */
export function expiryFromMonth(year: number, month1to12: number): string {
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return `${year}-${p2(month1to12)}-${p2(lastDay)}`;
}

/** Display an expiry back as the clinician sees it on the vial. */
export function expiryToMonthLabel(expiryDate: string): string {
  const [y, m] = expiryDate.split('-');
  return `${m}/${y}`;
}

/**
 * Age, in the clinic's own resolution: weeks up to six months, months up to
 * two years, then years and months. Same rule and format as clinic-queue's
 * age-format.ts, so the doctor reads one age format in both apps. `11 w` and
 * `4 y 8 m` are different appointments; a year is the wrong unit for a
 * paediatric register.
 *
 * Both arguments are local calendar dates - the strings the ledger already
 * stores as `local_date` - so the age on a dose never moves with the phone's
 * timezone. Null, never "0 w", when there is no answer: "0 w" means born today.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatAge(dob: string | null, onLocalDate: string): string | null {
  // Only the wheel writes dob, but pulled and restored rows do not pass
  // through it, and '26-07-2026' would otherwise read as "2000 y 1 m".
  if (!dob || !ISO_DATE.test(dob) || !ISO_DATE.test(onLocalDate)) return null;
  const [y1, m1, d1] = dob.split('-').map(Number);
  const [y2, m2, d2] = onLocalDate.split('-').map(Number);
  // UTC on both sides, so a daylight-saving hour cannot shave a day off.
  const days = (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000;
  if (!(days >= 0)) return null; // unreadable, or born after the dose: a typo, not an age
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  // Weeks count from the date, not from months: a month is not four weeks.
  if (months < 6) return `${Math.floor(days / 7)} w`;
  if (months < 24) return `${months} m`;
  const years = Math.floor(months / 12);
  return months % 12 ? `${years} y ${months % 12} m` : `${years} y`;
}

/** 'YYYY-MM-DD', or null when the parts are not a real date (31 Feb). */
export function dateFromParts(year: number, month1to12: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month1to12 - 1, day));
  if (d.getUTCMonth() !== month1to12 - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${p2(month1to12)}-${p2(day)}`;
}

/** The local date N days before `at`, for usage windows and backup nags. */
export function daysAgoLocal(days: number, at: number = Date.now(), tzOffsetMinutes?: number): string {
  return stamp(at - days * 86_400_000, tzOffsetMinutes).localDate;
}

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;
export const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const;

/**
 * Formatted by hand rather than with toLocaleDateString.
 *
 * Intl output differs between Node's full ICU and Android's Hermes build (Node
 * renders 'Sept', Hermes may render 'Sep'), which makes it both untestable in
 * CI and inconsistent on the device. Explicit tables are deterministic.
 */
export function formatDate(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "Sun 6 Sep" - short, unambiguous, and no year to read past. */
export function formatDayLabel(at: number = Date.now()): string {
  const d = new Date(at);
  return `${WEEKDAYS[d.getDay()]} ${formatDate(at)}`;
}

export function formatTime12h(localTime: string): string {
  const [hStr, m] = localTime.split(':');
  const h = Number(hStr);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}
