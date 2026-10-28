import { makeTestDb, actions } from '../db/testing';
import { openNodeDb } from '../db/driver.node';
import { migrate } from '../db/migrate';
import { memoryBackend } from './backend.memory';
import { countDirty, pushOnce, syncStatus, PUSH_ORDER } from './push';
import { restoreFromServer, previewServer } from './restore';
import { findOrCreateLot } from '../db/repo/lots';
import { recordAdministration, recordReceipt, reverseMovement } from '../domain/ledger';
import { seedCatalog } from '../db/repo/catalog';
import { createPatient, setPatientDob } from '../db/repo/patients';
import type { SyncBackend } from './backend';

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };

async function env() {
  const e = await makeTestDb({ seed: [BCG] });
  const bcg = await e.vaccineId('BCG');
  const lot = await findOrCreateLot(e.db, { vaccineId: bcg, lotNumber: 'AB1' }, e.ctx.deviceId);
  return { ...e, bcg, lot, next: actions() };
}

const onHand = async (db: any, v: string) =>
  (await db.first(`SELECT on_hand_doses AS n FROM v_stock_on_hand WHERE vaccine_id=?`, [v])).n;

describe('push', () => {
  it('uploads everything, then has nothing left to upload', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 });

    const server = memoryBackend();
    expect(await countDirty(db)).toBeGreaterThan(0);

    const out = await pushOnce(db, server.backend, ctx.deviceId);
    expect(out.ok).toBe(true);
    expect(await countDirty(db)).toBe(0);
    expect(server.count('stock_movements')).toBe(2);
    expect(server.count('vaccines')).toBe(1);
  });

  it('is a no-op when nothing has changed', async () => {
    const { db, ctx } = await env();
    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);
    const before = server.pushes();
    const second = await pushOnce(db, server.backend, ctx.deviceId);
    expect(second.pushedRows).toBe(0);
    expect(server.pushes()).toBe(before); // no request at all
  });

  it('never strips this phone\'s bookkeeping into the server copy', async () => {
    const { db, ctx } = await env();
    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);
    for (const r of server.rows('vaccines')) {
      expect(r).not.toHaveProperty('dirty');
      expect(r).not.toHaveProperty('last_synced_at');
    }
  });

  it('keeps rows queued when the upload fails, so nothing is lost', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });

    // Fails on the very first request, before anything is acknowledged.
    const server = memoryBackend({ failEvery: 1 });
    const out = await pushOnce(db, server.backend, ctx.deviceId);

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/simulated/);
    // Still queued. This is the property that matters: a failed sync must
    // never be mistaken for a successful one.
    expect(await countDirty(db)).toBeGreaterThan(0);

    const retry = await pushOnce(db, memoryBackend().backend, ctx.deviceId);
    expect(retry.ok).toBe(true);
    expect(await countDirty(db)).toBe(0);
  });

  it('keeps an edit made DURING the upload queued, instead of marking it sent', async () => {
    // The first-visit flow: the child is added, the debounced push fires four
    // seconds later, and the date of birth is saved while it is still out.
    const { db, ctx } = await env();
    const child = await createPatient(db, { name: 'Aarav' }, ctx.deviceId);
    const server = memoryBackend();
    let edited = false;
    const racing: SyncBackend = {
      ...server.backend,
      async push(batch) {
        await server.backend.push(batch);
        if (batch.table === 'patients' && !edited) {
          edited = true;
          await setPatientDob(db, child, '2026-08-03', Date.now() + 1000);
        }
      },
    };

    await pushOnce(db, racing, ctx.deviceId);
    expect(server.rows('patients')[0].dob).toBeNull();
    expect(await countDirty(db)).toBe(1); // the edit is still waiting, not marked sent

    await pushOnce(db, server.backend, ctx.deviceId);
    expect(server.rows('patients')[0].dob).toBe('2026-08-03');
    expect(await countDirty(db)).toBe(0);
  });

  it('records the failure so a phone can be diagnosed remotely', async () => {
    const { db, ctx } = await env();
    await pushOnce(db, memoryBackend({ failEvery: 1 }).backend, ctx.deviceId);
    const s = await syncStatus(db);
    expect(s.lastError).toMatch(/simulated/);
    expect(s.lastOkAt).toBeNull();
  });

  it('pushes parents before children, so the server is never left with an orphan', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 5 });
    const order: string[] = [];
    const spy = {
      push: async (b: any) => void order.push(b.table),
      pullAll: async () => [],
      pullSince: async () => [],
      annotate: async () => new Set<string>(),
      ping: async () => {},
    };
    await pushOnce(db, spy, ctx.deviceId);
    expect(order.indexOf('vaccines')).toBeLessThan(order.indexOf('lots'));
    expect(order.indexOf('lots')).toBeLessThan(order.indexOf('stock_movements'));
  });

  it('survives more rows than one batch', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 5000 });
    for (let i = 0; i < 250; i++) {
      await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 });
    }
    const server = memoryBackend();
    const out = await pushOnce(db, server.backend, ctx.deviceId);
    expect(out.ok).toBe(true);
    expect(server.count('stock_movements')).toBe(251);
    expect(await countDirty(db)).toBe(0);
  });
});

describe('restore onto a replacement phone', () => {
  it('rebuilds the ledger and derives identical stock', async () => {
    // The end-to-end claim the backend is FOR: the phone is gone, and the
    // numbers come back.
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    const { movement } = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 3 });
    await reverseMovement(db, ctx, { clientActionId: next(), movementId: movement.id });
    const expected = await onHand(db, bcg);
    expect(expected).toBe(30);

    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);

    // A brand-new phone: empty database, migrated, nothing seeded.
    const fresh = openNodeDb(':memory:');
    await fresh.exec('PRAGMA foreign_keys = ON');
    await migrate(fresh);

    const report = await restoreFromServer(fresh, server.backend);
    expect(report.total).toBeGreaterThan(0);
    expect(await onHand(fresh, bcg)).toBe(expected);

    // Restored rows came FROM the server, so they must not be queued to go
    // straight back up.
    expect(await countDirty(fresh)).toBe(0);
  });

  it('restores a REVERSAL after the movement it reverses', async () => {
    // reverses_id is a self-referencing FK with foreign_keys ON, so the wrong
    // order fails loudly rather than orphaning the correction.
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 10 });
    const { movement } = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 2 });
    await reverseMovement(db, ctx, { clientActionId: next(), movementId: movement.id });

    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);

    const fresh = openNodeDb(':memory:');
    await fresh.exec('PRAGMA foreign_keys = ON');
    await migrate(fresh);
    await expect(restoreFromServer(fresh, server.backend)).resolves.toBeTruthy();

    const rev = await fresh.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_movements WHERE reverses_id = ?`, [movement.id]);
    expect(rev!.n).toBe(1);
  });

  it('is safe to run twice', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 12 });
    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);

    const fresh = openNodeDb(':memory:');
    await fresh.exec('PRAGMA foreign_keys = ON');
    await migrate(fresh);
    await restoreFromServer(fresh, server.backend);
    const first = await onHand(fresh, bcg);
    const second = await restoreFromServer(fresh, server.backend);
    expect(second.total).toBe(0); // INSERT OR IGNORE - nothing duplicated
    expect(await onHand(fresh, bcg)).toBe(first);
  });

  it('shows real numbers before touching anything', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 8 });
    const server = memoryBackend();
    await pushOnce(db, server.backend, ctx.deviceId);
    const preview = await previewServer(server.backend);
    expect(preview.stock_movements).toBe(1);
    expect(preview.vaccines).toBe(1);
  });
});
