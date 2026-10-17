import { makeTestDb, actions, T0 } from '../db/testing';
import { findOrCreateLot, getLot } from '../db/repo/lots';
import { recordAdministration, recordReceipt, reverseMovement } from './ledger';
import { backupNag } from './backup-nag';
import { missingChildEntries } from './reports';

/**
 * Regressions found in a review pass before the second release build. Each of
 * these was reachable from ordinary data entry, so each gets a test that fails
 * if the fix is ever undone.
 */

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };

async function env() {
  const e = await makeTestDb({ seed: [BCG] });
  const bcg = await e.vaccineId('BCG');
  return { ...e, bcg, next: actions() };
}

describe('a lot arriving a second time', () => {
  it('accepts an expiry that was not to hand on the first delivery', async () => {
    // Before the fix findOrCreateLot returned early on a match, so a missing
    // expiry could NEVER be supplied - every later delivery matched and
    // discarded the date, and FEFO stayed blind to that lot forever.
    const { db, ctx, bcg } = await env();
    const first = await findOrCreateLot(db, { vaccineId: bcg, lotNumber: 'AB1', expiryDate: null }, ctx.deviceId, T0);
    const again = await findOrCreateLot(db, { vaccineId: bcg, lotNumber: 'AB1', expiryDate: '2028-03-31' }, ctx.deviceId, T0);

    expect(again).toBe(first); // still one lot - identity is unchanged
    expect((await getLot(db, first))!.expiry_date).toBe('2028-03-31');
  });

  it('does not let a later typo overwrite an expiry already recorded', async () => {
    // The backfill fills a NULL only. Expiry drives FEFO and the expired-batch
    // warning, so a mistyped month must not silently replace a good date.
    const { db, ctx, bcg } = await env();
    const id = await findOrCreateLot(db, { vaccineId: bcg, lotNumber: 'AB2', expiryDate: '2028-03-31' }, ctx.deviceId, T0);
    await findOrCreateLot(db, { vaccineId: bcg, lotNumber: 'AB2', expiryDate: '2020-01-31' }, ctx.deviceId, T0);
    expect((await getLot(db, id))!.expiry_date).toBe('2028-03-31');
  });
});

describe('correcting the same entry twice', () => {
  it('is a no-op rather than a constraint error', async () => {
    // Double-tapping "Correct this entry" used to hit UNIQUE(reverses_id) and
    // surface as an unhandled rejection. A movement can be reversed at most
    // once, so the second attempt returns the existing reversal.
    const { db, ctx, bcg, next } = await env();
    const lot = await findOrCreateLot(db, { vaccineId: bcg, lotNumber: 'L1' }, ctx.deviceId, T0);
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 10 });
    const { movement } = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 });

    const a = await reverseMovement(db, ctx, { clientActionId: next(), movementId: movement.id });
    const b = await reverseMovement(db, ctx, { clientActionId: next(), movementId: movement.id });

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.movement.id).toBe(a.movement.id);

    // And it stays reversed exactly once, so stock is not double-credited.
    const n = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_movements WHERE reverses_id = ?`, [movement.id]);
    expect(n!.n).toBe(1);
    const onHand = await db.first<{ n: number }>(
      `SELECT on_hand_doses AS n FROM v_stock_on_hand WHERE vaccine_id = ?`, [bcg]);
    expect(onHand!.n).toBe(10);
  });
});

describe('"Skip - no name"', () => {
  it('reaches the day-end queue instead of silently keeping a half-typed name', async () => {
    // The dose screen used to send whatever was in the search box as the
    // patient label even when Skip was tapped. needs_detail then came out 0,
    // so the entry never appeared in "entries missing child name" - a name
    // nobody chose, and no prompt to finish it.
    const { db, ctx, bcg, next } = await env();
    await recordAdministration(db, ctx, {
      clientActionId: next(), vaccineId: bcg, doses: 1,
      patientId: null, patientLabel: null, // what Skip sends now
    });
    const queue = await missingChildEntries(db);
    expect(queue).toHaveLength(1);
    expect(queue[0].patient_label).toBeNull();
  });

  it('still treats a chosen name as complete', async () => {
    const { db, ctx, bcg, next } = await env();
    await recordAdministration(db, ctx, {
      clientActionId: next(), vaccineId: bcg, doses: 1, patientLabel: 'Aarav',
    });
    expect(await missingChildEntries(db)).toHaveLength(0);
  });
});

describe('the backup banner "Later" button', () => {
  const NOW = Date.UTC(2026, 8, 7, 6, 0, 0);
  const DAY = 86_400_000;

  it('works on a phone that has never been backed up', () => {
    // The state EVERY new install starts in, and the one place the snooze was
    // unreachable: the never-backed-up branch returned before the snooze check.
    const base = { lastBackupAt: null, dosesSinceBackup: 1, now: NOW };
    expect(backupNag(base).level).toBe('due');
    expect(backupNag({ ...base, snoozedUntil: NOW + DAY }).level).toBe('none');
  });

  it('cannot silence a never-backed-up phone that has passed the dose trigger', () => {
    // 25+ unbacked entries is red, and red is deliberately not snoozable.
    const nag = backupNag({
      lastBackupAt: null, dosesSinceBackup: 30, now: NOW, snoozedUntil: NOW + DAY,
    });
    expect(nag.level).toBe('overdue');
  });

  it('agrees with itself about number', () => {
    expect(backupNag({ lastBackupAt: null, dosesSinceBackup: 1, now: NOW }).message)
      .toBe('Back up now: 1 entry has never been backed up.');
    expect(backupNag({ lastBackupAt: null, dosesSinceBackup: 2, now: NOW }).message)
      .toBe('Back up now: 2 entries have never been backed up.');
  });
});
