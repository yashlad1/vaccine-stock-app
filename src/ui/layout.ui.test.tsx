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

  // The grid gives every tile tileWidthFor(w) (an explicit width, not flex: 1),
  // so a row's tiles plus gaps never exceed the content and a partial last row
  // is not stretched. Full-row width must equal what flex: 1 + gap produced.
  it.each([360, 390, 600, 800, 1000])('%idp: every tile is tileWidthFor, in full and partial rows', (w) => {
    const cols = columnsFor(w);
    const tile = tileWidthFor(w);
    const flexFull = (contentWidthFor(w) - (cols - 1) * 12) / cols; // old flex: 1 width of a full row
    expect(tile).toBe(flexFull);
    for (const count of [1, cols + 1, 2 * cols + 1, 21]) {
      const lastRow = count % cols || cols;
      // Last row's tiles are the same width as a full row's, so a row of one is not stretched.
      expect(tile * lastRow + (lastRow - 1) * 12).toBeLessThanOrEqual(contentWidthFor(w));
      if (lastRow < cols) expect(tile).toBeLessThan(contentWidthFor(w) / lastRow);
    }
  });
});
