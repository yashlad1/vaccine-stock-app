/**
 * Black-box acceptance tests. Every expected value below is derived from the
 * wording of CLAUDE.md, never from reading src/. Clock frozen at T0
 * (6 Sep 2026, 10:30 IST, local_date 2026-09-06).
 */
import { actions, makeTestDb, T0, type TestEnv } from '../db/testing';
import { recordAdministration, recordAdjustment, recordOpeningBalance, recordReceipt, recordWastage, reverseMovement } from '../domain/ledger';
import { findOrCreateLot, getLot, isExpired } from '../db/repo/lots';
import { insertVaccine, listVaccines, removeVaccine, setVaccinePrice } from '../db/repo/catalog';
import { dosesGiven, stockOnHand } from '../domain/reports';
import { dosesFromVials, stockLevel } from '../domain/stock';
import { expiryFromMonth, formatAge } from '../domain/time';
import { dosesSince, summarise } from '../domain/insights';
import { countDirty, pushOnce } from '../sync/push';
import { SyncNetworkError, type PushBatch, type SyncBackend } from '../sync/backend';
import type { SeedVaccine } from '../domain/seed';

const DAY = '2026-09-06';
const SEED: SeedVaccine[] = [
  { name: 'Alpha', unit_mode: 'DOSE', doses_per_vial: 1, min_balance_doses: 5 },
  { name: 'Beta', unit_mode: 'VIAL', doses_per_vial: 10, min_balance_doses: 0 },
  { name: 'Gamma', unit_mode: 'DOSE', doses_per_vial: 1, min_balance_doses: 0 },
];

let env: TestEnv;
let act: () => string;
beforeEach(async () => {
  env = await makeTestDb({ seed: SEED });
  act = actions();
});

async function lot(name: string, lotNumber = 'L1', funding: 'PRIVATE' | 'GOVT_UIP' = 'PRIVATE', expiry: string | null = null) {
  const vaccineId = await env.vaccineId(name);
  const lotId = await findOrCreateLot(env.db, { vaccineId, lotNumber, fundingSource: funding, expiryDate: expiry }, env.ctx.deviceId, T0);
  return { vaccineId, lotId };
}
const receive = (vaccineId: string, lotId: string, doses: number) =>
  recordReceipt(env.db, env.ctx, { clientActionId: act(), vaccineId, lotId, doses });
const give = (vaccineId: string, lotId: string | null, doses = 1, occurredAt?: number) =>
  recordAdministration(env.db, env.ctx, { clientActionId: act(), vaccineId, lotId, doses, occurredAt });
const undo = (movementId: string) => reverseMovement(env.db, env.ctx, { clientActionId: act(), movementId });
async function onHand(name: string) {
  const row = (await stockOnHand(env.db)).find((r) => r.name === name);
  return row ? Number(row.on_hand_doses) : 0;
}
async function rawSum(vaccineId: string) {
  const r = await env.db.first<{ s: number | null }>(`SELECT SUM(delta_doses) AS s FROM stock_movements WHERE vaccine_id = ?`, [vaccineId]);
  return Number(r?.s ?? 0);
}

describe('1. on-hand is SUM(delta_doses) over the ledger', () => {
  test('receipts and doses: 50 + 30 - 1 - 1 - 4 = 74', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 50);
    await receive(vaccineId, lotId, 30);
    await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 4);
    expect(await onHand('Alpha')).toBe(74);
    expect(await rawSum(vaccineId)).toBe(74);
  });

  test('opening balance and wastage count: 20 + 10 - 3 = 27', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await recordOpeningBalance(env.db, env.ctx, { clientActionId: act(), vaccineId, lotId, doses: 20 });
    await receive(vaccineId, lotId, 10);
    await recordWastage(env.db, env.ctx, { clientActionId: act(), vaccineId, lotId, doses: 3, reason: 'BREAKAGE' });
    expect(await onHand('Alpha')).toBe(27);
  });

  test('stock of one vaccine never moves another vaccine', async () => {
    const a = await lot('Alpha');
    const g = await lot('Gamma');
    await receive(a.vaccineId, a.lotId, 10);
    await receive(g.vaccineId, g.lotId, 7);
    await give(g.vaccineId, g.lotId, 2);
    expect(await onHand('Alpha')).toBe(10);
    expect(await onHand('Gamma')).toBe(5);
  });

  test('stock_movements refuses a raw DELETE (append-only)', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await expect(env.db.run(`DELETE FROM stock_movements`)).rejects.toThrow();
    expect(await rawSum(vaccineId)).toBe(10);
  });

  test('stock_movements refuses a raw UPDATE of the quantity (append-only)', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await expect(env.db.run(`UPDATE stock_movements SET delta_doses = 999`)).rejects.toThrow();
    expect(await rawSum(vaccineId)).toBe(10);
  });

  test('a movement of zero doses is refused (CHECK delta_doses <> 0)', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await expect(give(vaccineId, lotId, 0)).rejects.toThrow();
  });

  test('property: 500 random movements, derived on-hand equals a naive replay', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    let model = 0;
    let givenModel = 0;
    const live: { id: string; delta: number; given: boolean }[] = [];
    for (let i = 0; i < 500; i++) {
      const pick = rnd(10);
      if (pick < 4) {
        const n = 1 + rnd(20);
        const r = await receive(vaccineId, lotId, n);
        model += n;
        live.push({ id: r.movement.id, delta: n, given: false });
      } else if (pick < 8) {
        const n = 1 + rnd(3);
        const r = await give(vaccineId, lotId, n);
        model -= n;
        givenModel += n;
        live.push({ id: r.movement.id, delta: -n, given: true });
      } else if (live.length > 0) {
        const [m] = live.splice(rnd(live.length), 1);
        await undo(m.id);
        model -= m.delta;
        if (m.given) givenModel += m.delta; // delta is negative, so this removes the dose
      }
    }
    expect(await onHand('Alpha')).toBe(model);
    expect(await rawSum(vaccineId)).toBe(model);
    const lines = await dosesGiven(env.db, DAY);
    expect(lines.reduce((s, l) => s + Number(l.doses), 0)).toBe(givenModel);
  }, 60000);
});

describe('2-4. reversals', () => {
  test('reversal restores stock exactly AND the original row still exists', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 20);
    const dose = await give(vaccineId, lotId, 3);
    expect(await onHand('Alpha')).toBe(17);
    const rev = await undo(dose.movement.id);
    expect(await onHand('Alpha')).toBe(20);

    const orig = await env.db.first<{ delta_doses: number }>(`SELECT delta_doses FROM stock_movements WHERE id = ?`, [dose.movement.id]);
    expect(orig).not.toBeNull();
    expect(Number(orig!.delta_doses)).toBe(-3);
    const row = await env.db.first<{ reverses_id: string; delta_doses: number; movement_type: string }>(
      `SELECT reverses_id, delta_doses, movement_type FROM stock_movements WHERE id = ?`, [rev.movement.id]);
    expect(row!.movement_type).toBe('REVERSAL');
    expect(row!.reverses_id).toBe(dose.movement.id);
    expect(Number(row!.delta_doses)).toBe(3);
    const total = await env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements`);
    expect(Number(total!.n)).toBe(3); // receipt, dose, reversal: nothing deleted
  });

  test('a REVERSAL may not itself be reversed', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 20);
    const dose = await give(vaccineId, lotId, 3);
    const rev = await undo(dose.movement.id);
    await expect(undo(rev.movement.id)).rejects.toThrow();
    expect(await onHand('Alpha')).toBe(20);
  });

  test('a movement can be reversed at most once (second attempt, new action id)', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 20);
    const dose = await give(vaccineId, lotId, 3);
    await undo(dose.movement.id);
    // The spec requires "at most once", not that the second attempt throws; either is acceptable.
    try { await undo(dose.movement.id); } catch { /* rejecting is fine */ }
    const n = await env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements WHERE reverses_id = ?`, [dose.movement.id]);
    expect(Number(n!.n)).toBe(1);
    expect(await onHand('Alpha')).toBe(20); // not 23
  });
});

describe('5. balances use the raw ledger, activity uses the effective view', () => {
  test('3 given, 1 undone: balance 100-3+1 = 98 but only 2 doses count as given today', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 100);
    const d1 = await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 1);
    await undo(d1.movement.id);

    expect(await onHand('Alpha')).toBe(98);
    const lines = await dosesGiven(env.db, DAY);
    expect(lines.length).toBe(2);
    expect(lines.reduce((s, l) => s + Number(l.doses), 0)).toBe(2);
    const eff = await env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM v_movement_effective WHERE movement_type = 'ADMINISTRATION'`);
    expect(Number(eff!.n)).toBe(2);
  });
});

describe('6. vial accounting', () => {
  test('3 from a 10-dose vial leaves 7', async () => {
    const { vaccineId, lotId } = await lot('Beta');
    await receive(vaccineId, lotId, dosesFromVials(10, 1));
    await give(vaccineId, lotId, 3);
    expect(await onHand('Beta')).toBe(7);
  });

  test('dosesFromVials: 3 vials of 10 = 30 doses', () => {
    expect(dosesFromVials(10, 3)).toBe(30);
    expect(dosesFromVials(5, 2)).toBe(10);
  });

  test('two vials (20 doses): the 11th dose is served from the second vial, 9 remain', async () => {
    const { vaccineId, lotId } = await lot('Beta');
    await receive(vaccineId, lotId, dosesFromVials(10, 2));
    for (let i = 0; i < 11; i++) await give(vaccineId, lotId, 1);
    expect(await onHand('Beta')).toBe(9);
  });

  test('one vial (10 doses): the 11th dose takes stock to -1, which says a second vial is needed', async () => {
    const { vaccineId, lotId } = await lot('Beta');
    await receive(vaccineId, lotId, dosesFromVials(10, 1));
    for (let i = 0; i < 11; i++) await give(vaccineId, lotId, 1);
    expect(await onHand('Beta')).toBe(-1);
  });
});

describe('7. expiry is the LAST day of the printed month', () => {
  test.each([
    [2027, 3, '2027-03-31'],
    [2027, 4, '2027-04-30'],
    [2027, 2, '2027-02-28'],
    [2028, 2, '2028-02-29'],
    [2027, 12, '2027-12-31'],
    [2027, 1, '2027-01-31'],
  ])('printed %i-%i is usable through %s', (y, m, expected) => {
    expect(expiryFromMonth(y, m)).toBe(expected);
  });

  test('a 03/2027 lot is still usable on 31 Mar 2027 and expired on 1 Apr 2027', () => {
    const l = { expiry_date: expiryFromMonth(2027, 3) };
    expect(isExpired(l, '2027-03-01')).toBe(false);
    expect(isExpired(l, '2027-03-31')).toBe(false);
    expect(isExpired(l, '2027-04-01')).toBe(true);
  });

  test('a stored lot keeps the expiry it was given, and no expiry stays unset', async () => {
    const withExpiry = await lot('Alpha', 'E1', 'PRIVATE', expiryFromMonth(2027, 3));
    const without = await lot('Alpha', 'E2');
    expect((await getLot(env.db, withExpiry.lotId))!.expiry_date).toBe('2027-03-31');
    expect((await getLot(env.db, without.lotId))!.expiry_date).toBeNull();
    expect(isExpired({ expiry_date: null }, '2099-01-01')).toBe(false);
  });
});

describe('8. low stock fires at on_hand <= min_balance', () => {
  test.each([
    [6, 'OK'],
    [5, 'LOW'],
    [4, 'LOW'],
    [1, 'LOW'],
    [0, 'OUT'],
    [-1, 'NEGATIVE'],
  ])('min 5, on hand %i is %s', (onHandDoses, level) => {
    expect(stockLevel(onHandDoses, 5)).toBe(level);
  });

  test('min 0: on hand 1 is OK, on hand 0 is OUT', () => {
    expect(stockLevel(1, 0)).toBe('OK');
    expect(stockLevel(0, 0)).toBe('OUT');
  });

  test('end to end: 10 doses, min 5, give 4 -> OK (6), give 1 more -> LOW (5)', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await give(vaccineId, lotId, 4);
    expect(stockLevel(await onHand('Alpha'), 5)).toBe('OK');
    await give(vaccineId, lotId, 1);
    expect(stockLevel(await onHand('Alpha'), 5)).toBe('LOW');
  });
});

describe('9. negative on-hand is surfaced, never clamped; recording is never blocked', () => {
  test('a dose with no stock is recorded and on-hand is -1', async () => {
    const vaccineId = await env.vaccineId('Gamma');
    const r = await give(vaccineId, null, 1);
    expect(r.created).toBe(true);
    expect(await onHand('Gamma')).toBe(-1);
    expect(stockLevel(await onHand('Gamma'), 0)).toBe('NEGATIVE');
  });

  test('5 received, 8 given: on-hand is -3', async () => {
    const { vaccineId, lotId } = await lot('Gamma');
    await receive(vaccineId, lotId, 5);
    await give(vaccineId, lotId, 8);
    expect(await onHand('Gamma')).toBe(-3);
  });

  test('a dose with no child name is recorded and flagged for completion', async () => {
    const { vaccineId, lotId } = await lot('Gamma');
    const r = await give(vaccineId, lotId, 1);
    expect(r.created).toBe(true);
    expect(r.movement.patient_id).toBeNull();
    expect(Number(r.movement.needs_detail)).toBe(1);
  });
});

describe('10. prices', () => {
  test('editing a price never re-prices a dose already given', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 50);
    await setVaccinePrice(env.db, vaccineId, 500, T0);
    const before = await give(vaccineId, lotId, 1);
    await setVaccinePrice(env.db, vaccineId, 800, T0);
    const after = await give(vaccineId, lotId, 1);

    const old = await env.db.first<{ price_rupees: number }>(`SELECT price_rupees FROM stock_movements WHERE id = ?`, [before.movement.id]);
    const recent = await env.db.first<{ price_rupees: number }>(`SELECT price_rupees FROM stock_movements WHERE id = ?`, [after.movement.id]);
    expect(Number(old!.price_rupees)).toBe(500);
    expect(Number(recent!.price_rupees)).toBe(800);

    const s = summarise(await dosesSince(env.db, '2026-09-01'), { grain: 'month', period: '2026-09-01' });
    expect(s.total).toBe(2);
    expect(s.sales).toBe(1300); // 500 + 800, not 2 x 800
    expect(s.unpriced).toBe(0);
  });

  test('a dose of a vaccine with no price is "not set", not Rs 0', async () => {
    const { vaccineId, lotId } = await lot('Gamma');
    await receive(vaccineId, lotId, 5);
    await give(vaccineId, lotId, 2);
    const rows = await dosesSince(env.db, '2026-09-01');
    expect(rows.every((r) => r.price === null)).toBe(true);
    const s = summarise(rows, { grain: 'month', period: '2026-09-01' });
    expect(s.unpriced).toBe(2);
    expect(s.sales).toBe(0);
    expect(s.byVaccineSales).toEqual([]);
  });

  test('Government (UIP) doses are worth Rs 0 and are not "price not set"', async () => {
    const { vaccineId, lotId } = await lot('Alpha', 'G1', 'GOVT_UIP');
    await setVaccinePrice(env.db, vaccineId, 500, T0);
    await receive(vaccineId, lotId, 10);
    await give(vaccineId, lotId, 3);
    const rows = await dosesSince(env.db, '2026-09-01');
    expect(rows.every((r) => r.price === 0)).toBe(true);
    const s = summarise(rows, { grain: 'month', period: '2026-09-01' });
    expect(s.total).toBe(3);
    expect(s.sales).toBe(0);
    expect(s.unpriced).toBe(0);
  });

  test('a private dose (500) plus a UIP dose of the same vaccine sales = 500', async () => {
    const priv = await lot('Alpha', 'P1', 'PRIVATE');
    const govt = await lot('Alpha', 'G1', 'GOVT_UIP');
    await setVaccinePrice(env.db, priv.vaccineId, 500, T0);
    await receive(priv.vaccineId, priv.lotId, 5);
    await receive(priv.vaccineId, govt.lotId, 5);
    await give(priv.vaccineId, priv.lotId, 1);
    await give(priv.vaccineId, govt.lotId, 1);
    const s = summarise(await dosesSince(env.db, '2026-09-01'), { grain: 'month', period: '2026-09-01' });
    expect(s.total).toBe(2);
    expect(s.sales).toBe(500);
  });

  test('an undone dose is not counted in Trends', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await setVaccinePrice(env.db, vaccineId, 500, T0);
    await receive(vaccineId, lotId, 5);
    const d = await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 1);
    await undo(d.movement.id);
    const s = summarise(await dosesSince(env.db, '2026-09-01'), { grain: 'month', period: '2026-09-01' });
    expect(s.total).toBe(1);
    expect(s.sales).toBe(500);
  });
});

describe('11. dirty clears only after the server acknowledges', () => {
  function backend(opts: { fail?: boolean } = {}) {
    const batches: PushBatch[] = [];
    const b: SyncBackend = {
      async push(batch) {
        if (opts.fail) throw new SyncNetworkError('offline');
        batches.push(batch);
      },
      async annotate() { return new Set<string>(); },
      async pullAll() { return []; },
      async pullSince() { return []; },
      async ping() {},
    };
    return { b, batches };
  }

  async function seedWrites() {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await give(vaccineId, lotId, 1);
  }

  test('writes leave rows waiting to upload', async () => {
    await seedWrites();
    expect(await countDirty(env.db)).toBeGreaterThan(0);
  });

  test('a failed upload reports not-ok and leaves every row still waiting', async () => {
    await seedWrites();
    const before = await countDirty(env.db);
    const out = await pushOnce(env.db, backend({ fail: true }).b, env.ctx.deviceId, T0);
    expect(out.ok).toBe(false);
    expect(await countDirty(env.db)).toBe(before);
  });

  test('an acknowledged upload drains the queue, and a second push uploads nothing', async () => {
    await seedWrites();
    const { b } = backend();
    const out = await pushOnce(env.db, b, env.ctx.deviceId, T0);
    expect(out.ok).toBe(true);
    expect(await countDirty(env.db)).toBe(0);
    const again = await pushOnce(env.db, b, env.ctx.deviceId, T0);
    expect(again.ok).toBe(true);
    expect(again.pushedRows).toBe(0);
  });

  test('a failure after a success: new writes wait, old rows are not re-sent', async () => {
    await seedWrites();
    await pushOnce(env.db, backend().b, env.ctx.deviceId, T0);
    const v = await env.vaccineId('Gamma');
    await give(v, null, 1);
    expect(await countDirty(env.db)).toBeGreaterThan(0);
    const out = await pushOnce(env.db, backend({ fail: true }).b, env.ctx.deviceId, T0);
    expect(out.ok).toBe(false);
    expect(await countDirty(env.db)).toBeGreaterThan(0);
  });

  test('settings are never replicated, and bookkeeping columns are stripped', async () => {
    await seedWrites();
    const { b, batches } = backend();
    await pushOnce(env.db, b, env.ctx.deviceId, T0);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.some((x) => (x.table as string) === 'settings')).toBe(false);
    for (const x of batches) for (const row of x.rows) {
      expect('dirty' in row).toBe(false);
      expect('last_synced_at' in row).toBe(false);
    }
  });

  test('tables upload in FK order: vaccines before lots before stock_movements', async () => {
    await seedWrites();
    const { b, batches } = backend();
    await pushOnce(env.db, b, env.ctx.deviceId, T0);
    const order = batches.map((x) => x.table as string);
    const first = (t: string) => order.indexOf(t);
    expect(first('vaccines')).toBeGreaterThanOrEqual(0);
    expect(first('vaccines')).toBeLessThan(first('lots'));
    expect(first('lots')).toBeLessThan(first('stock_movements'));
  });

  test('a reversal never reaches the server before the movement it reverses', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    const d = await give(vaccineId, lotId, 1);
    await undo(d.movement.id);
    const { b, batches } = backend();
    await pushOnce(env.db, b, env.ctx.deviceId, T0);
    const ids: string[] = [];
    for (const x of batches) if ((x.table as string) === 'stock_movements') for (const r of x.rows) ids.push(String(r.id));
    expect(ids.indexOf(d.movement.id)).toBeGreaterThanOrEqual(0);
    const rev = batches.flatMap((x) => ((x.table as string) === 'stock_movements' ? x.rows : [])).find((r) => r.reverses_id === d.movement.id);
    expect(ids.indexOf(String(rev!.id))).toBeGreaterThan(ids.indexOf(d.movement.id));
  });
});

describe('12. idempotency: a retried write is a no-op that looks like success', () => {
  test('same client action id twice: one row, second reports created=false, stock moves once', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    const input = { clientActionId: 'tap-1', vaccineId, lotId, doses: 2 };
    const first = await recordAdministration(env.db, env.ctx, input);
    const retry = await recordAdministration(env.db, env.ctx, input);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.movement.id).toBe(first.movement.id);
    expect(await onHand('Alpha')).toBe(8);
  });

  test('a retried receipt does not double the delivery', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    const input = { clientActionId: 'rcv-1', vaccineId, lotId, doses: 10 };
    await recordReceipt(env.db, env.ctx, input);
    await recordReceipt(env.db, env.ctx, input);
    expect(await onHand('Alpha')).toBe(10);
  });

  test('a retried undo does not reverse twice', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    const d = await give(vaccineId, lotId, 2);
    const input = { clientActionId: 'undo-1', movementId: d.movement.id };
    await reverseMovement(env.db, env.ctx, input);
    await reverseMovement(env.db, env.ctx, input);
    expect(await onHand('Alpha')).toBe(10);
  });

  test('two genuine doses (distinct taps) of the same vaccine inside 45s are BOTH recorded', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await give(vaccineId, lotId, 1);
    await give(vaccineId, lotId, 1);
    expect(await onHand('Alpha')).toBe(8);
    expect((await dosesGiven(env.db, DAY)).length).toBe(2);
  });
});

describe('other numbers CLAUDE.md states', () => {
  test('local_date does not slip at midnight IST: 23:59 stays on 6 Sep, 00:30 is 7 Sep', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    const late = await give(vaccineId, lotId, 1, Date.UTC(2026, 8, 6, 18, 29, 0)); // 23:59 IST
    const next = await give(vaccineId, lotId, 1, Date.UTC(2026, 8, 6, 19, 0, 0)); // 00:30 IST
    expect(late.movement.local_date).toBe('2026-09-06');
    expect(late.movement.local_time.startsWith('23:59')).toBe(true);
    expect(next.movement.local_date).toBe('2026-09-07');
    expect(next.movement.local_time.startsWith('00:30')).toBe(true);
    expect(late.movement.tz_offset_minutes).toBe(330);
  });

  test('a stored local_date is unchanged by a later write in another timezone', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    const a = await give(vaccineId, lotId, 1, Date.UTC(2026, 8, 6, 18, 29, 0));
    await recordAdministration(env.db, { ...env.ctx, tzOffsetMinutes: -480 }, { clientActionId: act(), vaccineId, lotId, doses: 1, occurredAt: Date.UTC(2026, 8, 6, 18, 29, 0) });
    const row = await env.db.first<{ local_date: string }>(`SELECT local_date FROM stock_movements WHERE id = ?`, [a.movement.id]);
    expect(row!.local_date).toBe('2026-09-06');
  });

  test('"given today" counts only that local date', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await give(vaccineId, lotId, 1, Date.UTC(2026, 8, 5, 5, 0, 0));
    await give(vaccineId, lotId, 2, Date.UTC(2026, 8, 6, 5, 0, 0));
    const today = await dosesGiven(env.db, '2026-09-06');
    expect(today.reduce((s, l) => s + Number(l.doses), 0)).toBe(2);
  });

  test('adjustment can lower stock: 10 received, adjusted by -2 -> 8', async () => {
    const { vaccineId, lotId } = await lot('Alpha');
    await receive(vaccineId, lotId, 10);
    await recordAdjustment(env.db, env.ctx, { clientActionId: act(), vaccineId, lotId, deltaDoses: -2, note: 'count correction' });
    expect(await onHand('Alpha')).toBe(8);
  });

  test('age: 11 weeks reads "11 w", 4 y 8 m reads "4 y 8 m", no date of birth is blank', () => {
    expect(formatAge('2026-08-11', '2026-10-27')).toBe('11 w'); // 77 days
    expect(formatAge('2022-02-27', '2026-10-27')).toBe('4 y 8 m');
    expect(formatAge(null, '2026-10-27')).toBeFalsy();
  });

  test('age: 8 months (under two years) reads in months', () => {
    expect(formatAge('2026-02-27', '2026-10-27')).toBe('8 m');
  });

  test('removing a vaccine is a soft delete: the row and its past doses survive, the name is freed', async () => {
    const { vaccineId, lotId } = await lot('Gamma');
    await receive(vaccineId, lotId, 5);
    await give(vaccineId, lotId, 1);
    await removeVaccine(env.db, vaccineId, T0);

    const row = await env.db.first<{ deleted_at: number | null }>(`SELECT deleted_at FROM vaccines WHERE id = ?`, [vaccineId]);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect((await listVaccines(env.db, false)).some((v) => v.id === vaccineId)).toBe(false);
    const lines = await dosesGiven(env.db, DAY);
    expect(lines.map((l) => l.vaccine_name)).toEqual(['Gamma']);

    const again = await insertVaccine(env.db, SEED[2], env.ctx.deviceId, T0);
    expect(again).not.toBe(vaccineId);
  });

  test('two live vaccines cannot share a name', async () => {
    await expect(insertVaccine(env.db, SEED[0], env.ctx.deviceId, T0)).rejects.toThrow();
  });
});
