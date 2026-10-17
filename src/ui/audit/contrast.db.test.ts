import { color, accentColor, accentSoft } from '../tokens';
import { WCAG, contrast, round1 } from './contrast';

/**
 * The accessibility floors from CLAUDE.md section 8, enforced rather than
 * documented. The user is a pediatrician, likely 50+, in a brightly lit room -
 * so these are requirements, and a palette change that breaks one is a
 * regression however good it looks.
 */

/**
 * Text sits on two grounds now: white surfaces (cards, tiles, inputs) and the
 * soft clinic-queue ground between them. Every pairing below is measured on
 * BOTH, because the ground is the darker of the two and the easy one to forget.
 */
const grounds = { surface: color.surface, bg: color.bg } as const;

describe('text on both grounds', () => {
  for (const [g, hex] of Object.entries(grounds)) {
    it(`body text is at least 15:1 on ${g}`, () => {
      expect(round1(contrast(color.text, hex))).toBeGreaterThanOrEqual(15);
    });

    it(`muted text clears the 7:1 grey floor on ${g}`, () => {
      // CLAUDE.md section 8 forbids any grey below #46586F (7.3:1 on white).
      // clinic-queue's own text-muted would fail this, which is why it is
      // only ever an edge here.
      expect(contrast(color.textMuted, hex)).toBeGreaterThanOrEqual(7);
    });
  }
});

describe('the edge of a control', () => {
  it('border-control clears 3:1 on both grounds (WCAG 2.2, 1.4.11)', () => {
    // Inputs, chips and secondary buttons are outlined in it; the decorative
    // `border` (about 1.2:1) must never be the only edge of one.
    for (const hex of Object.values(grounds)) {
      expect(contrast(color.borderControl, hex)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('every status colour on both grounds', () => {
  // These carry meaning, so they must be readable, not merely visible.
  const statuses = { ok: color.ok, low: color.low, danger: color.danger };
  for (const [name, hex] of Object.entries(statuses)) {
    for (const [g, ground] of Object.entries(grounds)) {
      it(`${name} (${hex}) is at least ${WCAG.AA}:1 on ${g}`, () => {
        expect(contrast(hex, ground)).toBeGreaterThanOrEqual(WCAG.AA);
      });
    }
  }
});

describe('every context accent on both grounds', () => {
  for (const [name, hex] of Object.entries(accentColor)) {
    for (const [g, ground] of Object.entries(grounds)) {
      it(`${name} (${hex}) is at least ${WCAG.AA}:1 on ${g}`, () => {
        expect(contrast(hex, ground)).toBeGreaterThanOrEqual(WCAG.AA);
      });
    }
  }
});

describe('accent text on its own soft background', () => {
  // Badges and chips put the accent colour on its soft tint, which is a
  // different and stricter pairing than accent-on-white.
  for (const accent of Object.keys(accentColor) as (keyof typeof accentColor)[]) {
    it(`${accent} on ${accent}Soft is at least ${WCAG.AA}:1`, () => {
      expect(contrast(accentColor[accent], accentSoft[accent])).toBeGreaterThanOrEqual(WCAG.AA);
    });
  }
});

describe('badge text on its soft background', () => {
  const pairs: [string, string, string][] = [
    // Badge.tsx paints the darker Ink shade, as clinic-queue's badge table does.
    ['ok', color.okInk, color.okSoft],
    ['low', color.lowInk, color.lowSoft],
    ['danger', color.dangerInk, color.dangerSoft],
    ['neutral', color.more, color.surfaceSunken],
  ];
  for (const [name, fg, bg] of pairs) {
    it(`${name} badge is at least ${WCAG.AA}:1`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(WCAG.AA);
    });
  }
});

describe('white on a filled accent button', () => {
  // BigButton fills with the accent and writes onAccent over it.
  for (const [name, hex] of Object.entries(accentColor)) {
    it(`onAccent on ${name} is at least ${WCAG.AA}:1`, () => {
      expect(contrast(color.onAccent, hex)).toBeGreaterThanOrEqual(WCAG.AA);
    });
  }
});

/**
 * Pairings the old palette had no tokens for, so the audit could not see them.
 *
 * clinic-queue fades its disabled primary to about 2:1, and the Aero schema's
 * disabled pair measured 3.7:1 - both below this app's floor, which is exactly
 * the kind of thing a test catches and a copied stylesheet does not.
 */
describe('states that used to sit outside the palette', () => {
  it('disabled text stays readable on the disabled fill', () => {
    expect(contrast(color.disabledText, color.disabledFill)).toBeGreaterThanOrEqual(WCAG.AA);
  });

  it('UNDO clears the floor on the toast it sits on', () => {
    // The most safety-critical control in the app: section 8 makes undo the
    // replacement for confirmation dialogs on the dose path.
    expect(contrast(color.undo, color.text)).toBeGreaterThanOrEqual(WCAG.AA);
  });
});

describe('every accent on its own soft tint', () => {
  // Selected chips and badges paint the accent ON the tint, not on white.
  const pairs = {
    dose: [color.dose, color.doseSoft],
    stock: [color.stock, color.stockSoft],
    catalog: [color.catalog, color.catalogSoft],
  } as const;
  for (const [name, [fg, bg]] of Object.entries(pairs)) {
    it(`${name} on its tint is at least ${WCAG.AA}:1`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(WCAG.AA);
    });
  }
});

describe('the report', () => {
  it('prints every ratio, so a regression is legible not just red', () => {
    const rows: [string, number][] = [
      ['text / surface', contrast(color.text, color.surface)],
      ['text / bg', contrast(color.text, color.bg)],
      ['textMuted / surface', contrast(color.textMuted, color.surface)],
      ['textMuted / bg', contrast(color.textMuted, color.bg)],
      ['borderControl / surface', contrast(color.borderControl, color.surface)],
      ['borderControl / bg', contrast(color.borderControl, color.bg)],
      ['ok / bg', contrast(color.ok, color.bg)],
      ['low / bg', contrast(color.low, color.bg)],
      ['danger / bg', contrast(color.danger, color.bg)],
      ['dose / bg', contrast(color.dose, color.bg)],
      ['stock / bg', contrast(color.stock, color.bg)],
      ['catalog / bg', contrast(color.catalog, color.bg)],
      ['more / bg', contrast(color.more, color.bg)],
      ['lowInk / lowSoft', contrast(color.lowInk, color.lowSoft)],
      ['dangerInk / dangerSoft', contrast(color.dangerInk, color.dangerSoft)],
      ['okInk / okSoft', contrast(color.okInk, color.okSoft)],
      ['more / surfaceSunken', contrast(color.more, color.surfaceSunken)],
      ['onAccent / dose', contrast(color.onAccent, color.dose)],
      ['onAccent / stock', contrast(color.onAccent, color.stock)],
      ['onAccent / catalog', contrast(color.onAccent, color.catalog)],
      ['onAccent / more', contrast(color.onAccent, color.more)],
      ['dose / doseSoft', contrast(color.dose, color.doseSoft)],
      ['stock / stockSoft', contrast(color.stock, color.stockSoft)],
      ['catalog / catalogSoft', contrast(color.catalog, color.catalogSoft)],
      ['disabledText / disabledFill', contrast(color.disabledText, color.disabledFill)],
      ['undo / toast', contrast(color.undo, color.text)],
    ];
    // eslint-disable-next-line no-console
    console.log(
      '\n' + rows.map(([k, v]) => `  ${round1(v).toFixed(1).padStart(5)}:1  ${k}`).join('\n'),
    );
    expect(rows.every(([, v]) => v > 1)).toBe(true);
  });
});
