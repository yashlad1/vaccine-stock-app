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

/** Centres content on a wide screen and leaves a phone untouched. */
export const centred = { width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' } as const;

/**
 * How many vaccine tiles fit across.
 *
 * Two on a phone, as designed. The grid sits in the same centred CONTENT_MAX
 * column as every other tab (owner, 27 Oct 2026): tiles running edge to edge
 * of a tablet invite a miss at the screen's edge. A tile twice the size is not
 * twice as easy to hit either; it just pushes the rest of the grid off the
 * screen, so the column's extra room goes into a third tile, not wider ones.
 */
export function useColumns(): number {
  const { width } = useWindowDimensions();
  // Counted from the CAPPED width. An earlier cap counted from the window, so
  // tiles shrank as the screen grew (123dp on a 10-inch tablet). Three across
  // 560dp is ~168dp a tile, inside a phone's 158-184.
  return Math.min(width, CONTENT_MAX) >= 540 ? 3 : 2;
}

/** True on a tablet-sized screen. For the rare case where layout must differ. */
export function useIsWide(): boolean {
  return useWindowDimensions().width >= 600;
}
