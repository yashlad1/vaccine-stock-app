import { formatRupees, parseRupees } from './money';

describe('formatRupees', () => {
  it.each([
    [0, '₹0'],
    [999, '₹999'],
    [1000, '₹1,000'],
    [12345, '₹12,345'],
    [123456, '₹1,23,456'],
    [1234567, '₹12,34,567'],
    [-1250, '-₹1,250'],
  ])('%d -> %s', (n, out) => expect(formatRupees(n)).toBe(out));
});

describe('parseRupees', () => {
  it.each([
    ['', null],
    ['  ', null],
    ['1250', 1250],
    ['₹1,250', 1250],
    ['12.5', undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['12345678', undefined],
  ])('%j -> %s', (t, out) => expect(parseRupees(t)).toBe(out));
});
