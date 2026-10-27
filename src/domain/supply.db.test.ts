import { makeTestDb, actions, T0 } from '../db/testing';
import { findOrCreateLot } from '../db/repo/lots';
import { removeVaccine, deactivateVaccine } from '../db/repo/catalog';
import { recordReceipt, recordAdministration, reverseMovement } from './ledger';
import type { StockRow } from './types';
import {
  loadLedger, usageRate, daysOut, stockOuts, lastsLabel, suggestOrder, orderList, expiringLots,
  type Ledger,
} from './supply';

// T0 is 6 Sep 2026, 10:30 IST. Offset 0 is today; -1 is 5 Sep. The rate window
// is offsets -56..-1 (12 Jul..5 Sep).
const TODAY = '2026-09-06';
const DAY = 24 * 3600_000;
const mk = (n: string, extra: Record<string, unknown> = {}) => ({
  name: n, unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 0, ...extra,
});

async function env(names: string[]) {
  const e = await makeTestDb({ seed: names.map((n) => mk(n)) });
  const ids: Record<string, string> = {};
  for (const n of names) ids[n] = await e.vaccineId(n);
  const next = actions();
  const at = (off: number) => ({ ...e.ctx, now: T0 + off * DAY });
  const lots: Record<string, string> = {};
  const lot = async (vac: string, num = 'L1', expiry: string | null = null) => {
    const k = `${vac}|${num}`;
    return (lots[k] ??= await findOrCreateLot(e.db, { vaccineId: ids[vac], lotNumber: num, expiryDate: expiry }, 'test-device', T0));
  };
  const receive = async (vac: string, doses: number, off: number, lotId?: string) =>
    (await recordReceipt(e.db, at(off), { clientActionId: next(), vaccineId: ids[vac], lotId: lotId ?? (await lot(vac)), doses })).movement;
  const give = async (vac: string, doses: number, off: number, lotId: string | null = null) =>
    (await recordAdministration(e.db, at(off), { clientActionId: next(), vaccineId: ids[vac], lotId, doses })).movement;
  const reverse = (movementId: string, off: number) =>
    reverseMovement(e.db, at(off), { clientActionId: next(), movementId });
  /** `perDay` doses every day of the window, from a big receipt before it. */
  const steady = async (vac: string, perDay: number) => {
    await receive(vac, 1000, -60);
    for (let off = -56; off <= -1; off++) await give(vac, perDay, off);
  };
  return { ...e, ids, receive, give, reverse, steady, lot, ledger: () => loadLedger(e.db) };
}

describe('usageRate', () => {
  it('counts a vaccine in stock all window at its daily use', async () => {
    const t = await env(['A']);
    await t.steady('A', 2);
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBe(2); // 112 doses / 56 days
  });

  it('gives the same rate when out of stock for half the window', async () => {
    const t = await env(['A']);
    await t.receive('A', 56, -60);
    for (let off = -56; off <= -29; off++) await t.give('A', 2, off); // empties on -29
    // 56 doses over the 28 in-stock days; -28..-1 are out.
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBe(2);
  });

  it('is null below 4 doses in the window', async () => {
    const t = await env(['A']);
    await t.receive('A', 100, -30);
    await t.give('A', 3, -5);
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBeNull();
  });

  it('is a rate at exactly 4 doses: 4 doses over the 10 in-stock days', async () => {
    const t = await env(['A']);
    await t.receive('A', 10, -10); // in stock -10..-1
    await t.give('A', 4, -5);
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBeCloseTo(0.4, 10);
  });

  it('does not count a reversed dose', async () => {
    const t = await env(['A']);
    await t.receive('A', 100, -30);
    for (const off of [-5, -4, -3]) await t.give('A', 1, off);
    const last = await t.give('A', 1, -2);
    await t.reverse(last.id, -2); // 3 effective doses
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBeNull();
  });

  it('excludes today', async () => {
    const t = await env(['A']);
    await t.receive('A', 50, -10);
    await t.give('A', 4, 0);
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBeNull();
  });

  it('excludes doses older than the 56-day window', async () => {
    const t = await env(['A']);
    await t.receive('A', 50, -60);
    await t.give('A', 4, -57);
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBeNull();
  });

  it('counts a day that starts at 0, receives stock and gives a dose as in stock', async () => {
    const t = await env(['A']);
    await t.receive('A', 4, -3);
    await t.give('A', 4, -3); // ends at 0 too, only the dose says it was in stock
    expect(usageRate(await t.ledger(), t.ids.A, TODAY)).toBe(4); // 4 doses / 1 day
  });
});

describe('daysOut', () => {
  it('counts nothing for a vaccine that was never stocked: it did not run out', async () => {
    const t = await env(['A']);
    expect(daysOut(await t.ledger(), t.ids.A, '2026-09-01', '2026-09-05')).toBe(0);
  });

  it('starts counting at the first delivery, not the start of the period', async () => {
    const t = await env(['A']);
    await t.receive('A', 1, -3); // 3 Sep, first entry ever
    await t.give('A', 1, -3); // runs out the same day
    // 1 and 2 Sep were before it was stocked; 3 Sep in stock; 4 and 5 Sep out.
    expect(daysOut(await t.ledger(), t.ids.A, '2026-09-01', '2026-09-05')).toBe(2);
  });

  it('does not count the day the last dose was given', async () => {
    const t = await env(['A']);
    await t.receive('A', 2, -5); // 1 Sep
    await t.give('A', 2, -4); // 2 Sep, runs out
    // 1 Sep and 2 Sep in stock; 3, 4, 5 Sep out.
    expect(daysOut(await t.ledger(), t.ids.A, '2026-09-01', '2026-09-05')).toBe(3);
  });

  it('counts a negative balance with no dose given as out', async () => {
    const t = await env(['A']);
    await t.give('A', 1, -5); // 1 Sep: given, balance -1
    // 2 and 3 Sep open and close at -1 with nothing given.
    expect(daysOut(await t.ledger(), t.ids.A, '2026-09-01', '2026-09-03')).toBe(2);
  });

  it('carries the balance in from before the period', async () => {
    const t = await env(['A']);
    await t.receive('A', 10, -17); // 20 Aug
    expect(daysOut(await t.ledger(), t.ids.A, '2026-09-01', '2026-09-05')).toBe(0);
  });
});

describe('stockOuts', () => {
  async function setup() {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
    const t = await env(names);
    // Ran out on 30 Aug and never restocked: out every day of 1-5 Sep.
    for (const n of ['Alpha', 'Delta', 'Echo']) {
      await t.receive(n, 1, -7);
      await t.give(n, 1, -7);
    }
    // First stocked on 3 Sep and used up that day: out 4 and 5 Sep. 1 and 2 Sep
    // were before it was ever stocked, which is not running out.
    for (const n of ['Beta', 'Gamma']) {
      await t.receive(n, 1, -3);
      await t.give(n, 1, -3);
    }
    await t.receive('Foxtrot', 0 + 1, -70); // never given, balance 1: not out
    await t.receive('Golf', 1, -100);
    await t.give('Golf', 1, -97); // 1 Jun: before the 56 days ahead of 1 Sep (7 Jul)
    await t.receive('Hotel', 1, -60);
    await t.give('Hotel', 1, -58); // 10 Jul: inside those 56 days
    await removeVaccine(t.db, t.ids.Delta, T0);
    await deactivateVaccine(t.db, t.ids.Echo, T0);
    return t;
  }

  it('sorts by days out descending, then by name, with only vaccines in use', async () => {
    const t = await setup();
    const r = stockOuts(await t.ledger(), '2026-09-01', '2026-09-05', TODAY);
    expect(r.map((x) => [x.name, x.days])).toEqual([
      ['Alpha', 5], ['Hotel', 5], ['Beta', 2], ['Gamma', 2],
    ]);
  });

  it('cuts the end of the period at today', async () => {
    const t = await setup();
    const r = stockOuts(await t.ledger(), '2026-09-01', '2026-09-20', TODAY);
    expect(r.find((x) => x.name === 'Alpha')!.days).toBe(6); // 1 to 6 Sep
  });

  it('is empty when the period starts after today', async () => {
    const t = await setup();
    expect(stockOuts(await t.ledger(), '2026-09-10', '2026-09-20', TODAY)).toEqual([]);
  });
});

describe('lastsLabel', () => {
  it.each([
    [10, 2, 'Lasts under a week'], // 5 days
    [13, 2, 'Lasts under a week'], // 6.5 days
    [14, 2, 'Lasts about 1 week'], // 7 days
    [27, 2, 'Lasts about 1 week'], // 13.5 days
    [28, 2, 'Lasts about 2 weeks'], // 14 days
    [112, 2, 'Lasts about 8 weeks'], // 56 days
    [114, 2, 'Lasts more than 8 weeks'], // 57 days
  ])('%i on hand at %f a day: %s', (onHand, perDay, label) => {
    expect(lastsLabel(onHand, perDay)).toBe(label);
  });

  it('says it cannot tell when there is no rate', () => {
    expect(lastsLabel(10, null)).toBe('Not used enough to tell');
  });

  it.each([[0, 2], [-3, 2], [0, null]])('is null at %i on hand (rate %s)', (onHand, perDay) => {
    expect(lastsLabel(onHand, perDay)).toBeNull();
  });
});

const row = (o: Partial<StockRow> & { on_hand_doses: number }): StockRow => ({
  vaccine_id: 'v', name: 'X', generic_name: null, aliases: null, unit_mode: 'DOSE',
  doses_per_vial: 1, min_balance_doses: 0, is_active: 1, ...o,
}) as StockRow;

describe('suggestOrder', () => {
  it('flags a negative count, orders nothing, even with no rate', () => {
    const l = suggestOrder(row({ on_hand_doses: -3 }), null)!;
    expect(l.belowZero).toBe(true);
    expect(l.order).toBe(0);
  });

  it('is null with no rate', () => {
    expect(suggestOrder(row({ on_hand_doses: 5 }), null)).toBeNull();
  });

  it('is null with enough stock above the safety limit', () => {
    expect(suggestOrder(row({ on_hand_doses: 40, min_balance_doses: 10 }), 2)).toBeNull(); // 20 days
  });

  it('is null at exactly 14 days left', () => {
    expect(suggestOrder(row({ on_hand_doses: 28, min_balance_doses: 5 }), 2)).toBeNull();
  });

  it('orders up to 28 days when under 14 days are left', () => {
    const l = suggestOrder(row({ on_hand_doses: 20, min_balance_doses: 5 }), 2)!;
    expect(l.order).toBe(36); // 56 - 20
    expect(l.belowZero).toBe(false);
  });

  it('is due at the safety limit even with 15 days left', () => {
    const l = suggestOrder(row({ on_hand_doses: 30, min_balance_doses: 30 }), 2)!;
    expect(l.order).toBe(26); // 56 - 30
  });

  it('rounds a need of 13 up to 20 for 10-dose vials', () => {
    const l = suggestOrder(row({ on_hand_doses: 15, min_balance_doses: 15, unit_mode: 'VIAL', doses_per_vial: 10 }), 1)!;
    expect(l.order).toBe(20); // 28 - 15 = 13
  });

  it('does not round in dose mode', () => {
    const l = suggestOrder(row({ on_hand_doses: 15, min_balance_doses: 15, doses_per_vial: 10 }), 1)!;
    expect(l.order).toBe(13);
  });

  it('rounds the need for a fraction of a dose a day up to whole doses', () => {
    const l = suggestOrder(row({ on_hand_doses: 0 }), 0.3)!;
    expect(l.order).toBe(9); // ceil(8.4)
  });
});

describe('orderList', () => {
  // Hand-built ledger: 1000 in stock before the window, then `rate` doses a
  // day in total, so the rate is exactly `rate`.
  const ledgerOf = (rates: Record<string, number>): Ledger => ({
    names: new Map(),
    days: new Map(
      Object.entries(rates).map(([id, r]) => [
        id,
        [
          { local_date: '2026-07-01', delta: 1000, given: 0 },
          { local_date: '2026-08-01', delta: -r * 56, given: r * 56 },
        ],
      ]),
    ),
  });

  it('lists below zero first, then soonest to run out, skipping what is not due or inactive', () => {
    const rows = [
      row({ vaccine_id: 'alpha', name: 'Alpha', on_hand_doses: 10 }), // rate 1: 10 days
      row({ vaccine_id: 'beta', name: 'Beta', on_hand_doses: 10 }), // rate 2: 5 days
      row({ vaccine_id: 'zeta', name: 'Zeta', on_hand_doses: -5 }),
      row({ vaccine_id: 'gamma', name: 'Gamma', on_hand_doses: -1 }),
      row({ vaccine_id: 'fine', name: 'Fine', on_hand_doses: 100 }), // rate 1: 100 days
      row({ vaccine_id: 'off', name: 'Off', on_hand_doses: -1, is_active: 0 }),
    ];
    const lines = orderList(rows, ledgerOf({ alpha: 1, beta: 2, fine: 1 }), TODAY);
    expect(lines.map((l) => [l.name, l.order])).toEqual([
      ['Gamma', 0], ['Zeta', 0], ['Beta', 46], ['Alpha', 18],
    ]);
  });
});

describe('expiringLots', () => {
  it('counts the expiry day as usable, and first expiry used first', async () => {
    const t = await env(['A']);
    await t.steady('A', 1);
    const a = await t.lot('A', 'A1', '2026-09-26'); // 20 days
    const b = await t.lot('A', 'B1', '2026-10-06'); // 30 days
    const c = await t.lot('A', 'C1', '2026-09-01'); // expired
    await t.receive('A', 30, -60, a);
    await t.receive('A', 40, -60, b);
    await t.receive('A', 5, -60, c);
    const r = await expiringLots(t.db, await t.ledger(), TODAY);
    expect(r.map((x) => x.lot_number)).toEqual(['C1', 'A1', 'B1']);
    expect(r[0]).toMatchObject({ expired: true, mayWaste: 5, onHand: 5 });
    // 1 a day reaches 21 doses by the end of the 20th day: 30 - 21 = 9 wasted.
    expect(r[1]).toMatchObject({ expired: false, mayWaste: 9 });
    // Batch A takes the first 30 doses, so by day 30 (31 doses) only 1 is left for B.
    expect(r[2]).toMatchObject({ expired: false, mayWaste: 39 });
  });

  it('treats a batch expiring today as usable today', async () => {
    const t = await env(['A']);
    await t.steady('A', 1);
    await t.receive('A', 5, -60, await t.lot('A', 'T1', TODAY));
    const [l] = await expiringLots(t.db, await t.ledger(), TODAY);
    expect(l).toMatchObject({ expired: false, mayWaste: 4 }); // 1 dose today
  });

  it('is null at an unknown rate, includes day 60, and leaves out day 61, empty, undated, removed and inactive batches', async () => {
    const t = await env(['A', 'Gone', 'Off']);
    await t.receive('A', 3, -60, await t.lot('A', 'D60', '2026-11-05'));
    await t.receive('A', 3, -60, await t.lot('A', 'D61', '2026-11-06'));
    await t.receive('A', 3, -60, await t.lot('A', 'NOEXP'));
    const empty = await t.lot('A', 'EMPTY', '2026-09-20');
    await t.receive('A', 5, -60, empty);
    await t.give('A', 5, 0, empty); // today: out of the rate window, batch is now empty
    await t.receive('Gone', 5, -60, await t.lot('Gone', 'G1', '2026-09-20'));
    await t.receive('Off', 5, -60, await t.lot('Off', 'O1', '2026-09-20'));
    await removeVaccine(t.db, t.ids.Gone, T0);
    await deactivateVaccine(t.db, t.ids.Off, T0);
    const r = await expiringLots(t.db, await t.ledger(), TODAY);
    expect(r.map((x) => [x.lot_number, x.mayWaste])).toEqual([['D60', null]]);
  });
});
