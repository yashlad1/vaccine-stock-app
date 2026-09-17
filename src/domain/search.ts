/**
 * One matcher for every search box in the app.
 *
 * There were three, all hand-rolled `includes()` on the name, and all of them
 * ignored `aliases` - a column the schema carries FOR SEARCH and nothing else.
 * The one alias-aware query in the codebase, `searchVaccines`, was used only by
 * its own test. So "dpt" found nothing, while the data to find it was sitting
 * in the row.
 *
 * Three things a clinic search has to survive:
 *
 *   Punctuation. "Td (UIP)" and "Tresivac (MMR)" are real catalog names, and
 *   typing "td uip" or "mmr" must find them. Everything is normalised down to
 *   letters and digits, so brackets, dots and hyphens stop mattering.
 *
 *   Word starts. Typing "tetra" should find "Vaxigrip Tetra". A plain
 *   substring test does that too, but it cannot tell that "rota" matching
 *   "Rotavac" at the FRONT is a better answer than matching mid-word - and a
 *   grid sorted alphabetically buries the obvious one.
 *
 *   Several words. "vaxi tetra" is how people type when they half-remember a
 *   name. Every token has to land somewhere, in any order.
 */

export interface Searchable {
  name: string;
  generic_name?: string | null;
  /** JSON array as stored, or anything stringy. Parsed leniently. */
  aliases?: string | null;
}

/** Letters and digits only, single-spaced. Punctuation stops mattering. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function aliasText(aliases: string | null | undefined): string {
  if (!aliases) return '';
  try {
    const parsed: unknown = JSON.parse(aliases);
    if (Array.isArray(parsed)) return parsed.join(' ');
  } catch {
    // Not JSON. Treat it as plain text rather than losing the row.
  }
  return aliases;
}

/** Best score for one token against one field. 0 means no match. */
function fieldScore(field: string, token: string, weight: number): number {
  if (!field || !token) return 0;
  if (field === token) return weight + 40;
  if (field.startsWith(token)) return weight + 25;
  // Word start: " rota" inside "vaxigrip rotavac".
  if (field.includes(` ${token}`)) return weight + 15;
  if (field.includes(token)) return weight;
  return 0;
}

/**
 * How well an item answers a query. 0 means it does not - callers filter on it.
 * Every token must land somewhere, or a second word could only ever widen the
 * result, which is the opposite of what typing more is for.
 */
export function matchScore(item: Searchable, query: string): number {
  const q = normalise(query);
  if (!q) return 1; // no query: everything matches, order untouched
  const name = normalise(item.name);
  const generic = normalise(item.generic_name ?? '');
  const alias = normalise(aliasText(item.aliases));

  let total = 0;
  for (const token of q.split(' ')) {
    const best = Math.max(
      fieldScore(name, token, 100),
      fieldScore(generic, token, 60),
      fieldScore(alias, token, 50),
    );
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/**
 * Filter and rank. Ties keep the order they arrived in, so the home grid's
 * "most used in 30 days" survives inside an equally good match.
 */
export function searchRank<T extends Searchable>(items: readonly T[], query: string): T[] {
  // No empty-query guard: matchScore returns 1 for one, so every item ties and
  // the index tiebreak hands back the original order.
  return items
    .map((item, i) => ({ item, i, score: matchScore(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}
