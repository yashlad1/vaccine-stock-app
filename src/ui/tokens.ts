import { Platform, type ViewStyle } from 'react-native';

/**
 * Design tokens.
 *
 * The look is clinic-queue's (see `color`). "Modern" still never means thin
 * weights, small text or low contrast. Every floor below is a requirement from
 * CLAUDE.md section 8, because the user is a practising pediatrician, likely
 * 50+, working one-handed between patients in a brightly lit room.
 *
 * If a change makes a target smaller than 56dp, text smaller than 14pt, or a
 * state visible by colour alone, it is a regression regardless of how it looks.
 */

export const color = {
  /**
   * clinic-queue's palette (its docs/context/design/foundations.md), adopted
   * 16 Oct 2026 so the doctor's two apps read as one family: white surfaces on
   * a soft neutral ground, a hairline edge instead of a shadow, and one solid
   * colour per screen for the act that completes it.
   *
   * Where its rules and this app's floors disagree, the floor wins, the way
   * clinic-queue's own "what survived the brief" table works:
   *   - its `text-muted` (#64748B) is never TEXT here - CLAUDE.md section 8
   *     forbids grey below #46586F - only the edge of things she operates;
   *   - its 44px targets and 14-16px body are for a desk, not for a thumb
   *     between patients, so 56dp and 18pt stand (see `touch` and `type`);
   *   - its single teal primary becomes four accents, below.
   *
   * Every value is measured by contrast.db.test.ts, not asserted.
   */
  /** clinic-queue `bg`: the application ground, behind every surface. */
  bg: '#F6F8F7',
  /** Cards, tiles, inputs, the tab bar, list rows. */
  surface: '#FFFFFF',
  /** Neutral fills: the neutral badge, a pressed row. */
  surfaceSunken: '#F1F5F9',
  /** DECORATIVE edges only - card edges and row dividers. 1.2:1, so never alone on a control. */
  border: '#E2E8F0',
  /** The edge of anything she operates: inputs, chips, secondary buttons. 4.8:1, above the 3:1 bar. */
  borderControl: '#64748B',

  /** 17.9:1 on white. */
  text: '#0F172A',
  /** clinic-queue `text-2`. 7.6:1 on white, 7.0:1 on the ground. */
  textMuted: '#475569',
  onAccent: '#FFFFFF',

  /**
   * One accent per context, still a safety feature rather than styling.
   *
   * Give dose and Add stock move the ledger in opposite directions and sit
   * next to each other, so each keeps the hue it has had since the app went
   * live - blue for giving, teal for stock. Swapping them to give Give dose
   * clinic-queue's teal would point her learned colour at the wrong tab, the
   * one mistake this colour exists to prevent. The values are clinic-queue's
   * own: its primary teal, and the blue of its "Called" badge.
   */
  dose: '#1D4ED8', // blue-700 - Give dose
  doseSoft: '#DBEAFE',
  stock: '#0F766E', // clinic-queue primary - Add stock
  stockSoft: '#CCFBF1', // clinic-queue primary-soft
  catalog: '#6D28D9', // violet-700 - Vaccines; clinic-queue has no third hue
  catalogSoft: '#EDE9FE',
  more: '#334155', // slate-700, kept clear of textMuted

  /**
   * Reserved for stock LEVELS only; never reused as a context accent.
   * clinic-queue's success / warning / danger, with its rule that a badge's
   * text is the darker `Ink` shade: the base on its own soft ground is too
   * close to the floor (warning measures 4.5:1 there).
   */
  ok: '#15803D',
  okSoft: '#DCFCE7',
  okInk: '#166534',
  low: '#B45309',
  lowSoft: '#FEF3C7',
  lowInk: '#92400E',
  danger: '#B91C1C',
  dangerSoft: '#FEE2E2',
  dangerInk: '#991B1B',

  /**
   * Disabled is a token swap, never opacity. clinic-queue fades its disabled
   * primary to about 2:1; a greyed-out control here still has to be readable
   * to someone deciding whether it is disabled or the app is broken.
   */
  disabledText: '#475569',
  disabledFill: '#E2E8F0',

  /** UNDO on the dark toast. A token, so the contrast test can see it. */
  undo: '#93C5FD',

  /** Pressed-state overlay. */
  pressed: 'rgba(15, 23, 42, 0.06)',
} as const;

export type Accent = 'dose' | 'stock' | 'catalog' | 'more';

export const accentColor: Record<Accent, string> = {
  dose: color.dose,
  stock: color.stock,
  catalog: color.catalog,
  more: color.more,
};

export const accentSoft: Record<Accent, string> = {
  dose: color.doseSoft,
  stock: color.stockSoft,
  catalog: color.catalogSoft,
  more: color.surfaceSunken,
};

/** Minimum 56dp: Android's guideline is 48, and this user needs more. */
export const touch = {
  min: 56,
  cta: 64,
  tabBar: 60,
} as const;

export const type = {
  /** The numbers that matter: stock counts, today's total. */
  hero: 34,
  big: 28,
  /** Vaccine tile titles. */
  title: 22,
  /** Body and list rows. */
  body: 18,
  label: 16,
  /** Absolute floor. Nothing smaller, ever. */
  min: 14,
} as const;

export const weight = {
  bold: '700',
  semibold: '600',
  medium: '500',
  regular: '400',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * The original radii, kept on purpose (owner, 17 Oct 2026): the clinic-queue
 * restyle took its colours and wording, never its sizes. The doctor works
 * with these dimensions every day.
 */
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/**
 * At most one, very light, and only on a raised surface (the floating footer).
 * clinic-queue's rule: never under every card - edges and tints carry the
 * structure, so it still reads in a sunlit room where a shadow vanishes.
 */
export function elevation(level: 0 | 1 | 2 | 3): ViewStyle {
  if (level === 0) return {};
  const ios = {
    1: { shadowOpacity: 0.06, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
    2: { shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    3: { shadowOpacity: 0.12, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
  }[level];
  const web = {
    boxShadow: `0 ${level * 2}px ${level * 6}px rgba(16,35,58,${0.05 + level * 0.02})`,
  } as unknown as ViewStyle;
  return (Platform.select({
    ios: { shadowColor: color.text, ...ios } as ViewStyle,
    android: { elevation: level * 2 } as ViewStyle,
    default: web,
  }) ?? {}) as ViewStyle;
}

/**
 * Honour the system font scale - this cohort very often has Android's font AND
 * display size turned up. Cap only where clipping would break a layout.
 */
export const MAX_FONT_SCALE = 1.6;
