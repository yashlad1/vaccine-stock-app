import { makeTestDb, actions } from '../db/testing';
import { findOrCreateLot } from '../db/repo/lots';
import { setVaccinePrice } from '../db/repo/catalog';
import { recordAdministration, recordReceipt, reverseMovement } from './ledger';

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };

async function env() {
  const e = await makeTestDb({ seed: [BCG] });
  const bcg = await e.vaccineId('BCG');
  const lot = await findOrCreateLot(e.db, { vaccineId: bcg, lotNumber: 'AB1' }, e.ctx.deviceId, e.ctx.now);
  const stamp = async (id: string) =>
    (await e.db.first<{ price_rupees: number | null }>(`SELECT price_rupees FROM stock_movements WHERE id = ?`, [id]))!.price_rupees;
  return { ...e, bcg, lot, stamp, next: actions() };
}

describe('dose price stamp', () => {
  it('stamps the vaccine price at the moment of the dose', async () => {
    const { db, ctx, bcg, lot, next, stamp } = await env();
    await setVaccinePrice(db, bcg, 1250);
    const r = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    expect(await stamp(r.movement.id)).toBe(1250);
  });

  it('keeps an earlier dose at its old price after the price changes', async () => {
    const { db, ctx, bcg, lot, next, stamp } = await env();
    await setVaccinePrice(db, bcg, 1250);
    const a = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    await setVaccinePrice(db, bcg, 1500);
    const b = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    expect(await stamp(a.movement.id)).toBe(1250);
    expect(await stamp(b.movement.id)).toBe(1500);
  });

  it('stamps NULL on a receipt and on a reversal', async () => {
    const { db, ctx, bcg, lot, next, stamp } = await env();
    await setVaccinePrice(db, bcg, 1250);
    const rc = await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    const dose = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    const rev = await reverseMovement(db, ctx, { clientActionId: next(), movementId: dose.movement.id });
    expect(await stamp(rc.movement.id)).toBeNull();
    expect(await stamp(rev.movement.id)).toBeNull();
  });

  it('stamps NULL for an unpriced vaccine', async () => {
    const { db, ctx, bcg, lot, next, stamp } = await env();
    const r = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    expect(await stamp(r.movement.id)).toBeNull();
  });

  it('marks the vaccine dirty for upload', async () => {
    const { db, bcg } = await env();
    await db.run(`UPDATE vaccines SET dirty = 0, last_synced_at = 1 WHERE id = ?`, [bcg]);
    await setVaccinePrice(db, bcg, 1250, 5_000_000_000_000);
    const v = await db.first<{ dirty: number; price_rupees: number }>(`SELECT dirty, price_rupees FROM vaccines WHERE id = ?`, [bcg]);
    expect(v).toEqual({ dirty: 1, price_rupees: 1250 });
  });
});
