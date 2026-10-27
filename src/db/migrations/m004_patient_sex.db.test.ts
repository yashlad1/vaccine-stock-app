import { openNodeDb } from '../driver.node';
import { migrate, currentVersion, LATEST_VERSION } from '../migrate';
import { setPatientSex } from '../repo/patients';
import { m001 } from './m001_initial';
import { m002 } from './m002_sync';
import { m003 } from './m003_multidevice';

/**
 * CLAUDE.md section 6 rule 6: build v3 with real rows, run the chain, assert
 * every row survived and the new column exists.
 */

const NOW = Date.UTC(2026, 9, 27, 6, 0, 0);

async function buildV3() {
  const db = openNodeDb(':memory:');
  await db.exec('PRAGMA foreign_keys = ON');
  await db.tx(async (tx) => {
    await m001.up(tx);
    await m002.up(tx);
    await m003.up(tx);
    await tx.exec('PRAGMA user_version = 3');
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

describe('migration 004 (patient sex)', () => {
  it('runs the chain from v3 to latest and preserves every row', async () => {
    const db = await buildV3();
    expect(await currentVersion(db)).toBe(3);

    await migrate(db);
    expect(await currentVersion(db)).toBe(LATEST_VERSION);

    for (const table of ['vaccines', 'patients', 'lots', 'stock_movements']) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(row!.n).toBe(1);
    }
    const p = await db.first<{ name: string; dob: string; sex: string | null }>(
      `SELECT name, dob, sex FROM patients WHERE id = 'p1'`);
    expect(p).toEqual({ name: 'Aarav', dob: '2026-01-05', sex: null });
  });

  it('accepts M and F and rejects anything else', async () => {
    const db = await buildV3();
    await migrate(db);
    await db.run(`UPDATE patients SET sex = 'M' WHERE id = 'p1'`);
    await db.run(`UPDATE patients SET sex = 'F' WHERE id = 'p1'`);
    await expect(db.run(`UPDATE patients SET sex = 'X' WHERE id = 'p1'`)).rejects.toThrow(/CHECK/);
  });

  it('queues a sex edit for upload', async () => {
    const db = await buildV3();
    await migrate(db);
    await db.run(`UPDATE patients SET dirty = 0, last_synced_at = ? WHERE id = 'p1'`, [NOW]);

    await setPatientSex(db, 'p1', 'F', NOW + 1000);
    const p = await db.first<{ sex: string; dirty: number }>(`SELECT sex, dirty FROM patients WHERE id = 'p1'`);
    expect(p).toEqual({ sex: 'F', dirty: 1 });
  });
});
