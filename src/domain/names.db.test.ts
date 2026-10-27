import { stripDoseToken } from './names';

describe('stripDoseToken', () => {
  it.each([
    ['Asha 1 Dose', 'Asha', 'Dose 1'],
    ['Asha 2 Dose', 'Asha', 'Dose 2'],
    ['Asha 3 Dose', 'Asha', 'Dose 3'],
    ['Asha 1st dose', 'Asha', 'Dose 1'],
    ['Asha 2nd dose', 'Asha', 'Dose 2'],
    ['Asha 3rd Dose', 'Asha', 'Dose 3'],
    ['Asha Bd', 'Asha', 'Booster'],
    ['Asha 2 Bd', 'Asha', 'Booster'],
    ['Asha Booster', 'Asha', 'Booster'],
    ['Asha Rao 2 Dose', 'Asha Rao', 'Dose 2'],
  ])('%s -> %s, %s', (typed, name, dose) => {
    expect(stripDoseToken(typed)).toEqual({ name, dose });
  });

  it('matches any case', () => {
    expect(stripDoseToken('asha 2ND DOSE')).toEqual({ name: 'asha', dose: 'Dose 2' });
    expect(stripDoseToken('Ravi bD')).toEqual({ name: 'Ravi', dose: 'Booster' });
    expect(stripDoseToken('Ravi BOOSTER')).toEqual({ name: 'Ravi', dose: 'Booster' });
  });

  it('only strips after whitespace, so a name ending in those letters is kept', () => {
    expect(stripDoseToken('Abd')).toEqual({ name: 'Abd', dose: null });
    expect(stripDoseToken('Asha Abd')).toEqual({ name: 'Asha Abd', dose: null });
    expect(stripDoseToken('Rosebd')).toEqual({ name: 'Rosebd', dose: null });
  });

  it('leaves a token on its own alone', () => {
    expect(stripDoseToken('Booster')).toEqual({ name: 'Booster', dose: null });
    expect(stripDoseToken('Bd')).toEqual({ name: 'Bd', dose: null });
    expect(stripDoseToken('2 Dose')).toEqual({ name: '2 Dose', dose: null });
    expect(stripDoseToken('1 Bd')).toEqual({ name: '1 Bd', dose: null });
  });

  it('copes with extra spaces', () => {
    expect(stripDoseToken('  Asha   2   Dose  ')).toEqual({ name: 'Asha', dose: 'Dose 2' });
    expect(stripDoseToken('Asha  Bd ')).toEqual({ name: 'Asha', dose: 'Booster' });
  });

  it('removes one token only, and nothing from a name without one', () => {
    expect(stripDoseToken('Asha Rao')).toEqual({ name: 'Asha Rao', dose: null });
    expect(stripDoseToken(' Asha ')).toEqual({ name: 'Asha', dose: null });
    expect(stripDoseToken('Asha 4 Dose')).toEqual({ name: 'Asha 4 Dose', dose: null });
    expect(stripDoseToken('Asha Bd 2 Dose')).toEqual({ name: 'Asha Bd', dose: 'Dose 2' });
  });
});
