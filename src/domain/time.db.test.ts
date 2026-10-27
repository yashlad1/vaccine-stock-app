import { stamp, todayLocal, expiryFromMonth, expiryToMonthLabel, formatTime12h, formatAge, dateFromParts, addDays, daysBetween, formatLocalDate } from './time';

const IST = 330;

describe('local date stamping', () => {
  it('stamps IST local date and time from a UTC instant', () => {
    // 2026-09-06 18:45 UTC == 2026-09-07 00:15 IST
    const s = stamp(Date.UTC(2026, 8, 6, 18, 45), IST);
    expect(s.localDate).toBe('2026-09-07');
    expect(s.localTime).toBe('00:15');
    expect(s.tzOffsetMinutes).toBe(IST);
  });

  it('does not shift the local date at midnight IST', () => {
    // 18:29:59 UTC is still 23:59 IST on the 6th; one minute later it is the 7th.
    expect(stamp(Date.UTC(2026, 8, 6, 18, 29), IST).localDate).toBe('2026-09-06');
    expect(stamp(Date.UTC(2026, 8, 6, 18, 30), IST).localDate).toBe('2026-09-07');
  });

  it('is immune to the device timezone changing after the write', () => {
    // The same instant, stamped once in IST. Re-reading it later from a phone
    // set to UTC must not move the row to a different day - which is exactly
    // why local_date is stored rather than computed at query time.
    const at = Date.UTC(2026, 8, 6, 20, 0);
    const written = stamp(at, IST);
    const recomputedElsewhere = stamp(at, 0);
    expect(written.localDate).toBe('2026-09-07');
    expect(recomputedElsewhere.localDate).toBe('2026-09-06');
    // The stored value is the one that counts; it never changes.
    expect(written.localDate).not.toBe(recomputedElsewhere.localDate);
  });

  it('todayLocal agrees with stamp', () => {
    const at = Date.UTC(2026, 8, 6, 5, 0);
    expect(todayLocal(at, IST)).toBe(stamp(at, IST).localDate);
  });
});

describe('expiry is the LAST day of the printed month', () => {
  it.each([
    [2027, 3, '2027-03-31'],
    [2027, 2, '2027-02-28'],
    [2028, 2, '2028-02-29'], // leap year
    [2026, 12, '2026-12-31'],
    [2027, 4, '2027-04-30'],
  ])('%s/%s -> %s', (y, m, expected) => {
    expect(expiryFromMonth(y, m)).toBe(expected);
  });

  it('a vial printed 03/2027 is still usable on 2027-03-15', () => {
    const expiry = expiryFromMonth(2027, 3);
    // Storing 2027-03-01 instead would write the lot off 30 days early.
    expect(expiry > '2027-03-15').toBe(true);
  });

  it('round-trips back to the label on the vial', () => {
    expect(expiryToMonthLabel(expiryFromMonth(2027, 3))).toBe('03/2027');
  });
});

describe('12-hour time display', () => {
  it.each([
    ['00:15', '12:15 am'],
    ['09:05', '9:05 am'],
    ['12:00', '12:00 pm'],
    ['13:30', '1:30 pm'],
    ['23:59', '11:59 pm'],
  ])('%s -> %s', (input, expected) => {
    expect(formatTime12h(input)).toBe(expected);
  });
});

describe('age, in the clinic resolution', () => {
  it('counts weeks from the date under six months, not from months', () => {
    // 77 days is exactly eleven weeks. Assembled from months it came out as 10.
    expect(formatAge('2026-07-31', '2026-10-16')).toBe('11 w');
    expect(formatAge('2026-10-16', '2026-10-16')).toBe('0 w');
    expect(formatAge('2026-09-04', '2026-10-16')).toBe('6 w');
  });

  it('switches to months at six months, and to years and months at two', () => {
    expect(formatAge('2026-04-16', '2026-10-16')).toBe('6 m');
    expect(formatAge('2026-04-17', '2026-10-16')).toBe('26 w'); // 182 days, one short of six months
    expect(formatAge('2024-10-17', '2026-10-16')).toBe('23 m');
    expect(formatAge('2024-10-16', '2026-10-16')).toBe('2 y');
    expect(formatAge('2022-02-10', '2026-10-16')).toBe('4 y 8 m');
  });

  it('is blank, never "0 w", without a usable date of birth', () => {
    expect(formatAge(null, '2026-10-16')).toBeNull();
    expect(formatAge('2026-10-17', '2026-10-16')).toBeNull();
    expect(formatAge('garbage', '2026-10-16')).toBeNull();
    expect(formatAge('26-07-2026', '2026-09-06')).toBeNull(); // not "2000 y 1 m"
  });

  it('counts a month as complete on the same day-of-month, as clinic-queue does', () => {
    // Deliberate, so it is pinned: born 31 Mar has no 30 Sep anniversary,
    // so it is still weeks that day and becomes "6 m" on 1 Oct.
    expect(formatAge('2026-03-31', '2026-09-30')).toBe('26 w');
    expect(formatAge('2026-03-31', '2026-10-01')).toBe('6 m');
    expect(formatAge('2024-02-29', '2026-02-28')).toBe('23 m');
    expect(formatAge('2024-02-29', '2026-03-01')).toBe('2 y');
  });

  it('refuses dates that do not exist', () => {
    expect(dateFromParts(2026, 2, 31)).toBeNull();
    expect(dateFromParts(2023, 2, 29)).toBeNull();
    expect(dateFromParts(2024, 2, 29)).toBe('2024-02-29');
    expect(dateFromParts(2026, 7, 3)).toBe('2026-07-03');
  });
});

describe('addDays', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-02-29', 1, '2028-03-01'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-09-06', 0, '2026-09-06'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-09-06', -56, '2026-07-12'],
    ['2026-09-06', 60, '2026-11-05'],
  ])('%s plus %i days is %s', (from, n, expected) => {
    expect(addDays(from, n)).toBe(expected);
  });
});

describe('daysBetween', () => {
  it.each([
    ['2026-09-06', '2026-09-06', 0],
    ['2026-09-06', '2026-09-07', 1],
    ['2026-12-31', '2027-01-01', 1],
    ['2028-02-28', '2028-03-01', 2],
    ['2027-02-28', '2027-03-01', 1],
    ['2026-01-01', '2027-01-01', 365],
    ['2028-01-01', '2029-01-01', 366],
    ['2026-09-07', '2026-09-06', -1],
    ['2026-09-06', '2026-07-12', -56],
  ])('from %s to %s is %i days', (a, b, expected) => {
    expect(daysBetween(a, b)).toBe(expected);
  });
});

describe('formatLocalDate', () => {
  it.each([
    ['2026-09-06', '6 Sep'],
    ['2026-01-05', '5 Jan'],
    ['2028-02-29', '29 Feb'],
    ['2026-12-31', '31 Dec'],
  ])('formats %s as %s', (date, expected) => {
    expect(formatLocalDate(date)).toBe(expected);
  });
});
