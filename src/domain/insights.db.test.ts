import { actions, makeTestDb, type TestEnv } from '../db/testing';
import { createPatient, type Sex } from '../db/repo/patients';
import { insertVaccine, removeVaccine, setVaccinePrice } from '../db/repo/catalog';
import { findOrCreateLot } from '../db/repo/lots';
import { recordAdministration, reverseMovement } from './ledger';
import { addDays } from './time';
import {
  ageGroup,
  compareWithPrevious,
  comparisonLabel,
  dosesSince,
  percent,
  periodEnd,
  periodStart,
  recentPeriods,
  series,
  summarise,
  windowStart,
  type InsightDose,
} from './insights';

const row = (local_date: string, doses = 1): InsightDose => ({
  local_date, vaccine_id: 'v', vaccine_name: 'V', doses, dob: null, sex: null, price: null,
});

describe('periodStart', () => {
  it('maps a Sunday to the previous Monday and a Monday to itself', () => {
    expect(periodStart('2026-10-25', 'week')).toBe('2026-10-19'); // Sunday
    expect(periodStart('2026-10-26', 'week')).toBe('2026-10-26'); // Monday
    expect(periodStart('2026-10-31', 'week')).toBe('2026-10-26'); // Saturday
  });
  it('crosses a year boundary', () => {
    expect(periodStart('2026-01-01', 'week')).toBe('2025-12-29'); // Thursday
  });
  it('maps a month to its 1st', () => {
    expect(periodStart('2026-10-27', 'month')).toBe('2026-10-01');
  });
});

describe('recentPeriods', () => {
  it('steps months across a year boundary, oldest first', () => {
    expect(recentPeriods('2026-02-14', 'month', 4)).toEqual(
      ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });
  it('steps weeks by 7 days and ends on today\'s week', () => {
    expect(recentPeriods('2026-10-27', 'week', 3)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });
});

describe('series', () => {
  it('zero-fills empty periods and ignores rows outside them', () => {
    const periods = recentPeriods('2026-10-27', 'week', 3);
    const out = series(
      [row('2026-10-27', 2), row('2026-10-28'), row('2026-10-12'), row('2026-10-11', 9), row('2026-11-02', 9)],
      'week', periods);
    expect(out.map((t) => t.doses)).toEqual([1, 0, 3]);
    expect(out.map((t) => t.key)).toEqual(periods);
  });
});

describe('ageGroup', () => {
  it.each([
    ['2026-03-01', '2026-08-31', 'u6m'],     // 5 months 30 days
    ['2026-03-01', '2026-09-01', '6-11m'],   // exactly 6 months
    ['2024-09-15', '2026-08-15', '1y'],      // 23 months
    ['2024-09-15', '2026-09-15', '2-4y'],    // exactly 24 months
    ['2016-09-16', '2026-09-15', '5-9y'],    // 119 months
    ['2016-09-15', '2026-09-15', '10y'],     // exactly 10 years
  ])('dob %s on %s is %s', (dob, on, want) => {
    expect(ageGroup(dob, on)).toBe(want);
  });
  it('is null without a usable date of birth', () => {
    expect(ageGroup(null, '2026-09-15')).toBeNull();
    expect(ageGroup('garbage', '2026-09-15')).toBeNull();
    expect(ageGroup('2026-09-16', '2026-09-15')).toBeNull();
  });
});

describe('percent', () => {
  it('is 0 for an empty whole', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(1, 3)).toBe(33);
  });
});

describe('summarise over a real ledger', () => {
  let env: TestEnv;
  const act = actions('i');
  const at = (y: number, m: number, d: number) => ({ ...env.ctx, now: Date.UTC(y, m - 1, d, 6) });
  const WEEK = '2026-10-26';

  async function child(name: string, dob: string, sex: Sex) {
    return createPatient(env.db, { name, dob, sex }, 'test-device');
  }

  beforeEach(async () => {
    env = await makeTestDb({
      seed: ['BCG', 'Pentavac', 'Old'].map((name) => ({
        name, unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 0,
      })),
    });
  });

  async function fill() {
    const bcg = await env.vaccineId('BCG');
    const penta = await env.vaccineId('Pentavac');
    const old = await env.vaccineId('Old');
    const girl = await child('Girl', '2026-07-01', 'F'); // 3 months on 27 Oct
    const boy = await child('Boy', '2016-01-01', 'M');   // 10 years

    const undone = await recordAdministration(env.db, at(2026, 10, 27), {
      clientActionId: act(), vaccineId: bcg, patientId: girl });
    await reverseMovement(env.db, at(2026, 10, 27), { clientActionId: act(), movementId: undone.movement.id });
    await recordAdministration(env.db, at(2026, 10, 27), { clientActionId: act(), vaccineId: bcg, patientId: girl });
    await recordAdministration(env.db, at(2026, 10, 28), { clientActionId: act(), vaccineId: penta, patientId: boy, doses: 2 });
    await recordAdministration(env.db, at(2026, 10, 28), { clientActionId: act(), vaccineId: penta, patientLabel: 'Typed Only' });
    await recordAdministration(env.db, at(2026, 10, 27), { clientActionId: act(), vaccineId: old, patientId: girl });
    await removeVaccine(env.db, old, env.ctx.now);
    // Previous week: must not appear in this period.
    await recordAdministration(env.db, at(2026, 10, 20), { clientActionId: act(), vaccineId: bcg, patientId: girl });
    return { bcg, penta };
  }

  it('counts effective doses of the period, including removed vaccines', async () => {
    await fill();
    const s = summarise(await dosesSince(env.db, '2026-10-01'), { grain: 'week', period: WEEK });
    expect(s.total).toBe(5);
    expect(s.byVaccine.map((v) => [v.label, v.doses])).toEqual([['Pentavac', 3], ['BCG', 1], ['Old', 1]]);
  });

  it('lists every age band in order and appends Not recorded only when needed', async () => {
    await fill();
    const s = summarise(await dosesSince(env.db, '2026-10-01'), { grain: 'week', period: WEEK });
    expect(s.byAge.map((t) => [t.key, t.doses])).toEqual([
      ['u6m', 2], ['6-11m', 0], ['1y', 0], ['2-4y', 0], ['5-9y', 0], ['10y', 2], ['unknown', 1]]);
    expect(s.bySex.map((t) => [t.label, t.doses])).toEqual([['Boys', 2], ['Girls', 2], ['Not recorded', 1]]);

    const empty = summarise([], { grain: 'week', period: WEEK });
    expect(empty.byAge).toHaveLength(6);
    expect(empty.bySex.map((t) => t.key)).toEqual(['M', 'F']);
  });

  it('narrows age and sex to one vaccine', async () => {
    await fill();
    const s = summarise(await dosesSince(env.db, '2026-10-01'), { grain: 'week', period: WEEK, vaccine: 'pentavac' });
    expect(s.total).toBe(3);
    expect(s.byAge.filter((t) => t.doses).map((t) => [t.key, t.doses])).toEqual([['10y', 2], ['unknown', 1]]);
    expect(s.bySex.map((t) => [t.key, t.doses])).toEqual([['M', 2], ['F', 0], ['unknown', 1]]);
  });
});

describe('periodEnd and windowStart', () => {
  it('ends a week on its Sunday and a month on its last day', () => {
    expect(periodEnd('2026-10-26', 'week')).toBe('2026-11-01');
    expect(periodEnd('2026-02-01', 'month')).toBe('2026-02-28');
    expect(periodEnd('2026-12-01', 'month')).toBe('2026-12-31');
  });
  it('loads twelve months, which covers twelve weeks and the week before them', () => {
    expect(windowStart('2026-10-27')).toBe('2025-11-01');
    const oldestWeek = recentPeriods('2026-10-27', 'week', 12)[0];
    expect(oldestWeek > windowStart('2026-10-27')).toBe(true);
  });
});

describe('compareWithPrevious', () => {
  const FROM = '2025-11-01';
  /** `n` doses on every day from `from` to `to`. */
  const days = (from: string, to: string, n = 1) => {
    const out: InsightDose[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(row(d, n));
    return out;
  };

  it('compares a month still running with the SAME days of the month before', () => {
    // 1 dose a day all of September, 2 a day so far in October (1-14).
    const rows = [...days('2026-09-01', '2026-09-30'), ...days('2026-10-01', '2026-10-14', 2)];
    const c = compareWithPrevious(rows, { grain: 'month', period: '2026-10-01', today: '2026-10-14', from: FROM });
    expect(c).toEqual({ current: 28, previous: 14, soFar: true }); // not 28 against 30
    expect(comparisonLabel(c!, 'month')).toBe('14 more than the same days last month');
  });

  it('compares a week still running with the same weekdays of the week before', () => {
    // Today is Wednesday 28 Oct: Mon-Wed of both weeks, not the whole last week.
    const rows = [...days('2026-10-19', '2026-10-25'), ...days('2026-10-26', '2026-10-28')];
    const c = compareWithPrevious(rows, { grain: 'week', period: '2026-10-26', today: '2026-10-28', from: FROM });
    expect(c).toEqual({ current: 3, previous: 3, soFar: true });
    expect(comparisonLabel(c!, 'week')).toBe('Same as the same days last week');
  });

  it('cuts a shorter month before at its own end', () => {
    const rows = [...days('2026-02-01', '2026-02-28'), ...days('2026-03-01', '2026-03-30')];
    const c = compareWithPrevious(rows, { grain: 'month', period: '2026-03-01', today: '2026-03-30', from: FROM });
    expect(c).toEqual({ current: 30, previous: 28, soFar: true });
  });

  it('compares a finished period with the whole period before', () => {
    const rows = [...days('2026-10-12', '2026-10-18', 2), ...days('2026-10-19', '2026-10-25')];
    const week = compareWithPrevious(rows, { grain: 'week', period: '2026-10-19', today: '2026-10-28', from: FROM });
    expect(week).toEqual({ current: 7, previous: 14, soFar: false });
    expect(comparisonLabel(week!, 'week')).toBe('7 fewer than the week before');

    const month = compareWithPrevious(
      [...days('2026-08-01', '2026-08-31'), ...days('2026-09-01', '2026-09-30')],
      { grain: 'month', period: '2026-09-01', today: '2026-10-28', from: FROM },
    );
    expect(month).toEqual({ current: 30, previous: 31, soFar: false });
    expect(comparisonLabel(month!, 'month')).toBe('1 fewer than the month before (3% fewer)');
  });

  it('says nothing when the period before had no doses', () => {
    const rows = days('2026-10-19', '2026-10-25');
    expect(compareWithPrevious(rows, { grain: 'week', period: '2026-10-19', today: '2026-10-28', from: FROM })).toBeNull();
  });

  it('says nothing when the period before starts outside the loaded rows', () => {
    const rows = days('2025-10-01', '2025-11-30');
    expect(compareWithPrevious(rows, { grain: 'month', period: '2025-11-01', today: '2026-10-28', from: FROM })).toBeNull();
  });

  it('adds a percent only when the period before had at least 20 doses', () => {
    expect(comparisonLabel({ current: 22, previous: 19, soFar: false }, 'week')).toBe('3 more than the week before');
    expect(comparisonLabel({ current: 23, previous: 20, soFar: false }, 'week')).toBe('3 more than the week before (15% more)');
    // A change too small to show as a whole percent shows none, not "(0% more)".
    expect(comparisonLabel({ current: 301, previous: 300, soFar: false }, 'month')).toBe('1 more than the month before');
  });
});

describe('one vaccine across two rows (removed, then added back)', () => {
  it('groups by name, case and spaces aside, and the filter takes every row with it', async () => {
    const env = await makeTestDb({
      seed: [{ name: 'Vaxigrip', unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 0 }],
    });
    const act = actions('n');
    const on = (d: number) => ({ ...env.ctx, now: Date.UTC(2026, 9, d, 6) });
    const old = await env.vaccineId('Vaxigrip');
    await recordAdministration(env.db, on(26), { clientActionId: act(), vaccineId: old, doses: 2 });
    await removeVaccine(env.db, old, on(26).now);
    // The documented undo for a removal: add it again, which is a new row.
    const again = await insertVaccine(
      env.db,
      { name: ' VAXIGRIP ', unit_mode: 'DOSE', doses_per_vial: 1, min_balance_doses: 0 },
      'test-device',
      on(27).now,
    );
    await recordAdministration(env.db, on(28), { clientActionId: act(), vaccineId: again, doses: 3 });

    const rows = await dosesSince(env.db, '2026-10-01');
    const s = summarise(rows, { grain: 'week', period: '2026-10-26' });
    expect(s.byVaccine).toEqual([{ key: 'vaxigrip', label: 'VAXIGRIP', doses: 5 }]);
    expect(summarise(rows, { grain: 'week', period: '2026-10-26', vaccine: 'vaxigrip' }).total).toBe(5);
  });
});

describe('sales value', () => {
  // 27 Oct 2026. Prices are whole rupees per dose.
  async function setup() {
    const env = await makeTestDb({
      seed: ['Typbar', 'Rotavac'].map((name) => ({
        name, unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 0,
      })),
    });
    const act = actions('s');
    const at = { ...env.ctx, now: Date.UTC(2026, 9, 27, 6) };
    return { env, act, at, typbar: await env.vaccineId('Typbar'), rotavac: await env.vaccineId('Rotavac') };
  }
  const week = async (db: Parameters<typeof dosesSince>[0], vaccine?: string) =>
    summarise(await dosesSince(db, '2026-10-01'), { grain: 'week', period: '2026-10-26', vaccine });

  it('values a stamped dose at its own price and an unstamped old one at today\'s', async () => {
    const { env, act, at, typbar } = await setup();
    // Given before any price existed: no stamp.
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar });
    await setVaccinePrice(env.db, typbar, 500, at.now);
    // Stamped at 500, then the price goes up.
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar, doses: 2 });
    await setVaccinePrice(env.db, typbar, 700, at.now);

    const s = await week(env.db);
    expect(s.sales).toBe(700 + 2 * 500);
    expect(s.byVaccineSales).toEqual([{ key: 'typbar', label: 'Typbar', rupees: 1700 }]);
    expect(s.unpriced).toBe(0);
  });

  it('counts a government dose as 0, which is a price, not a missing one', async () => {
    const { env, act, at, typbar } = await setup();
    await setVaccinePrice(env.db, typbar, 500, at.now);
    const uip = await findOrCreateLot(env.db, { vaccineId: typbar, lotNumber: 'UIP1', fundingSource: 'GOVT_UIP' }, 'test-device', at.now);
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar, lotId: uip });
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar });

    const s = await week(env.db);
    expect(s.sales).toBe(500);
    expect(s.unpriced).toBe(0);
  });

  it('keeps doses with no price out of the total and counts them apart, never as 0', async () => {
    const { env, act, at, typbar, rotavac } = await setup();
    await setVaccinePrice(env.db, typbar, 500, at.now);
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar });
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: rotavac, doses: 2 });

    const s = await week(env.db);
    expect(s.sales).toBe(500);
    expect(s.unpriced).toBe(2);
    expect(s.byVaccineSales.map((v) => v.key)).toEqual(['typbar']);
    expect((await week(env.db, 'rotavac')).byVaccineSales).toEqual([]);
  });

  it('does not count a dose that was undone', async () => {
    const { env, act, at, typbar } = await setup();
    await setVaccinePrice(env.db, typbar, 500, at.now);
    const d = await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar });
    await reverseMovement(env.db, at, { clientActionId: act(), movementId: d.movement.id });
    await recordAdministration(env.db, at, { clientActionId: act(), vaccineId: typbar });

    const s = await week(env.db);
    expect(s.sales).toBe(500);
    expect(s.total).toBe(1);
  });
});
