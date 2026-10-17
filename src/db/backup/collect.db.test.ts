import { makeTestDb, T0 } from '../testing';
import { findOrCreateLot } from '../repo/lots';
import { createPatient } from '../repo/patients';
import { recordAdministration, recordReceipt, reverseMovement } from '../../domain/ledger';
import { collectCsvs, dosesCsv, vaccinesCsv, tableCounts } from './collect';

const MR = { name: 'Measles-Rubella (MR)', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 10 };

async function env() {
  const e = await makeTestDb({ seed: [MR] });
  const mr = await e.vaccineId('Measles-Rubella (MR)');
  const lot = await findOrCreateLot(e.db, { vaccineId: mr, lotNumber: 'MR-77' }, e.ctx.deviceId, T0);
  return { ...e, mr, lot };
}

describe('doses.csv is shaped like the notebook page it replaces', () => {
  it('writes date, 12-hour time, vaccine, batch, child, age and doses', async () => {
    const { db, ctx, mr, lot } = await env();
    // Born 26 Jul, dosed 6 Sep: 42 days, so the age AT THE DOSE is 6 w,
    // whatever the date is when the backup is taken.
    const child = await createPatient(db, { name: "O'Brien, Aarav", dob: '2026-07-26' }, ctx.deviceId, T0);
    await recordReceipt(db, ctx, { clientActionId: 'r', vaccineId: mr, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, {
      clientActionId: 'a', vaccineId: mr, lotId: lot, patientId: child, patientLabel: "O'Brien, Aarav",
    });

    const csv = await dosesCsv(db);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe('date,time,vaccine,batch,child,age,doses');
    // The comma inside BOTH the vaccine name and the child name must be quoted.
    expect(row).toBe('2026-09-06,10:30 am,Measles-Rubella (MR),MR-77,"O\'Brien, Aarav",6 w,1');
  });

  it('omits an undone dose, matching the on-screen report', async () => {
    const { db, ctx, mr, lot } = await env();
    await recordReceipt(db, ctx, { clientActionId: 'r', vaccineId: mr, lotId: lot, doses: 30 });
    const a = await recordAdministration(db, ctx, { clientActionId: 'a', vaccineId: mr, lotId: lot });
    await recordAdministration(db, ctx, { clientActionId: 'b', vaccineId: mr, lotId: lot });
    await reverseMovement(db, ctx, { clientActionId: 'u', movementId: a.movement.id });

    const lines = (await dosesCsv(db)).trim().split('\r\n');
    expect(lines).toHaveLength(2); // header + the one dose that stands
  });
});

describe('vaccines.csv carries the fields the clinician asked for by name', () => {
  it('includes trade name, present stock and the safety limit', async () => {
    const { db, ctx, mr, lot } = await env();
    await recordReceipt(db, ctx, { clientActionId: 'r', vaccineId: mr, lotId: lot, doses: 30 });
    const csv = await vaccinesCsv(db);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe('trade_name,generic_name,counted_in,doses_per_vial,safety_limit_doses,present_stock_doses');
    expect(row).toContain('Measles-Rubella (MR)');
    expect(row.endsWith(',10,10,30')).toBe(true);
  });
});

describe('bundle contents', () => {
  it('produces all four CSVs', async () => {
    const { db } = await env();
    expect(Object.keys(await collectCsvs(db)).sort()).toEqual([
      'doses.csv', 'patients.csv', 'stock_movements.csv', 'vaccines.csv',
    ]);
  });

  it('counts every required table for the manifest', async () => {
    const { db, ctx, mr, lot } = await env();
    await recordReceipt(db, ctx, { clientActionId: 'r', vaccineId: mr, lotId: lot, doses: 30 });
    const counts = await tableCounts(db);
    expect(counts).toMatchObject({ vaccines: 1, lots: 1, staff: 0, stock_movements: 1, patients: 0 });
  });

  it('records a correction in the raw ledger CSV so the audit trail survives export', async () => {
    const { db, ctx, mr, lot } = await env();
    await recordReceipt(db, ctx, { clientActionId: 'r', vaccineId: mr, lotId: lot, doses: 30 });
    const a = await recordAdministration(db, ctx, { clientActionId: 'a', vaccineId: mr, lotId: lot });
    await reverseMovement(db, ctx, { clientActionId: 'u', movementId: a.movement.id });

    const csv = (await collectCsvs(db))['stock_movements.csv'];
    expect(csv).toContain('reverses an earlier entry');
    // All three rows are present - nothing is hidden from the export.
    expect(csv.trim().split('\r\n')).toHaveLength(4);
  });
});
