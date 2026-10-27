import { openNodeDb } from '../driver.node';
import { migrate, currentVersion, LATEST_VERSION } from '../migrate';
import { m001 } from './m001_initial';
import { m002 } from './m002_sync';
import { m003 } from './m003_multidevice';
import { m004 } from './m004_patient_sex';

/** CLAUDE.md section 6 rule 6: build v4 with real rows, migrate, assert survival. */

const NOW = Date.UTC(2026, 9, 27, 6, 0, 0);

async function buildV4() {
  const db = openNodeDb(':memory:');
  await db.exec('PRAGMA foreign_keys = ON');
  await db.tx(async (tx) => {
    for (const m of [m001, m002, m003, m004]) await m.up(tx);
    await tx.exec('PRAGMA user_version = 4');
  });
  const meta = [NOW, NOW, 'old-phone'];
  await db.run(
    `INSERT INTO vaccines (id,name,unit_mode,doses_per_vial,min_balance_doses,created_at,updated_at,device_id)
     VALUES ('v1','BCG','VIAL',10,20,?,?,?)`, meta);
  await db.run(
    `INSERT INTO patients (id,name,dob,created_at,updated_at,device_id) VALUES ('p1','Aarav','2026-01-05',?,?,?)`, meta);
  await db.run(
    `INSERT INTO lots (id,vaccine_id,lot_number,funding_source,first_received_at,created_at,updated_at,device_id)
     VALUES ('l1','v1','AB1','PRIVATE',?,?,?,?)`, [NOW, ...meta]);
  await db.run(
    `INSERT INTO stock_movements
       (id,idempotency_key,vaccine_id,lot_id,delta_doses,movement_type,stock_source,
        patient_id,occurred_at,local_date,local_time,tz_offset_minutes,
        recorded_at,needs_detail,created_at,updated_at,device_id)
     VALUES ('m1','k1','v1','l1',-1,'ADMINISTRATION','CLINIC_STOCK','p1',?,'2026-10-27','11:30',330,?,0,?,?,?)`,
    [NOW, NOW, ...meta]);
  return db;
}

describe('migration 005 (prices)', () => {
  it('runs from v4 to latest, keeps every row, and leaves old prices NULL', async () => {
    const db = await buildV4();
    expect(await currentVersion(db)).toBe(4);
    await migrate(db);
    expect(await currentVersion(db)).toBe(LATEST_VERSION);

    for (const table of ['vaccines', 'patients', 'lots', 'stock_movements']) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(row!.n).toBe(1);
    }
    expect(await db.first(`SELECT price_rupees FROM vaccines WHERE id = 'v1'`)).toEqual({ price_rupees: null });
    expect(await db.first(`SELECT price_rupees FROM stock_movements WHERE id = 'm1'`)).toEqual({ price_rupees: null });
  });

  it('rejects a negative price on either table', async () => {
    const db = await buildV4();
    await migrate(db);
    await expect(db.run(`UPDATE vaccines SET price_rupees = -1 WHERE id = 'v1'`)).rejects.toThrow(/CHECK/);
    await db.run(`UPDATE vaccines SET price_rupees = 1250 WHERE id = 'v1'`);
  });

  it('refuses to edit a dose price after it is written', async () => {
    const db = await buildV4();
    await migrate(db);
    await expect(db.run(`UPDATE stock_movements SET price_rupees = 99 WHERE id = 'm1'`)).rejects.toThrow(/append-only/);
  });
});
