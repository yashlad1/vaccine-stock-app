/** The iPhone dashboard's money arithmetic (web/money.js), in plain Node. */
const Money = require('../../web/money.js');

const dose = (local_date: string, n: number, price_rupees: number | string | null) => ({
  local_date, delta_doses: -n, price_rupees,
});

describe('dashboard money', () => {
  it('does not count a null stamp as zero rupees', () => {
    const t = Money.tally([dose('2026-11-02', 3, null), dose('2026-11-03', 2, 100)], '2026-11-02', '2026-11-08');
    expect(t).toEqual({ doses: 5, priced: 2, unpriced: 3, value: 200 });
  });

  it('counts a UIP dose stamped 0 as a real zero, priced, not unpriced', () => {
    const t = Money.tally([dose('2026-11-02', 4, 0)], '2026-11-02', '2026-11-08');
    expect(t).toEqual({ doses: 4, priced: 4, unpriced: 0, value: 0 });
  });

  it('keeps priced and unpriced apart within one period', () => {
    const rows = [dose('2026-11-02', 1, 250), dose('2026-11-04', 2, 0), dose('2026-11-05', 5, null), dose('2026-11-06', 1, '300')];
    expect(Money.tally(rows, '2026-11-02', '2026-11-08')).toEqual({ doses: 9, priced: 4, unpriced: 5, value: 550 });
  });

  it('an all-unpriced year has no value and every dose unpriced', () => {
    const rows = [dose('2026-11-02', 3, null), dose('2026-10-05', 7, null)];
    const s = Money.series(rows, '2026-11-08', 'month', 12);
    expect(s.reduce((n: number, p: any) => n + p.priced, 0)).toBe(0);
    expect(s.reduce((n: number, p: any) => n + p.value, 0)).toBe(0);
    expect(s.reduce((n: number, p: any) => n + p.unpriced, 0)).toBe(10);
  });

  it('shows a percent only from 20 doses', () => {
    expect(Money.share(2, 3)).toBeNull();
    expect(Money.share(19, 19)).toBeNull();
    expect(Money.share(10, 20)).toBe(50);
  });

  it('groups weeks from Monday and months from the 1st', () => {
    expect(Money.periodStart('2026-11-08', 'week')).toBe('2026-11-02');
    expect(Money.periodStart('2026-11-08', 'month')).toBe('2026-11-01');
    expect(Money.periodEnd('2026-02-01', 'month')).toBe('2026-02-28');
    expect(Money.recentPeriods('2026-11-08', 'week', 3)).toEqual(['2026-11-02', '2026-10-26', '2026-10-19']);
  });

  it('formats rupees in Indian grouping', () => {
    expect(Money.rupees(123450)).toBe('₹1,23,450');
    expect(Money.rupees(0)).toBe('₹0');
  });

  it('compares a running period over the same days, neutrally', () => {
    const rows = [dose('2026-10-02', 10, null), dose('2026-10-25', 30, null), dose('2026-11-03', 15, null)];
    // 1-8 Nov so far (15) against 1-8 Oct (10), not all of October (40)
    expect(Money.compare(rows, '2026-11-08', 'month', '2026-11-01', '2026-01-01')).toBe('5 more than the same days last month');
    expect(Money.compare(rows, '2026-11-08', 'month', '2026-11-01', '2026-11-01')).toBeNull();
  });
});
