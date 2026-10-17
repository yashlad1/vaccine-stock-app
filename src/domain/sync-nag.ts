/**
 * When to say out loud that entries have not reached the server.
 *
 * Uploading is automatic - after each entry, on opening the app, and every 15
 * minutes - so in normal use this says nothing at all. It exists for the case
 * where automatic uploading is quietly NOT working: no signal for hours, wrong
 * credentials, a server that has gone away. Nobody should have to go looking
 * through menus to discover that.
 *
 * Deliberately silent during ordinary operation. An indicator that appears for
 * four seconds after every dose is noise, and noise is how a real warning gets
 * ignored. So it waits until entries are genuinely stranded.
 */

export type SyncNagLevel = 'none' | 'behind' | 'stuck';

export const SYNC_NAG = {
  /** Below this, the automatic upload has almost certainly just not run yet. */
  quietMinutes: 30,
  /** This many stranded entries is worth mentioning whatever the clock says. */
  loudPending: 20,
  /** Half a working day with no successful upload is a fault, not a delay. */
  stuckHours: 4,
} as const;

export interface SyncNagInput {
  pending: number;
  lastOkAt: number | null;
  now: number;
}

export interface SyncNag {
  level: SyncNagLevel;
  message: string;
}

const MIN = 60_000;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function syncNag(input: SyncNagInput): SyncNag {
  const { pending, lastOkAt, now } = input;

  // Nothing waiting means nothing to say, regardless of how long it has been.
  if (pending <= 0) return { level: 'none', message: '' };

  const minsSinceOk = lastOkAt === null ? Infinity : Math.floor((now - lastOkAt) / MIN);
  const entries = plural(pending, 'entry', 'entries');

  // Never uploaded at all, but only a little waiting: the first upload may
  // simply not have happened yet. Stay quiet until it is worth a look.
  if (minsSinceOk < SYNC_NAG.quietMinutes && pending < SYNC_NAG.loudPending) {
    return { level: 'none', message: '' };
  }

  if (minsSinceOk >= SYNC_NAG.stuckHours * 60) {
    return {
      level: 'stuck',
      message:
        `${entries} have not reached the server. Check the internet connection. ` +
        `Everything is still saved on this phone.`,
    };
  }

  return {
    level: 'behind',
    message: `${entries} waiting to upload. They will go on their own when there is signal.`,
  };
}
