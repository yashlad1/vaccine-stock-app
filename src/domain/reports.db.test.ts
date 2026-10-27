import { makeTestDb, actions, T0 } from '../db/testing';
import { findOrCreateLot } from '../db/repo/lots';
import { createPatient } from '../db/repo/patients';
import {
  recordAdministration, recordReceipt, recordWastage, recordAdjustment,
  recordOpeningBalance, reverseMovement,
} from './ledger';
import {
  dosesGiven, dosesGivenTotals, movementStrip, periodStrip, stockOnHand, vaccinesInStock,
  vaccinesByUsage, missingChildEntries, asOfLabel,
} from './reports';

const BCG = { name: 'BCG', unit_mode: 'VIAL' as const, doses_per_vial: 10, min_balance_doses: 20 };
const PENTA = { name: 'Pentavac PFS', unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 10 };
const DAY = 24 * 3600_000;

async function env() {
  const e = await makeTestDb({ seed: [BCG, PENTA] });
  const bcg = await e.vaccineId('BCG');
  const penta = await e.vaccineId('Pentavac PFS');
  const lot = await findOrCreateLot(e.db, { vaccineId: bcg, lotNumber: 'AB1234', expiryDate: '2027-03-31' }, e.ctx.deviceId, T0);
  const rawTotal = async () =>
    (await e.db.first<{ n: number }>(
      `SELECT COALESCE(SUM(delta_doses),0) AS n FROM stock_movements WHERE stock_source='CLINIC_STOCK'`,
    ))!.n;
  return { ...e, bcg, penta, lot, rawTotal, next: actions() };
}

describe('Report 1: vaccine stock, names, unique values', () => {
  it('lists every catalog vaccine exactly once - uniqueness is structural', async () => {
    const { db } = await env();
    const rows = await stockOnHand(db);
    expect(rows.map((r) => r.name)).toEqual(['BCG', 'Pentavac PFS']);
    // There is no de-duplication step because duplicates cannot be created.
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it('vaccinesInStock omits vaccines with a zero balance', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    const rows = await vaccinesInStock(db);
    expect(rows.map((r) => r.name)).toEqual(['BCG']);
    expect(rows[0].on_hand_doses).toBe(30);
  });

  it('orders the Give Dose grid by what this clinic actually gives', async () => {
    const { db, ctx, bcg, penta, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: penta, lotId: null as never, doses: 30 })
      .catch(() => undefined);
    // Penta gets used more, so it must sort first despite 'BCG' being alphabetically earlier.
    for (let i = 0; i < 5; i++) {
      await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: penta });
    }
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });

    const rows = await vaccinesByUsage(db, '2026-08-07', '2026-09-07');
    expect(rows[0].name).toBe('Pentavac PFS');
    expect(rows[0].recent_doses).toBe(5);
    expect(rows[1].recent_doses).toBe(1);
  });
});

describe('grid ordering holds still', () => {
  it('ignores today, counts yesterday', async () => {
    const { db, ctx, bcg, penta, lot, next } = await env();
    await recordReceipt(db, { ...ctx, now: T0 - 2 * DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordReceipt(db, { ...ctx, now: T0 - 2 * DAY }, { clientActionId: next(), vaccineId: penta, lotId: null as never, doses: 30 })
      .catch(() => undefined);
    const order = async () => (await vaccinesByUsage(db, '2026-08-07', '2026-09-06')).map((r) => r.name);
    expect(await order()).toEqual(['BCG', 'Pentavac PFS']);
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: penta });
    expect(await order()).toEqual(['BCG', 'Pentavac PFS']);
    await recordAdministration(db, { ...ctx, now: T0 - DAY }, { clientActionId: next(), vaccineId: penta });
    expect(await order()).toEqual(['Pentavac PFS', 'BCG']);
  });
});

describe('movement strip ignores removed vaccines', () => {
  it('excludes a removed vaccine and equals the active list total', async () => {
    const { db, ctx, bcg, penta, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    await recordOpeningBalance(db, { ...ctx, now: T0 - DAY }, { clientActionId: next(), vaccineId: penta, doses: 12 });
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: penta });
    await db.run(`UPDATE vaccines SET deleted_at = ? WHERE id = ?`, ['2026-09-06T00:00:00Z', penta]);

    const s = await movementStrip(db, '2026-09-06');
    expect(s).toMatchObject({ opening: 0, received: 30, given: 1, now: 29, corrections: 0 });
    const list = await stockOnHand(db, { activeOnly: true });
    expect(s.now).toBe(list.reduce((n, r) => n + r.on_hand_doses, 0));
    // A single removed vaccine still reports its own numbers.
    expect((await movementStrip(db, '2026-09-06', penta)).now).toBe(11);
  });
});

describe('Report 2: vaccines given today, time, count', () => {
  it('lists each dose with its time, lot and child', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    const child = await createPatient(db, { name: 'Aarav Sharma' }, ctx.deviceId, T0);
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, {
      clientActionId: next(), vaccineId: bcg, lotId: lot, patientId: child, patientLabel: 'Aarav Sharma',
    });

    const lines = await dosesGiven(db, '2026-09-06');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      local_time: '10:30', vaccine_name: 'BCG', lot_number: 'AB1234',
      patient_label: 'Aarav Sharma', doses: 1,
    });
  });

  it('EXCLUDES an undone dose - "3 given, 1 undone" must read 2, not 3', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, { clientActionId: 'a', vaccineId: bcg, lotId: lot });
    await recordAdministration(db, ctx, { clientActionId: 'b', vaccineId: bcg, lotId: lot });
    const third = await recordAdministration(db, ctx, { clientActionId: 'c', vaccineId: bcg, lotId: lot });
    await reverseMovement(db, ctx, { clientActionId: 'undo-c', movementId: third.movement.id });

    // This is THE most likely reporting bug in the system: summing the raw
    // table here would report 3.
    expect(await dosesGiven(db, '2026-09-06')).toHaveLength(2);
    const totals = await dosesGivenTotals(db, '2026-09-06');
    expect(totals).toEqual([{ vaccine_id: bcg, name: 'BCG', doses: 2 }]);
  });

  it('scopes to the local date, not the UTC date', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    // 19:00 UTC on the 6th is 00:30 IST on the 7th - a different clinic day.
    await recordAdministration(db, ctx, {
      clientActionId: next(), vaccineId: bcg, lotId: lot, occurredAt: Date.UTC(2026, 8, 6, 19, 0),
    });
    expect(await dosesGiven(db, '2026-09-06')).toHaveLength(0);
    expect(await dosesGiven(db, '2026-09-07')).toHaveLength(1);
  });

  it('surfaces doses whose child was skipped', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    const missing = await missingChildEntries(db);
    expect(missing).toHaveLength(1);
    expect(missing[0].vaccine_name).toBe('BCG');
  });
});

describe('Report 3: the movement strip reconciles', () => {
  it('shows the derivation that produces the current number', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    // Yesterday: opening 30.
    await recordOpeningBalance(db, { ...ctx, now: T0 - DAY }, { clientActionId: next(), vaccineId: bcg, doses: 30 });
    // Today: +20 received, 7 given, 3 wasted.
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 20 });
    for (let i = 0; i < 7; i++) {
      await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    }
    await recordWastage(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 3, reason: 'OPEN_VIAL_TIMEOUT' });

    const s = await movementStrip(db, '2026-09-06', bcg);
    expect(s).toMatchObject({ opening: 30, received: 20, given: 7, wasted: 3, adjusted: 0, corrections: 0, now: 40 });
  });

  it('does not double-count a dose recorded and undone on the SAME day', async () => {
    const { db, ctx, bcg, lot, rawTotal, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    const a = await recordAdministration(db, ctx, { clientActionId: 'a', vaccineId: bcg, lotId: lot });
    await reverseMovement(db, ctx, { clientActionId: 'undo-a', movementId: a.movement.id });

    const s = await movementStrip(db, '2026-09-06', bcg);
    expect(s.given).toBe(0); // the dose was undone
    expect(s.corrections).toBe(0); // and it was same-day, so no correction line
    expect(s.now).toBe(30);
    expect(await rawTotal()).toBe(30);
  });

  it('accounts for a PRIOR day reversed today - the term that is easy to miss', async () => {
    const { db, ctx, bcg, lot, rawTotal, next } = await env();
    // Yesterday: +30 received.
    const yctx = { ...ctx, now: T0 - DAY };
    const recv = await recordReceipt(db, yctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    // Today: that receipt turns out to be wrong, and is reversed.
    await reverseMovement(db, ctx, { clientActionId: 'undo-r', movementId: recv.movement.id });

    const s = await movementStrip(db, '2026-09-06', bcg);
    // The original still sits inside `opening`, and the reversal is dated today,
    // so without the corrections term the strip would claim 30 and be wrong.
    expect(s.opening).toBe(30);
    expect(s.corrections).toBe(-30);
    expect(s.now).toBe(0);
    expect(await rawTotal()).toBe(0);
  });

  it('includes adjustments from a physical count', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await recordAdjustment(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, deltaDoses: -2, note: 'count' });
    const s = await movementStrip(db, '2026-09-06', bcg);
    expect(s.adjusted).toBe(-2);
    expect(s.now).toBe(28);
  });
});

describe('periodStrip: the same equation over a week or a month', () => {
  // T0 is 6 Sep 2026. The range below is 1-6 Sep; 31 Aug is before it.
  const FROM = '2026-09-01';
  const TO = '2026-09-06';

  it('is movementStrip when the range is one day', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordOpeningBalance(db, { ...ctx, now: T0 - DAY }, { clientActionId: next(), vaccineId: bcg, doses: 30 });
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 20 });
    await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 3 });
    expect(await periodStrip(db, '2026-09-06', '2026-09-06', bcg)).toEqual(await movementStrip(db, '2026-09-06', bcg));
  });

  it('starts on the balance before the range and ends on the balance at its last day', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    const on = (daysBefore: number) => ({ ...ctx, now: T0 - daysBefore * DAY });
    await recordReceipt(db, on(6), { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 }); // 31 Aug
    await recordReceipt(db, on(4), { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 20 }); // 2 Sep
    await recordAdministration(db, on(3), { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 5 });
    await recordWastage(db, on(1), { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 2, reason: 'BREAKAGE' });
    await recordAdministration(db, { ...ctx, now: T0 + DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot }); // 7 Sep, after

    const s = await periodStrip(db, FROM, TO, bcg);
    expect(s).toMatchObject({ from: FROM, localDate: TO, opening: 30, received: 20, given: 5, wasted: 2, corrections: 0, now: 43 });
  });

  it('a dose given and undone on different days inside the range is neither given nor a correction', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordReceipt(db, { ...ctx, now: T0 - 5 * DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    const a = await recordAdministration(db, { ...ctx, now: T0 - 3 * DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot });
    await reverseMovement(db, ctx, { clientActionId: next(), movementId: a.movement.id });

    const s = await periodStrip(db, FROM, TO, bcg);
    expect(s).toMatchObject({ received: 30, given: 0, corrections: 0, now: 30 });
  });

  it('books a reversal of an entry from BEFORE the range as a correction, and still adds up', async () => {
    const { db, ctx, bcg, lot, next } = await env();
    const recv = await recordReceipt(db, { ...ctx, now: T0 - 10 * DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 30 });
    await reverseMovement(db, { ...ctx, now: T0 - 2 * DAY }, { clientActionId: next(), movementId: recv.movement.id });

    const s = await periodStrip(db, FROM, TO, bcg);
    expect(s).toMatchObject({ opening: 30, corrections: -30, now: 0 });
    expect(s.opening + s.received - s.given - s.wasted + s.adjusted + s.corrections).toBe(s.now);
  });

  it('leaves removed vaccines out of the clinic total but keeps a single one', async () => {
    const { db, ctx, bcg, penta, lot, next } = await env();
    await recordReceipt(db, { ...ctx, now: T0 - 2 * DAY }, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 10 });
    await recordOpeningBalance(db, { ...ctx, now: T0 - 2 * DAY }, { clientActionId: next(), vaccineId: penta, doses: 12 });
    await db.run(`UPDATE vaccines SET deleted_at = ? WHERE id = ?`, ['2026-09-06T00:00:00Z', penta]);

    expect((await periodStrip(db, FROM, TO)).now).toBe(10);
    expect((await periodStrip(db, FROM, TO, penta)).now).toBe(12);
  });
});

describe('PROPERTY: the strip always equals derived on-hand', () => {
  it('holds over 300 random movement sequences spanning two days', async () => {
    for (let iter = 0; iter < 300; iter++) {
      const { db, ctx, bcg, lot, rawTotal, next } = await env();
      const written: string[] = [];
      const days = [T0 - DAY, T0];

      const steps = 3 + (iter % 9);
      for (let i = 0; i < steps; i++) {
        const now = days[(iter + i) % 2 === 0 ? 0 : 1];
        const c = { ...ctx, now };
        const pick = (iter * 7 + i * 3) % 5;
        try {
          if (pick === 0) {
            const r = await recordReceipt(db, c, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 + (i % 20) });
            written.push(r.movement.id);
          } else if (pick === 1) {
            const r = await recordAdministration(db, c, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 + (i % 3) });
            written.push(r.movement.id);
          } else if (pick === 2) {
            const r = await recordWastage(db, c, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 1 + (i % 4), reason: 'BREAKAGE' });
            written.push(r.movement.id);
          } else if (pick === 3) {
            const r = await recordAdjustment(db, c, { clientActionId: next(), vaccineId: bcg, lotId: lot, deltaDoses: (i % 2 ? 1 : -1) * (1 + (i % 5)), note: 'n' });
            written.push(r.movement.id);
          } else if (written.length) {
            // Reverse an arbitrary earlier movement, possibly one from the other day.
            const target = written[(iter + i) % written.length];
            await reverseMovement(db, c, { clientActionId: next(), movementId: target });
          }
        } catch {
          // Reversing an already-reversed movement is legitimately rejected.
        }
      }

      const s = await movementStrip(db, '2026-09-06', bcg);
      const raw = await rawTotal();
      // Both readings of "remaining" must land on the same number, always.
      expect(s.now).toBe(raw);
    }
  });
});

describe('the strip agrees with the Stock tab', () => {
  it("strip.now equals v_stock_on_hand, so the two screens can never disagree", async () => {
    const { db, ctx, bcg, lot, next } = await env();
    await recordOpeningBalance(db, { ...ctx, now: T0 - DAY }, { clientActionId: next(), vaccineId: bcg, doses: 30 });
    await recordReceipt(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 20 });
    const a = await recordAdministration(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 4 });
    await reverseMovement(db, ctx, { clientActionId: next(), movementId: a.movement.id });
    await recordWastage(db, ctx, { clientActionId: next(), vaccineId: bcg, lotId: lot, doses: 2, reason: 'EXPIRED' });

    const s = await movementStrip(db, '2026-09-06', bcg);
    const onHand = (await stockOnHand(db)).find((r) => r.vaccine_id === bcg)!.on_hand_doses;
    expect(s.now).toBe(onHand);
    // And the derivation it shows must add up to that same number.
    expect(s.opening + s.received - s.given - s.wasted + s.adjusted + s.corrections).toBe(s.now);
  });

  it('never renders a negative zero', async () => {
    const { db } = await env();
    const s = await movementStrip(db, '2026-09-06');
    for (const k of ['opening', 'received', 'given', 'wasted', 'adjusted', 'corrections', 'now'] as const) {
      expect(Object.is(s[k], -0)).toBe(false);
    }
  });
});

describe('as-of stamping', () => {
  it('labels a report with its own time - a stock number without one is a rumour', () => {
    expect(asOfLabel(new Date(2026, 8, 6, 14, 32).getTime())).toBe('as of 2:32 pm');
    expect(asOfLabel(new Date(2026, 8, 6, 0, 5).getTime())).toBe('as of 12:05 am');
  });
});
