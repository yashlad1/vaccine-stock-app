import { useWindowDimensions } from 'react-native';

/**
 * Making the phone layout survive a 10-inch tablet.
 *
 * The type scale in CLAUDE.md section 8 was chosen for a phone, roughly 360-420
 * dp wide. Nothing about it is wrong on a tablet, but the CONTAINER is: an 18pt
 * line of text stretched across 800dp is a long measure and genuinely harder to
 * read than the same text in a phone-width column, and a full-width text input
 * for a six-character batch number just looks broken.
 *
 * So the fix is not to change the type, the touch targets or the colours - all
 * of which still apply - but to stop the CONTENT from stretching, and to use
 * the extra width for more columns instead of wider ones.
 */

/**
 * The widest a column of text or a form should ever get.
 *
 * Chosen to be a little more than a large phone, so a phone is completely
 * unaffected and a tablet reads as a comfortable centred column rather than a
 * stretched phone screen.
 */
export const CONTENT_MAX = 560;

/** Windows at or above this are a tablet held upright (portrait is locked). */
export const TABLET_MIN = 600;
/** Phone gutter, unchanged since launch (`space.lg`). */
const PHONE_GUTTER = 16;
const TABLET_GUTTER = 24;
const TILE_TARGET = 180;
const TILE_GAP = 12; // space.md, the gap between tiles

/** Side gutter at a window width: 16 on a phone, 24 from 600dp. */
export const gutterFor = (width: number) => (width < TABLET_MIN ? PHONE_GUTTER : TABLET_GUTTER);

/** The one content width of the app: window minus a gutter each side. */
export const contentWidthFor = (width: number) => width - 2 * gutterFor(width);

/**
 * Tile columns aiming at ~180dp a tile: floor(content / 180) kept in 2..6.
 * 2 on a phone, 3 at 600dp, 4 at 800dp, 5 at 1000dp (tiles 176-181dp).
 */
export const columnsFor = (width: number) =>
  Math.max(2, Math.min(6, Math.floor(contentWidthFor(width) / TILE_TARGET)));

/** Tile width the grid ends up with, for the tests. */
export const tileWidthFor = (width: number) => {
  const n = columnsFor(width);
  return (contentWidthFor(width) - (n - 1) * TILE_GAP) / n;
};

/**
 * Column style for lists, cards and rows: the full content width, centred.
 * Screens keep their own 16dp padding inside it, so on a tablet the column is
 * 8dp narrower each side (16 + 8 = the 24dp gutter). Below 600dp it is the
 * old full-width column, untouched.
 */
export function useWide() {
  const { width } = useWindowDimensions();
  return width < TABLET_MIN
    ? ({ width: '100%', alignSelf: 'center' } as const)
    : ({ width: '100%', maxWidth: width - 2 * (TABLET_GUTTER - PHONE_GUTTER), alignSelf: 'center' } as const);
}

/**
 * Column style for text, forms and CTAs: as `useWide`, but never past
 * CONTENT_MAX (a long 18pt measure and a stretched batch-number input read
 * badly). On a phone this is exactly the old rule.
 */
export function useCentred() {
  const { width } = useWindowDimensions();
  const wide = width < TABLET_MIN ? CONTENT_MAX : Math.min(CONTENT_MAX, width - 2 * (TABLET_GUTTER - PHONE_GUTTER));
  return { width: '100%', maxWidth: wide, alignSelf: 'center' } as const;
}

/** How many vaccine tiles fit across the content width. */
export function useColumns(): number {
  return columnsFor(useWindowDimensions().width);
}
