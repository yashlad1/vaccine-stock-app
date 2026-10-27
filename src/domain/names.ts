/**
 * The dose number typed into a child's NAME: "Asha 2 Dose", "Ravi Bd".
 *
 * On the clinic's records 25 of 33 saved children carried one, which split 5
 * real children into 11 records. It is a fact about the dose, not the child,
 * so the dose screen saves the child without it and moves it to the dose
 * number. `patient_label` on the ledger still keeps exactly what was typed.
 */
export type DoseNote = 'Dose 1' | 'Dose 2' | 'Dose 3' | 'Booster';

// One trailing token, only after whitespace: "1 Dose", "2nd dose", "3rd Dose",
// "Bd", "2 Bd", "Booster". "Bd" is a booster, judging by the ages on it.
const TOKEN = /\s+(?:([123])(?:st|nd|rd)?\s*dose|(?:[123]\s*)?(?:bd|booster))$/i;

export function stripDoseToken(typed: string): { name: string; dose: DoseNote | null } {
  const name = typed.trim();
  const m = TOKEN.exec(name);
  const rest = m ? name.slice(0, m.index) : '';
  // "1 Bd" alone is not a name with a token on it; leave it as typed.
  if (!m || !/[a-z]/i.test(rest)) return { name, dose: null };
  return { name: rest, dose: m[1] ? (`Dose ${m[1]}` as DoseNote) : 'Booster' };
}
