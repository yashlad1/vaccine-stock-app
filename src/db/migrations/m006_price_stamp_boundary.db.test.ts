import { openNodeDb } from '../driver.node';
import { migrate, currentVersion, LATEST_VERSION } from '../migrate';
import { getNumber, SETTING } from '../repo/settings';
import { m001 } from './m001_initial';
import { m002 } from './m002_sync';
import { m003 } from './m003_multidevice';
import { m004 } from './m004_patient_sex';
import { m005 } from './m005_prices';

/** CLAUDE.md section 6 rule 6: build v5 with real rows, migrate, assert. */

const NOW = Date.UTC(2026, 9, 27, 6, 0, 0);

async function buildV5(stamps: Array<number | null>) {
  const db = openNodeDb(':memory:');
  await db.exec('PRAGMA foreign_keys = ON');
  await db.tx(async (tx) => {
    for (const m of [m001, m002, m003, m004, m005]) await m.up(tx);
    await tx.exec('PRAGMA user_version = 5');
  });
  const meta = [NOW, NOW, 'old-phone'];
  await db.run(
    `INSERT INTO vaccines (id,name,unit_mode,doses_per_vial,min_balance_doses,created_at,updated_at,device_id)
     VALUES ('v1','BCG','DOSE',1,0,?,?,?)`, meta);
  for (const [i, stamp] of stamps.entries()) {
    await db.run(
      `INSERT INTO stock_movements
         (id,idempotency_key,vaccine_id,delta_doses,movement_type,stock_source,
          occurred_at,local_date,local_time,tz_offset_minutes,
          recorded_at,needs_detail,created_at,updated_at,device_id,price_rupees)
       VALUES (?,?,'v1',-1,'ADMINISTRATION','CLINIC_STOCK',?,'2026-10-27','11:30',330,?,0,?,?,?,?)`,
      [`m${i}`, `k${i}`, NOW + i, NOW + i, NOW, NOW, 'old-phone', stamp]);
  }
  return db;
}

describe('migration 006 (price stamp boundary)', () => {
  it('keeps every row; no stamped dose means nothing falls back to today\'s price', async () => {
    const db = await buildV5([null, null]);
    await migrate(db);
    expect(await currentVersion(db)).toBe(LATEST_VERSION);
    expect((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements`))!.n).toBe(2);
    expect(await getNumber(db, SETTING.priceStampFrom, -1)).toBe(0);
  });

  it('puts the boundary at the earliest stamped dose', async () => {
    const db = await buildV5([null, 250, 300]);
    await migrate(db);
    expect(await getNumber(db, SETTING.priceStampFrom, -1)).toBe(NOW + 1);
    expect((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements`))!.n).toBe(3);
  });

  it('a fresh install ends with a 0 boundary', async () => {
    const db = openNodeDb(':memory:');
    await migrate(db);
    expect(await getNumber(db, SETTING.priceStampFrom, -1)).toBe(0);
  });

  it('refuses to edit recorded_at or created_at on a movement', async () => {
    const db = await buildV5([null]);
    await migrate(db);
    await expect(db.run(`UPDATE stock_movements SET recorded_at = 1 WHERE id = 'm0'`)).rejects.toThrow(/append-only/);
    await expect(db.run(`UPDATE stock_movements SET created_at = 1 WHERE id = 'm0'`)).rejects.toThrow(/append-only/);
    await db.run(`UPDATE stock_movements SET note = 'x' WHERE id = 'm0'`);
  });
});
