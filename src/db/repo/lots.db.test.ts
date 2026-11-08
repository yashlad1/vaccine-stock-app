import { makeTestDb, T0 } from '../testing';
import { findOrCreateLot, lotsInStock, suggestLot } from './lots';
import { recordReceipt, recordAdministration } from '../../domain/ledger';

const BCG = { name: 'BCG', unit_mode: 'DOSE' as const, doses_per_vial: 1, min_balance_doses: 5 };
const TODAY = '2026-09-06';

async function setup(lots: Array<{ n: string; exp: string | null }>, usedLast?: string) {
  const { db, ctx, vaccineId } = await makeTestDb({ seed: [BCG] });
  const v = await vaccineId('BCG');
  for (const l of lots) {
    const id = await findOrCreateLot(db, { vaccineId: v, lotNumber: l.n, expiryDate: l.exp }, ctx.deviceId, T0);
    await recordReceipt(db, ctx, { clientActionId: `r${l.n}`, vaccineId: v, lotId: id, doses: 10 });
    if (l.n === usedLast) {
      await recordAdministration(db, ctx, { clientActionId: `a${l.n}`, vaccineId: v, lotId: id });
    }
  }
  const stocked = await lotsInStock(db, v);
  return suggestLot(stocked, TODAY)?.lot_number ?? null;
}

describe('preselected batch', () => {
  it('is the earliest expiry even when a later one was used most recently', async () => {
    const got = await setup(
      [{ n: '61625016A', exp: '2026-12-31' }, { n: '61G25016A', exp: '2027-06-30' }],
      '61G25016A',
    );
    expect(got).toBe('61625016A');
  });

  it('is the only batch when there is one', async () => {
    expect(await setup([{ n: 'A1', exp: '2027-01-31' }])).toBe('A1');
  });

  it('prefers a dated batch over one with no expiry', async () => {
    expect(await setup([{ n: 'U1', exp: null }, { n: 'D1', exp: '2027-01-31' }], 'U1')).toBe('D1');
  });

  it('takes the undated batch when none has an expiry', async () => {
    expect(await setup([{ n: 'U1', exp: null }, { n: 'U2', exp: null }], 'U2')).toBe('U1');
  });

  it('skips an expired batch', async () => {
    expect(await setup([{ n: 'OLD', exp: '2026-08-31' }, { n: 'NEW', exp: '2027-01-31' }], 'NEW')).toBe('NEW');
  });

  it('suggests nothing when every batch has expired', async () => {
    expect(await setup([{ n: 'OLD', exp: '2026-08-31' }])).toBeNull();
  });
});
