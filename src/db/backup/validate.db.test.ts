import { openNodeDb } from '../driver.node';
import { migrate, LATEST_VERSION } from '../migrate';
import { makeTestDb, T0 } from '../testing';
import { findOrCreateLot } from '../repo/lots';
import { recordAdministration, recordReceipt, reverseMovement } from '../../domain/ledger';
import { insertVaccine, removeVaccine } from '../repo/catalog';
import {
  inspectBackup, ledgerSummary, parseManifest, BackupInvalidError, BACKUP_FORMAT, REQUIRED_TABLES,
} from './validate';

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };

async function goodBackup() {
  const e = await makeTestDb({ seed: [BCG] });
  const bcg = await e.vaccineId('BCG');
  const lot = await findOrCreateLot(e.db, { vaccineId: bcg, lotNumber: 'A1' }, e.ctx.deviceId, T0);
  await recordReceipt(e.db, e.ctx, { clientActionId: 'r', vaccineId: bcg, lotId: lot, doses: 30 });
  await recordAdministration(e.db, e.ctx, { clientActionId: 'a', vaccineId: bcg, lotId: lot });
  await recordAdministration(e.db, e.ctx, { clientActionId: 'b', vaccineId: bcg, lotId: lot });
  return e.db;
}

describe('backup preview shows the doctor real numbers', () => {
  it('reports doses, vaccines and the latest entry', async () => {
    const preview = await inspectBackup(await goodBackup());
    expect(preview.schemaVersion).toBe(LATEST_VERSION);
    expect(preview.doses).toBe(2);
    expect(preview.vaccines).toBe(1);
    expect(preview.latestEntryAt).toBe(T0);
    expect(preview.counts.stock_movements).toBe(3);
  });

  it('counts the backup the way it counts the phone: no undone dose, no removed vaccine', async () => {
    const db = await goodBackup();
    const { movement } = await recordAdministration(db, { deviceId: 'd' }, {
      clientActionId: 'undone', vaccineId: (await db.first<{ id: string }>(`SELECT id FROM vaccines`))!.id,
    });
    await reverseMovement(db, { deviceId: 'd' }, { clientActionId: 'undo', movementId: movement.id });
    await removeVaccine(db, await insertVaccine(db, { ...BCG, name: 'Old' }, 'd'));

    const preview = await inspectBackup(db);
    expect({ doses: preview.doses, vaccines: preview.vaccines }).toEqual({ doses: 2, vaccines: 1 });
    const phone = await ledgerSummary(db);
    expect(phone).toEqual({ doses: preview.doses, vaccines: preview.vaccines, latestEntryAt: preview.latestEntryAt });
    // The manifest check still compares raw rows: all 5 movements, both vaccines.
    expect(preview.counts).toMatchObject({ stock_movements: 5, vaccines: 2 });
  });

  it('accepts a manifest whose counts agree with the file', async () => {
    const db = await goodBackup();
    const preview = await inspectBackup(db, {
      format: BACKUP_FORMAT, formatVersion: 1, schemaVersion: LATEST_VERSION,
      appVersion: '0.1.0', deviceId: 'd', exportedAt: T0,
      counts: { stock_movements: 3, vaccines: 1 },
    });
    expect(preview.appVersion).toBe('0.1.0');
  });
});

describe('backup rejection is always specific', () => {
  it('rejects a database that is not ours', async () => {
    const db = openNodeDb();
    await db.exec(`CREATE TABLE something_else (x)`);
    await expect(inspectBackup(db)).rejects.toThrow(/does not contain a Vialbook database/);
  });

  it('rejects a backup from a NEWER app rather than silently mangling it', async () => {
    const db = await goodBackup();
    await db.exec(`PRAGMA user_version = ${LATEST_VERSION + 3}`);
    await expect(inspectBackup(db)).rejects.toThrow(/newer version of the app/);
  });

  it('names the missing table when the backup is incomplete', async () => {
    const db = openNodeDb();
    await migrate(db);
    // Simulate a truncated/partial file by dropping a required table.
    await db.exec(`DROP TABLE patients`);
    await expect(inspectBackup(db)).rejects.toThrow(/missing: patients/);
  });

  it('detects truncation by disagreeing with the manifest', async () => {
    const db = await goodBackup();
    await expect(
      inspectBackup(db, {
        format: BACKUP_FORMAT, formatVersion: 1, schemaVersion: LATEST_VERSION,
        appVersion: '0.1.0', deviceId: 'd', exportedAt: T0,
        counts: { stock_movements: 412 }, // claims far more than it holds
      }),
    ).rejects.toThrow(/looks truncated: it claims 412 stock_movements rows but contains 3/);
  });

  it('lists every required table so a partial restore cannot slip through', () => {
    expect(REQUIRED_TABLES).toContain('stock_movements');
    expect(REQUIRED_TABLES).toContain('vaccines');
  });
});

describe('manifest parsing', () => {
  it('rejects a file that is not JSON', () => {
    expect(() => parseManifest('not json at all')).toThrow(BackupInvalidError);
    expect(() => parseManifest('not json at all')).toThrow(/manifest is not readable/);
  });

  it('rejects JSON that is some other app\'s backup', () => {
    expect(() => parseManifest(JSON.stringify({ format: 'someone-elses-app' }))).toThrow(
      /not a Vialbook backup/,
    );
  });

  it('accepts our own manifest', () => {
    const m = parseManifest(JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1 }));
    expect(m.format).toBe(BACKUP_FORMAT);
  });
});
