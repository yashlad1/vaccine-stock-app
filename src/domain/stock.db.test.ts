import { belowZeroNote, describeStock, dosesFromVials, formatDelta, stockLevel } from './stock';

describe('vial <-> dose arithmetic (the clinician never multiplies)', () => {
  it('converts vials to doses', () => {
    expect(dosesFromVials(10, 5)).toBe(50); // 5 BCG vials = 50 doses
    expect(dosesFromVials(20, 1)).toBe(20); // 1 OPV vial = 20 doses
    expect(dosesFromVials(1, 7)).toBe(7); // prefilled syringes
  });
});

describe('low-stock boundary', () => {
  it('fires at <= min_balance, not <', () => {
    // Off-by-one here means a vaccine runs out silently.
    expect(stockLevel(11, 10)).toBe('OK');
    expect(stockLevel(10, 10)).toBe('LOW');
    expect(stockLevel(9, 10)).toBe('LOW');
  });

  it('distinguishes OUT from LOW from NEGATIVE', () => {
    expect(stockLevel(0, 10)).toBe('OUT');
    expect(stockLevel(-3, 10)).toBe('NEGATIVE');
  });

  it('treats a min_balance of 0 as "no threshold set"', () => {
    expect(stockLevel(1, 0)).toBe('OK');
    expect(stockLevel(0, 0)).toBe('OUT');
  });
});

describe('stock display', () => {
  it('shows stock in doses only', () => {
    expect(describeStock(24, 20).primary).toBe('24 doses');
    expect(describeStock(18, 10).primary).toBe('18 doses');
  });

  it('singularises', () => {
    expect(describeStock(1, 0).primary).toBe('1 dose');
    expect(describeStock(-1, 0).primary).toBe('-1 dose');
  });

  it('always pairs a level with a WORD, never colour alone', () => {
    expect(describeStock(5, 10).badge).toBe('LOW');
    expect(describeStock(0, 10).badge).toBe('OUT');
    expect(describeStock(-2, 10).badge).toBe('CHECK');
    expect(describeStock(50, 10).badge).toBeUndefined();
  });
});

describe('ledger amount wording', () => {
  it('names the unit and signs positive and negative amounts', () => {
    expect(formatDelta(10)).toBe('+10 doses');
    expect(formatDelta(-1)).toBe('-1 dose');
    expect(formatDelta(-120)).toBe('-120 doses');
  });

  it('reads a vial-mode delivery in doses, never vials', () => {
    // 1 vial of 10 stays "+10 doses"; 2 vials of 10 is "+20 doses", not "+2".
    expect(formatDelta(dosesFromVials(10, 1))).toBe('+10 doses');
    expect(formatDelta(dosesFromVials(10, 2))).toBe('+20 doses');
  });
});

describe('why the headline and the strip disagree', () => {
  // The headline counts a below-zero vaccine as 0; the strip sums raw. Both
  // are right, so the screen has to say why rather than show two totals.
  it('says nothing at all when every vaccine is at or above zero', () => {
    expect(belowZeroNote([140, 0, 12])).toBe('');
  });

  it('names the gap so the two numbers reconcile', () => {
    const note = belowZeroNote([140, -23, 12]);
    expect(note).toContain('One vaccine is below zero by 23 doses');
    expect(note).toContain('A delivery was probably not logged');
  });

  it('counts several, and totals their shortfall', () => {
    expect(belowZeroNote([-5, -18, 40])).toContain('2 vaccines are below zero by 23 doses');
  });

  it('says "1 dose", not "1 doses"', () => {
    expect(belowZeroNote([-1])).toContain('below zero by 1 dose,');
  });
});
