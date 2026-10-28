import { makeTestDb, actions, T0 } from '../db/testing';
import { createPatient, recentPatients } from '../db/repo/patients';
import { removeVaccine, deactivateVaccine } from '../db/repo/catalog';
import { recordAdministration, reverseMovement } from './ledger';
import { dosesGiven, missingChildEntries } from './reports';
import { getNumber, SETTING } from '../db/repo/settings';
import type { Db } from '../db/driver';
import { coGiven, recordVisit, visitIds, type Visit } from './visits';

const DAY = 24 * 3600_000;
const dose = (name: string) => ({ name, unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 0 });
const NAMES = ['Rotavac', 'Prevenar 13', 'Hexaxim', 'Varilrix', 'Typbar-TCV', 'Havrix 720', 'Jenvac', 'Menactra'];

async function env() {
  const e = await makeTestDb({ seed: NAMES.map(dose) });
  const id = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await e.vaccineId(n)] as const)));
  const next = actions();
  /** One dose on day `d` (0 = 6 Sep 2026), to a saved child, a typed label, or nobody. */
  const give = (vaccine: string, d: number, child: { id?: string; label?: string } = {}) =>
    recordAdministration(e.db, { ...e.ctx, now: T0 + d * DAY }, {
      clientActionId: next(), vaccineId: id[vaccine], patientId: child.id ?? null, patientLabel: child.label ?? null,
    });
  return { ...e, id, give, next };
}

describe('coGiven: what else the same child is given at the same visit', () => {
  it('counts same-child, same-day doses only, and never the vaccine itself', async () => {
    const { db, id, give } = await env();
    const asha = await createPatient(db, { name: 'Asha' }, 'test-device', T0);
    const a = { id: asha, label: 'Asha' };

    await give('Rotavac', 0, a);
    await give('Rotavac', 0, a); // the same vaccine twice: not a pair with itself
    await give('Prevenar 13', 0, a);
    await give('Rotavac', 1, a);
    await give('Prevenar 13', 1, a);
    await give('Hexaxim', 2, a); // the next day: a different visit
    await give('Varilrix', 0, { label: 'Ravi' }); // a different child, same day

    expect(await coGiven(db, id.Rotavac, '2026-09-01')).toEqual([
      // Two Rotavac doses on day 0, one on day 1.
      {
        vaccine_id: id['Prevenar 13'], name: 'Prevenar 13', on_hand_doses: -2,
        unit_mode: 'DOSE', doses_per_vial: 1, min_balance_doses: 0, times: 3,
      },
    ]);
  });

  it('does not count an undone dose', async () => {
    const { db, ctx, id, give } = await env();
    await give('Rotavac', 0, { label: 'Asha' });
    const undone = await give('Hexaxim', 0, { label: 'Asha' });
    await reverseMovement(db, ctx, { clientActionId: 'undo', movementId: undone.movement.id });
    expect(await coGiven(db, id.Rotavac, '2026-09-01')).toEqual([]);

    // Undoing the main vaccine's dose takes its pairs with it, too.
    const main = await give('Rotavac', 1, { label: 'Ravi' });
    await give('Prevenar 13', 1, { label: 'Ravi' });
    await reverseMovement(db, ctx, { clientActionId: 'undo-2', movementId: main.movement.id });
    expect(await coGiven(db, id.Rotavac, '2026-09-01')).toEqual([]);
  });

  it('matches a typed name exactly, and a typed name against a saved child of that name', async () => {
    const { db, id, give } = await env();
    const asha = await createPatient(db, { name: 'Asha' }, 'test-device', T0);
    await give('Rotavac', 0, { id: asha, label: 'Asha' });
    await give('Hexaxim', 0, { label: 'Asha' }); // typed, not linked: the same child
    await give('Varilrix', 0, { label: 'asha' }); // not the exact label
    await give('Jenvac', 0, { label: 'Asha R' });
    await give('Rotavac', 1, { label: 'Ravi' });
    await give('Typbar-TCV', 1, { label: 'Ravi' });
    // Unnamed doses on the same day are not one child.
    await give('Rotavac', 2);
    await give('Menactra', 2);
    // Two saved children who share a name are two children.
    const other = await createPatient(db, { name: 'Asha' }, 'test-device', T0);
    await give('Rotavac', 3, { id: asha, label: 'Asha' });
    await give('Havrix 720', 3, { id: other, label: 'Asha' });

    const names = (await coGiven(db, id.Rotavac, '2026-09-01')).map((r) => [r.name, r.times]);
    expect(names).toEqual([['Hexaxim', 1], ['Typbar-TCV', 1]]);
  });

  it('leaves out removed and switched-off vaccines, and anything before the window', async () => {
    const { db, id, give } = await env();
    await give('Rotavac', 0, { label: 'Asha' });
    await give('Prevenar 13', 0, { label: 'Asha' });
    await give('Hexaxim', 0, { label: 'Asha' });
    await give('Varilrix', 0, { label: 'Asha' });
    await give('Rotavac', -100, { label: 'Ravi' });
    await give('Jenvac', -100, { label: 'Ravi' });
    await removeVaccine(db, id['Prevenar 13'], T0);
    await deactivateVaccine(db, id.Hexaxim, T0);

    expect((await coGiven(db, id.Rotavac, '2026-06-08')).map((r) => r.name)).toEqual(['Varilrix']);
  });

  it('returns the top 4 by count, ties by name', async () => {
    const { db, id, give } = await env();
    for (const n of ['Typbar-TCV', 'Menactra', 'Jenvac', 'Varilrix', 'Hexaxim']) await give(n, 0, { label: 'Asha' });
    await give('Rotavac', 0, { label: 'Asha' });
    await give('Rotavac', 1, { label: 'Ravi' });
    await give('Varilrix', 1, { label: 'Ravi' });

    expect((await coGiven(db, id.Rotavac, '2026-09-01')).map((r) => r.name)).toEqual([
      'Varilrix', 'Hexaxim', 'Jenvac', 'Menactra',
    ]);
  });
});

describe('recentPatients: the children given a dose today', () => {
  it('lists only today, latest first, leaves out an undone dose, and stops at the limit', async () => {
    const { db, ctx, id } = await env();
    const kids: string[] = [];
    for (const n of ['Yesterday', 'First', 'Second', 'Undone', 'Fourth', 'Fifth']) {
      kids.push(await createPatient(db, { name: n }, 'test-device', T0));
    }
    const [yesterday, first, second, undone, fourth, fifth] = kids;
    // Seconds apart on 6 Sep, so "latest first" has an order to keep.
    const at = (s: number, patientId: string) =>
      recordAdministration(db, { ...ctx, now: T0 + s * 1000 }, { clientActionId: `${patientId}-${s}`, vaccineId: id.Hexaxim, patientId });

    await at(-DAY / 1000, yesterday);
    await at(1, first);
    await at(2, second);
    const u = await at(3, undone);
    await reverseMovement(db, ctx, { clientActionId: 'undo-u', movementId: u.movement.id });

    expect((await recentPatients(db, '2026-09-06')).map((p) => p.id)).toEqual([second, first]);
    expect(await recentPatients(db, '2026-09-07')).toEqual([]);

    await at(4, fourth);
    await at(5, fifth);
    await at(6, first); // a second vaccine for the same child is still one chip
    expect((await recentPatients(db, '2026-09-06')).map((p) => p.id)).toEqual([first, fifth, fourth]);
  });
});

describe('the dose number reaches the reports', () => {
  it('is read back as the note by Given today and the missing-name list', async () => {
    const { db, ctx, id } = await env();
    await recordAdministration(db, ctx, { clientActionId: 'n', vaccineId: id['Typbar-TCV'], patientLabel: 'Asha', note: 'Dose 2' });
    await recordAdministration(db, ctx, { clientActionId: 'm', vaccineId: id['Typbar-TCV'], note: 'Booster' });
    expect((await dosesGiven(db, '2026-09-06')).map((l) => l.note)).toEqual(['Dose 2', 'Booster']);
    expect((await missingChildEntries(db)).map((l) => l.note)).toEqual(['Booster']);
  });
});

describe('visitIds: a retried Give replays only if nothing changed', () => {
  const visit: Visit = {
    vaccineId: 'v', doses: 1, lotId: 'l', patientId: null, patientLabel: 'Asha', note: 'Dose 2',
    extras: [{ vaccineId: 'x', lotId: 'xl' }, { vaccineId: 'y', lotId: null }],
  };

  it('mints ids for the first tap, and keeps them for the same inputs', () => {
    const first = visitIds(null, visit, actions());
    expect(first).toMatchObject({ main: 'a-1', extras: { x: 'a-2', y: 'a-3' } });
    expect(visitIds(first, { ...visit }, actions('b'))).toBe(first);
    // The order the extras were ticked in is not a change.
    expect(visitIds(first, { ...visit, extras: [...visit.extras].reverse() }, actions('b'))).toBe(first);
  });

  it.each<[string, Partial<Visit>]>([
    ['the vaccine', { vaccineId: 'w' }],
    ['the dose count', { doses: 2 }],
    ['the batch', { lotId: null }],
    ['the saved child', { patientId: 'p' }],
    ['the typed name', { patientLabel: 'Ravi' }],
    ['the dose number', { note: null }],
    ['the extras, one more', { extras: [...visit.extras, { vaccineId: 'z', lotId: null }] }],
    ['the extras, one fewer', { extras: [visit.extras[0]] }],
    ["an extra's batch", { extras: [{ vaccineId: 'x', lotId: 'other' }, visit.extras[1]] }],
  ])('mints new ids after a change to %s', (_, change) => {
    const first = visitIds(null, visit, actions());
    const next = visitIds(first, { ...visit, ...change }, actions('b'));
    expect(next.main).toBe('b-1');
    expect(Object.values(next.extras).every((id) => id.startsWith('b-'))).toBe(true);
  });
});

describe('recordVisit: one Give, several vaccines', () => {
  const setup = async () => {
    const e = await env();
    const visit: Visit = {
      vaccineId: e.id.Rotavac, doses: 1, lotId: null, patientId: null, patientLabel: 'Asha', note: 'Dose 2',
      extras: [{ vaccineId: e.id.Hexaxim, lotId: null }, { vaccineId: e.id.Varilrix, lotId: null }],
    };
    const count = async () =>
      (await e.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements`))!.n;
    return { ...e, visit, count };
  };

  it('replays the same inputs as a no-op, rows and backup count included', async () => {
    const { db, ctx, visit, count } = await setup();
    const ids = visitIds(null, visit);
    const first = await recordVisit(db, ctx, ids, visit);
    const again = await recordVisit(db, ctx, visitIds(ids, visit), visit);

    expect(await count()).toBe(3);
    expect([again.main, ...again.extras].map((r) => r.created)).toEqual([false, false, false]);
    expect([again.main, ...again.extras].map((r) => r.movement.id)).toEqual(
      [first.main, ...first.extras].map((r) => r.movement.id),
    );
    expect(await getNumber(db, SETTING.dosesSinceBackup)).toBe(3);
  });

  it('writes what the new inputs say when they changed, never the earlier row', async () => {
    const { db, ctx, visit } = await setup();
    const ids = visitIds(null, visit);
    await recordVisit(db, ctx, ids, visit);
    const changed = { ...visit, patientLabel: 'Ravi', doses: 2 };
    const r = await recordVisit(db, ctx, visitIds(ids, changed), changed);

    expect(r.main.created).toBe(true);
    expect(r.main.movement).toMatchObject({ patient_label: 'Ravi', delta_doses: -2, note: 'Dose 2' });
    expect(r.extras.map((x) => x.movement.patient_label)).toEqual(['Ravi', 'Ravi']);
  });

  it('reports the dose written when the bookkeeping after it fails', async () => {
    const { db, ctx, visit, count } = await setup();
    // The backup count is a settings write; make every one of them fail.
    const busy: Db = {
      exec: (s) => db.exec(s),
      run: (s, p) => (s.includes('settings') ? Promise.reject(new Error('database is locked')) : db.run(s, p)),
      all: (s, p) => db.all(s, p),
      first: (s, p) => db.first(s, p),
      tx: (fn) => db.tx(fn),
    };
    const r = await recordVisit(busy, ctx, visitIds(null, visit), visit);
    expect(r.main.created).toBe(true);
    expect(r.failed).toEqual([]);
    expect(await count()).toBe(3);
  });

  it('keeps the main dose when an added vaccine fails, and names that one', async () => {
    const { db, ctx, id, visit, count } = await setup();
    const withBad = { ...visit, extras: [...visit.extras, { vaccineId: 'no-such-vaccine', lotId: null }] };
    const r = await recordVisit(db, ctx, visitIds(null, withBad), withBad);
    expect(r.failed).toEqual(['no-such-vaccine']);
    expect(r.extras.map((x) => x.movement.vaccine_id)).toEqual([id.Hexaxim, id.Varilrix]);
    expect(await count()).toBe(3);
  });

  it('replays a main dose that was written although its call failed', async () => {
    const { db, ctx, visit, count } = await setup();
    // The insert commits, then reading the row back fails, once.
    let failOnce = true;
    const flaky: Db = {
      exec: (s) => db.exec(s),
      run: (s, p) => db.run(s, p),
      all: (s, p) => db.all(s, p),
      first: (s, p) => {
        if (failOnce && s.includes('idempotency_key')) {
          failOnce = false;
          return Promise.reject(new Error('disk I/O error'));
        }
        return db.first(s, p);
      },
      tx: (fn) => db.tx(fn),
    };
    const ids = visitIds(null, visit);
    await expect(recordVisit(flaky, ctx, ids, visit)).rejects.toThrow('disk I/O error');
    expect(await count()).toBe(1);

    const r = await recordVisit(flaky, ctx, visitIds(ids, visit), visit);
    expect(r.main.created).toBe(false);
    expect(r.extras.map((x) => x.created)).toEqual([true, true]);
    expect(await count()).toBe(3);
    // The replayed dose was counted by neither call; the backup nag is behind by one, never ahead.
    expect(await getNumber(db, SETTING.dosesSinceBackup)).toBe(2);
  });

  it('fails when the main dose fails, so the retry can replay it', async () => {
    const { db, ctx, visit, count } = await setup();
    const bad = { ...visit, vaccineId: 'no-such-vaccine' };
    await expect(recordVisit(db, ctx, visitIds(null, bad), bad)).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it('undoing every row it returned leaves no dose given and the stock as it was', async () => {
    const { db, ctx, id, visit, next } = await setup();
    const r = await recordVisit(db, ctx, visitIds(null, visit), visit);
    for (const w of [r.main, ...r.extras]) {
      await reverseMovement(db, ctx, { clientActionId: next(), movementId: w.movement.id });
    }
    expect(await dosesGiven(db, '2026-09-06')).toEqual([]);
    const onHand = await db.all<{ on_hand_doses: number }>(
      `SELECT on_hand_doses FROM v_stock_on_hand WHERE vaccine_id IN (?, ?, ?)`,
      [id.Rotavac, id.Hexaxim, id.Varilrix],
    );
    expect(onHand.map((s) => s.on_hand_doses)).toEqual([0, 0, 0]);
  });
});
