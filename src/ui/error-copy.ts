/**
 * What each failure tells her. Pure strings, so the words are Node-tested.
 *
 * ONE RULE: the SAFE line appears only where the failure cannot have touched
 * her records (a read, a share, a rejected file, anything on the network).
 * Where it could - a database that will not open, a restore that failed midway -
 * it is left out on purpose, because a reassurance that may be false is worse
 * than none. CLAUDE.md section 10a: sync failures are delivery delays, never
 * data loss.
 */

export const SAFE = 'Your records are still safe on this phone.';

export interface Problem {
  title: string;
  body: string;
  /** Show the SAFE line under the body. */
  safe: boolean;
  /** The one thing that fixes it, as a word. */
  action: string;
}

const has = (raw: string, ...needles: string[]) =>
  needles.some((n) => raw.toLowerCase().includes(n.toLowerCase()));

const rawOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** A screen's data failed to load. Reading changes nothing, so it is safe unless the file itself is damaged. */
export function loadProblem(error: unknown, what: string): Problem {
  const raw = rawOf(error);
  const title = `Could not ${what}`;
  if (has(raw, 'malformed', 'not a database', 'corrupt', 'SQLITE_NOTADB')) {
    return {
      title,
      body: 'Do not uninstall the app, because that deletes your records. Restore your latest backup from More, then Backup.',
      safe: false,
      action: 'Try again',
    };
  }
  if (has(raw, 'no such table', 'no such column')) {
    return { title, body: 'This copy of the app does not match your saved data. Update the app.', safe: true, action: 'Try again' };
  }
  return { title, body: 'Tap Try again. If it keeps failing, close the app and open it again.', safe: true, action: 'Try again' };
}

/** The database gate (`_layout.tsx`) failed: the guard against an older app, or any other failure to open. */
export function startupProblem(message: string): Problem {
  if (has(message, 'older than your saved')) {
    return {
      title: 'Update the app',
      body: 'This version is older than your saved records, so it has not opened them. Update the app to carry on.',
      safe: true,
      action: 'Check for update',
    };
  }
  return {
    title: 'Could not open your records',
    body: 'Close the app and open it again. If it keeps happening, do not uninstall it, because that deletes your records.',
    safe: false,
    action: 'Restart the app',
  };
}

/** Saving or sharing a backup failed. The records were only read. */
export function exportProblem(): Problem {
  return {
    title: 'Could not save your backup',
    body: 'Check that the phone has free space, then tap Try again.',
    safe: true,
    action: 'Try again',
  };
}

/**
 * A restore file was refused before anything was replaced. `reason` is the
 * specific sentence the importer already produced; it is kept word for word.
 */
export function restoreRejectedProblem(reason: string): Problem {
  return {
    title: 'Cannot use that file',
    body: `${reason} Choose a different backup file.`,
    safe: true,
    action: 'Choose another file',
  };
}

/** The restore itself failed after she confirmed. Whether the live data changed is not known, so no SAFE line. */
export function restoreFailedProblem(reason: string): Problem {
  return {
    title: 'Could not restore the backup',
    body: `${reason} Do not uninstall the app. Try again, or choose a different backup file.`,
    safe: false,
    action: 'Choose a file',
  };
}

/**
 * A sync failure, from the raw text the sync layer stores. Every branch is
 * safe: sync only ever copies out, and the phone is the source of truth.
 */
export function syncProblem(raw: string): string {
  if (has(raw, 'Sign-in failed', 'rejected this account', 'not accepted', 'Invalid login', '401', '403')) {
    return `The server did not accept the login. ${SAFE} Check the email and password on Server backup.`;
  }
  if (has(raw, 'tables are missing') || /\(4\d\d\)/.test(raw)) {
    return `The server is not ready for this version of the app. ${SAFE} Your entries will upload once the server is updated.`;
  }
  if (has(raw, 'network', 'fetch', 'timeout') || /\(5\d\d\)/.test(raw)) {
    return `No connection to the server. ${SAFE} Your entries will upload when it is back.`;
  }
  return `Could not reach the server. ${SAFE} Your entries will upload later.`;
}
