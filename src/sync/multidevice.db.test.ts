import { openNodeDb } from '../db/driver.node';
import { migrate } from '../db/migrate';
import { memoryBackend } from './backend.memory';
import { pushOnce, countDirty } from './push';
import { pullOnce } from './pull';
import { adoptOrSeed, isAwaitingCatalog, isPrimaryDevice, startNewClinicHere } from './adopt';
import { saveSyncConfig } from './config';
import { insertVaccine, seedCatalog } from '../db/repo/catalog';
import { findOrCreateLot } from '../db/repo/lots';
import { recordAdministration, recordReceipt, reverseMovement } from '../domain/ledger';
import { ensureDeviceId } from '../db/repo/settings';
import { createPatient } from '../db/repo/patients';
import type { Db } from '../db/driver';
import type { SyncBackend } from './backend';

/**
 * Two writing devices.
 *
 * The claim under test is narrow and is the only one that matters: once both
 * devices have exchanged movements, THEY AGREE ON THE NUMBERS. Everything else
 * here is about the four places two devices can create the same thing twice.
 */

/** A fresh, migrated device sharing one server. */
async function device(server: ReturnType<typeof memoryBackend>, name: string) {
  const db = openNodeDb(':memory:');
  await db.exec('PRAGMA foreign_keys = ON');
  await migrate(db);
  const deviceId = await ensureDeviceId(db);
  await saveSyncConfig(db, {
    url: 'https://x.test', publishableKey: 'k', email: 'e@x.test', password: 'p', enabled: true,
  });
  const sync = async () => {
    await pullOnce(db, server.backend);
    await pushOnce(db, server.backend, deviceId);
  };
  return { db, deviceId, name, sync };
}

const onHand = (db: Db, v: string) =>
  db
    .first<{ n: number }>(`SELECT on_hand_doses AS n FROM v_stock_on_hand WHERE vaccine_id = ?`, [v])
    .then((r) => r?.n ?? 0);

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };

describe('two devices both recording', () => {
  it('converge on identical derived stock', async () => {
    const server = memoryBackend();
    const A = await device(server, 'A');
    const B = await device(server, 'B');

    // A starts the clinic; B joins it.
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    const lotA = await findOrCreateLot(A.db, { vaccineId: vId, lotNumber: 'AB1' }, A.deviceId);
    await recordReceipt(A.db, { deviceId: A.deviceId }, {
      clientActionId: 'a-r1', vaccineId: vId, lotId: lotA, doses: 100,
    });
    await A.sync();
    await B.sync();

    // Both now give doses without talking to each other.
    for (let i = 0; i < 5; i++) {
      await recordAdministration(A.db, { deviceId: A.deviceId }, {
        clientActionId: `a-d${i}`, vaccineId: vId, lotId: lotA, doses: 1,
      });
    }
    for (let i = 0; i < 3; i++) {
      await recordAdministration(B.db, { deviceId: B.deviceId }, {
        clientActionId: `b-d${i}`, vaccineId: vId, lotId: lotA, doses: 2,
      });
    }

    // Before syncing they legitimately disagree - each only knows its own.
    expect(await onHand(A.db, vId)).toBe(95);
    expect(await onHand(B.db, vId)).toBe(94);

    // Two rounds, because each device must both send and receive.
    await A.sync(); await B.sync(); await A.sync();

    // 100 - 5 - 6 = 89, on BOTH, derived not transferred.
    expect(await onHand(A.db, vId)).toBe(89);
    expect(await onHand(B.db, vId)).toBe(89);
    expect(await countDirty(A.db)).toBe(0);
    expect(await countDirty(B.db)).toBe(0);
  });

  it('never collides on a movement, even for the same child at the same instant', async () => {
    // idempotency_key is deviceId:clientActionId, so identical intent text on
    // two devices is still two distinct rows.
    const server = memoryBackend();
    const A = await device(server, 'A');
    const B = await device(server, 'B');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync(); await B.sync();

    await recordReceipt(A.db, { deviceId: A.deviceId }, {
      clientActionId: 'r', vaccineId: vId, lotId: await findOrCreateLot(A.db, { vaccineId: vId, lotNumber: 'L' }, A.deviceId), doses: 50,
    });
    await A.sync(); await B.sync();

    await recordAdministration(A.db, { deviceId: A.deviceId }, { clientActionId: 'same-tap', vaccineId: vId, doses: 1 });
    await recordAdministration(B.db, { deviceId: B.deviceId }, { clientActionId: 'same-tap', vaccineId: vId, doses: 1 });
    await A.sync(); await B.sync(); await A.sync();

    expect(await onHand(A.db, vId)).toBe(48);
    expect(await onHand(B.db, vId)).toBe(48);
  });
});

describe('the same batch logged on both devices', () => {
  it('keeps both rows and still totals correctly', async () => {
    // ux_lots_identity was relaxed in migration 003 precisely so this does not
    // reject a real delivery. Two chips for one physical batch is untidy; a
    // wrong total would not be acceptable.
    const server = memoryBackend();
    const A = await device(server, 'A');
    const B = await device(server, 'B');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync(); await B.sync();

    const la = await findOrCreateLot(A.db, { vaccineId: vId, lotNumber: 'SAME1' }, A.deviceId);
    const lb = await findOrCreateLot(B.db, { vaccineId: vId, lotNumber: 'SAME1' }, B.deviceId);
    expect(la).not.toBe(lb); // different UUIDs for one physical batch

    await recordReceipt(A.db, { deviceId: A.deviceId }, { clientActionId: 'ra', vaccineId: vId, lotId: la, doses: 10 });
    await recordReceipt(B.db, { deviceId: B.deviceId }, { clientActionId: 'rb', vaccineId: vId, lotId: lb, doses: 20 });

    await A.sync(); await B.sync(); await A.sync();

    expect(await onHand(A.db, vId)).toBe(30);
    expect(await onHand(B.db, vId)).toBe(30);
    const lots = await A.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lots WHERE vaccine_id = ? AND lot_number = 'SAME1'`, [vId]);
    expect(lots!.n).toBe(2);
  });
});

describe('the same entry corrected on both devices', () => {
  it('credits the stock back exactly once', async () => {
    // The hazard that would silently inflate stock. UNIQUE(reverses_id) is what
    // prevents it, and pull has to treat the rejection as "already corrected"
    // rather than as an error.
    const server = memoryBackend();
    const A = await device(server, 'A');
    const B = await device(server, 'B');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    const lot = await findOrCreateLot(A.db, { vaccineId: vId, lotNumber: 'L1' }, A.deviceId);
    await recordReceipt(A.db, { deviceId: A.deviceId }, { clientActionId: 'r', vaccineId: vId, lotId: lot, doses: 10 });
    const { movement } = await recordAdministration(A.db, { deviceId: A.deviceId }, {
      clientActionId: 'd1', vaccineId: vId, lotId: lot, doses: 1,
    });
    await A.sync(); await B.sync();
    expect(await onHand(B.db, vId)).toBe(9);

    // Both correct it while offline from each other.
    await reverseMovement(A.db, { deviceId: A.deviceId }, { clientActionId: 'undo-a', movementId: movement.id });
    await reverseMovement(B.db, { deviceId: B.deviceId }, { clientActionId: 'undo-b', movementId: movement.id });
    expect(await onHand(A.db, vId)).toBe(10);
    expect(await onHand(B.db, vId)).toBe(10);

    await A.sync(); await B.sync(); await A.sync(); await B.sync();

    // Not 11. The dose was given once and undone once.
    expect(await onHand(A.db, vId)).toBe(10);
    expect(await onHand(B.db, vId)).toBe(10);
    for (const d of [A, B]) {
      const n = await d.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM stock_movements WHERE reverses_id = ?`, [movement.id]);
      expect(n!.n).toBe(1);
    }
  });

  it('reports the collision rather than swallowing it', async () => {
    const server = memoryBackend();
    const A = await device(server, 'A');
    const B = await device(server, 'B');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    const lot = await findOrCreateLot(A.db, { vaccineId: vId, lotNumber: 'L1' }, A.deviceId);
    await recordReceipt(A.db, { deviceId: A.deviceId }, { clientActionId: 'r', vaccineId: vId, lotId: lot, doses: 10 });
    const { movement } = await recordAdministration(A.db, { deviceId: A.deviceId }, {
      clientActionId: 'd1', vaccineId: vId, doses: 1,
    });
    await A.sync(); await B.sync();
    await reverseMovement(A.db, { deviceId: A.deviceId }, { clientActionId: 'ua', movementId: movement.id });
    await reverseMovement(B.db, { deviceId: B.deviceId }, { clientActionId: 'ub', movementId: movement.id });
    await A.sync();
    const out = await pullOnce(B.db, server.backend);
    expect(out.ok).toBe(true);
    expect(out.conflicts.some((c) => c.reason === 'already-reversed')).toBe(true);
  });
});

describe('a new device joining an existing clinic', () => {
  it('adopts the catalog instead of seeding a second one', async () => {
    // Without this the tablet seeds ~26 vaccines with fresh UUIDs and pushes
    // them, leaving two rows per vaccine. Failure mode 1, via the sync layer.
    const server = memoryBackend();
    const A = await device(server, 'A');
    const seeded = await seedCatalog(A.db, A.deviceId);
    expect(seeded).toBeGreaterThan(10);
    await A.sync();

    const B = await device(server, 'B');
    const res = await adoptOrSeed(B.db, B.deviceId, server.backend);
    expect(res?.kind).toBe('adopted');

    const names = await B.db.all<{ name: string; n: number }>(
      `SELECT name, COUNT(*) AS n FROM vaccines WHERE deleted_at IS NULL GROUP BY name HAVING n > 1`);
    expect(names).toEqual([]); // not one duplicated name

    const a = await A.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM vaccines`);
    const b = await B.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM vaccines`);
    expect(b!.n).toBe(a!.n);
    expect(await isPrimaryDevice(B.db)).toBe(false);
    expect(await isPrimaryDevice(A.db)).toBe(true);
  });

  it('waits rather than seeding when the server cannot be reached', async () => {
    // The subtle half. Falling back to seeding here would create the duplicate
    // anyway, just delayed until connectivity returned.
    const dead: SyncBackend = {
      push: async () => { throw new Error('offline'); },
      pullAll: async () => { throw new Error('offline'); },
      pullSince: async () => { throw new Error('offline'); },
      ping: async () => { throw new Error('offline'); },
    };
    const db = openNodeDb(':memory:');
    await db.exec('PRAGMA foreign_keys = ON');
    await migrate(db);
    const deviceId = await ensureDeviceId(db);
    await saveSyncConfig(db, {
      url: 'https://x.test', publishableKey: 'k', email: 'e@x.test', password: 'p', enabled: true,
    });

    const pulled = await pullOnce(db, dead);
    expect(pulled.ok).toBe(false);

    const n = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM vaccines`);
    expect(n!.n).toBe(0); // nothing seeded
  });

  it('seeds and claims primary when the server is reachable but empty', async () => {
    const server = memoryBackend();
    const A = await device(server, 'A');
    const res = await adoptOrSeed(A.db, A.deviceId, server.backend);
    expect(res?.kind).toBe('seeded');
    expect(await isPrimaryDevice(A.db)).toBe(true);
  });
});

describe('pull mechanics', () => {
  it('does not push back what it just pulled', async () => {
    // If a pulled row stayed dirty, every device would re-upload everything it
    // received, forever.
    const server = memoryBackend();
    const A = await device(server, 'A');
    await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync();

    const B = await device(server, 'B');
    await pullOnce(B.db, server.backend);
    expect(await countDirty(B.db)).toBe(0);
  });

  it('is safe to run repeatedly and applies nothing the second time', async () => {
    const server = memoryBackend();
    const A = await device(server, 'A');
    await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync();
    const B = await device(server, 'B');
    const first = await pullOnce(B.db, server.backend);
    const second = await pullOnce(B.db, server.backend);
    expect(first.appliedRows).toBeGreaterThan(0);
    expect(second.appliedRows).toBe(0);
  });

  it('lets the later EDIT win even when the older edit is uploaded last', async () => {
    // The reason the server has a stale-write guard. A push is an
    // unconditional upsert, so without it the row takes the value of whichever
    // device happened to push last - and every device would then agree on the
    // older edit, which is the most convincing kind of wrong.
    const server = memoryBackend();
    const A = await device(server, 'A');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync();
    const B = await device(server, 'B');
    await B.sync();

    const base = Date.now() + 10_000;
    // B makes the NEWER edit but uploads FIRST; A's older edit lands after.
    await B.db.run(`UPDATE vaccines SET min_balance_doses = 9, updated_at = ? WHERE id = ?`, [base + 1000, vId]);
    await A.db.run(`UPDATE vaccines SET min_balance_doses = 5, updated_at = ? WHERE id = ?`, [base, vId]);
    await B.sync();
    await A.sync();
    await B.sync();

    for (const d of [A, B]) {
      const v = await d.db.first<{ min_balance_doses: number }>(
        `SELECT min_balance_doses FROM vaccines WHERE id = ?`, [vId]);
      expect(v!.min_balance_doses).toBe(9);
    }
  });

  it('lets the later edit win on a mutable row', async () => {
    const server = memoryBackend();
    const A = await device(server, 'A');
    const vId = await insertVaccine(A.db, BCG, A.deviceId);
    await A.sync();
    const B = await device(server, 'B');
    await B.sync();

    // B edits LATER than A. The timestamps must be newer than the row's own
    // updated_at, or the already-synced original legitimately wins - which is
    // what an earlier version of this test got wrong.
    const base = Date.now() + 10_000;
    await A.db.run(`UPDATE vaccines SET min_balance_doses = 5, updated_at = ? WHERE id = ?`, [base, vId]);
    await B.db.run(`UPDATE vaccines SET min_balance_doses = 9, updated_at = ? WHERE id = ?`, [base + 1000, vId]);
    await A.sync(); await B.sync(); await A.sync();

    for (const d of [A, B]) {
      const v = await d.db.first<{ min_balance_doses: number }>(
        `SELECT min_balance_doses FROM vaccines WHERE id = ?`, [vId]);
      expect(v!.min_balance_doses).toBe(9);
    }
  });
});

describe('the escape hatch for an unreachable server', () => {
  it('lets the first phone start the list when the server never answers', async () => {
    // adoptOrSeed refuses to seed when it cannot reach the server, which is
    // correct - but it must not leave the app empty with no way forward.
    const db = openNodeDb(':memory:');
    await db.exec('PRAGMA foreign_keys = ON');
    await migrate(db);
    const deviceId = await ensureDeviceId(db);

    expect(await isAwaitingCatalog(db)).toBe(true);
    const n = await startNewClinicHere(db, deviceId);
    expect(n).toBeGreaterThan(10);
    expect(await isAwaitingCatalog(db)).toBe(false);
    expect(await isPrimaryDevice(db)).toBe(true);
  });

  it('refuses on a device that already has a catalog', async () => {
    // The duplicate case. Offering this on a device that already adopted a
    // catalog would create exactly the second copy the whole design avoids.
    const server = memoryBackend();
    const A = await device(server, 'A');
    await seedCatalog(A.db, A.deviceId);
    await A.sync();
    const B = await device(server, 'B');
    await adoptOrSeed(B.db, B.deviceId, server.backend);

    const before = await B.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM vaccines`);
    expect(await startNewClinicHere(B.db, B.deviceId)).toBe(0);
    const after = await B.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM vaccines`);
    expect(after!.n).toBe(before!.n);
  });
});

describe('a phone reinstalled after an uninstall', () => {
  // Uninstalling deletes the app's database. What brings the clinic back is
  // the server: a fresh install joins the clinic like any new device, with the
  // same built-in login. This pins that everything synced comes back exactly.
  it('gets back every synced dose, child, batch, undo and stock number', async () => {
    const server = memoryBackend();
    const phone = await device(server, 'phone');
    const ctx = { deviceId: phone.deviceId };
    const vId = await insertVaccine(phone.db, BCG, phone.deviceId);
    const lot = await findOrCreateLot(phone.db, { vaccineId: vId, lotNumber: 'AB1' }, phone.deviceId);
    await recordReceipt(phone.db, ctx, { clientActionId: 'r1', vaccineId: vId, lotId: lot, doses: 30 });
    const child = await createPatient(phone.db, { name: 'Test Child', dob: '2026-01-01', sex: 'F' }, phone.deviceId);
    await recordAdministration(phone.db, ctx, {
      clientActionId: 'g1', vaccineId: vId, lotId: lot, patientId: child, patientLabel: 'Test Child', note: 'Dose 2',
    });
    const undone = await recordAdministration(phone.db, ctx, { clientActionId: 'g2', vaccineId: vId, lotId: lot });
    await reverseMovement(phone.db, ctx, { clientActionId: 'u1', movementId: undone.movement.id });
    await phone.sync();
    expect(await countDirty(phone.db)).toBe(0); // the precondition: nothing waiting to upload

    const fresh = await device(server, 'phone, reinstalled');
    expect((await adoptOrSeed(fresh.db, fresh.deviceId, server.backend))?.kind).toBe('adopted');

    expect(await onHand(fresh.db, vId)).toBe(29); // 30 received, 1 given, 1 given and undone
    const count = (db: Db, t: string) => db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).then((r) => r!.n);
    for (const t of ['vaccines', 'lots', 'patients', 'stock_movements']) {
      expect(await count(fresh.db, t)).toBe(await count(phone.db, t));
    }
    expect(await fresh.db.first(`SELECT dob, sex FROM patients WHERE id = ?`, [child]))
      .toEqual({ dob: '2026-01-01', sex: 'F' });
    expect(await fresh.db.first(`SELECT note FROM stock_movements WHERE idempotency_key LIKE '%g1'`))
      .toEqual({ note: 'Dose 2' });
  });
});
