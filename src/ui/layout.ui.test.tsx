import { columnsFor, contentWidthFor, gutterFor, tileWidthFor } from './layout';

describe('tablet layout policy', () => {
  it.each([
    [360, 16, 2],
    [390, 16, 2],
    [600, 24, 3],
    [800, 24, 4],
    [1000, 24, 5],
  ])('%idp window: gutter %i, %i columns', (w, gutter, cols) => {
    expect(gutterFor(w)).toBe(gutter);
    expect(contentWidthFor(w)).toBe(w - 2 * gutter);
    expect(columnsFor(w)).toBe(cols);
  });

  it('tiles land near 180dp on a tablet and keep the phone width on a phone', () => {
    for (const w of [600, 800, 1000]) expect(Math.abs(tileWidthFor(w) - 180)).toBeLessThan(6);
    expect(tileWidthFor(390)).toBe(173); // (358 - 12) / 2, as before
  });

  it('never goes under 2 or over 6 columns', () => {
    expect(columnsFor(200)).toBe(2);
    expect(columnsFor(2400)).toBe(6);
  });
});
