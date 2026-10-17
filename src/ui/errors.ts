/**
 * Turning failures into sentences a clinician can act on.
 *
 * The rule that shapes every message here: SAY WHETHER THE DATA WAS SAVED.
 *
 * A silent failure is the worst outcome this app can produce. If a tap does
 * nothing and says nothing, she reasonably assumes the dose was recorded, and
 * recorded stock begins drifting from the fridge - which is failure mode 2, the
 * thing the whole append-only design exists to prevent. So an error message
 * that ends "Nothing was saved." is doing more work than one that merely says
 * something went wrong.
 *
 * Raw constraint text is never shown. "SQLITE_CONSTRAINT: UNIQUE constraint
 * failed: vaccines.name" is not a sentence, and it is frightening.
 */

export interface ActionLabels {
  /** What she was trying to do, lower case, e.g. "record this dose". */
  what: string;
}

const has = (s: string, needle: string) => s.toLowerCase().includes(needle.toLowerCase());

export function friendlyError(err: unknown, { what }: ActionLabels): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  // The append-only triggers. These fire only on a programming mistake, but if
  // one ever reaches her, it must not read like data loss - because it isn't.
  if (has(raw, 'append-only')) {
    return 'Past entries cannot be edited. Add a correction instead. Nothing was changed.';
  }
  if (has(raw, 'cannot reverse a REVERSAL')) {
    return 'That entry is already a correction. Record a new entry instead.';
  }

  if (has(raw, 'UNIQUE constraint failed: vaccines.name') || has(raw, 'ux_vaccines_name')) {
    return 'A vaccine with that name is already in the catalog. Nothing was added.';
  }
  if (has(raw, 'UNIQUE constraint failed')) {
    return 'That has already been recorded, so it was not added twice.';
  }
  if (has(raw, 'FOREIGN KEY constraint failed')) {
    return `Could not ${what}: something it refers to is no longer in the app. Nothing was saved.`;
  }
  if (has(raw, 'CHECK constraint failed')) {
    return `Could not ${what}: one of the values is not allowed. Nothing was saved.`;
  }
  if (has(raw, 'database is locked') || has(raw, 'SQLITE_BUSY')) {
    return `The app was busy saving something else. Nothing was saved. Please try again.`;
  }
  if (has(raw, 'no such table') || has(raw, 'no such column')) {
    return 'This copy of the app does not match your saved data. Please update the app.';
  }
  if (has(raw, 'disk') || has(raw, 'SQLITE_FULL')) {
    return 'The phone is out of storage. Nothing was saved. Free some space and try again.';
  }

  // Network, for the sync paths only. Local data entry never touches a network.
  if (has(raw, 'Network request failed') || has(raw, 'fetch') || has(raw, 'timeout')) {
    return 'No internet connection. Your entries are safe on this phone and will upload later.';
  }
  if (has(raw, 'SyncAuthError') || has(raw, 'Invalid login') || has(raw, '401')) {
    return 'The server rejected the login. Check the details in Settings. Your data is safe on this phone.';
  }

  return `Could not ${what}. Nothing was saved. Please try again.`;
}
