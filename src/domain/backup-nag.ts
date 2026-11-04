/**
 * When to nag about backups.
 *
 * The COUNT trigger matters as much as the time trigger: a busy immunisation
 * morning is exactly when 40 unbacked entries are sitting on one phone. Time
 * alone would stay quiet through it.
 *
 * The nag is never modal and never blocking. It must not stand between the
 * doctor and logging a dose.
 */

import { formatDate } from './time';
import { syncNag } from './sync-nag';

export type NagLevel = 'none' | 'due' | 'overdue';

export const NAG = {
  dueAfterDays: 3,
  dueAfterDoses: 25,
  overdueAfterDays: 14,
} as const;

export interface NagInput {
  lastBackupAt: number | null;
  dosesSinceBackup: number;
  now: number;
  /** Suppresses the banner for 24h after "Later". */
  snoozedUntil?: number | null;
  /**
   * The server copy (section 10a). All three are optional, and leaving them
   * out nags exactly as before: a call site that forgets them must fall back
   * to WARNING, never to silence.
   */
  /** Server backup switched on and configured on this device. */
  serverOn?: boolean;
  /** Entries written here that the server has not acknowledged yet. */
  pendingUploads?: number;
  /** When an upload last finished successfully, or null if one never has. */
  lastUploadAt?: number | null;
}

export interface Nag {
  level: NagLevel;
  message: string;
}

const DAY = 86_400_000;

const dateLabel = formatDate;

/**
 * Is every entry already somewhere other than this tablet?
 *
 * Since 27 Oct 2026 the server is copied by machines 8 times a day (section
 * 10a), so a zip the clinician makes by hand is no longer the only second
 * copy. When the server already holds everything, demanding one daily is
 * false alarm: it spent six weeks red on the clinic's only tablet while every
 * dose was in fact being copied, which is how a real warning gets ignored.
 *
 * This must stay conservative. It silences a data-safety warning, so it may
 * only return true when the entries are genuinely somewhere else. It is NOT
 * about whether sync is switched on; it is about whether sync has worked.
 */
export function coveredByServer(input: NagInput): boolean {
  const { serverOn, pendingUploads = 0, lastUploadAt = null, now } = input;

  // No server configured, or nothing has ever arrived there: the zip the
  // clinician makes by hand is still the only second copy.
  if (!serverOn || lastUploadAt === null) return false;

  // Reuse the upload banner's own thresholds rather than inventing a second
  // set. While THAT banner is content, uploading is working and the server
  // holds the ledger. The moment it starts warning, the zip is the right
  // fallback again and this nag returns alongside it - which is why the two
  // are deliberately allowed to appear together rather than cancelling out.
  // In particular `syncNag` is quiet whenever nothing is pending at all, so a
  // few seconds of dirty rows after each dose cannot flicker this banner back.
  return syncNag({ pending: pendingUploads, lastOkAt: lastUploadAt, now }).level === 'none';
}

export function backupNag(input: NagInput): Nag {
  const { lastBackupAt, dosesSinceBackup, now } = input;

  // Covered elsewhere: say nothing. The Server backup screen still shows the
  // real state, and `syncNag` still shouts when uploads actually fall behind.
  if (coveredByServer(input)) return { level: 'none', message: '' };

  // Never backed up, but nothing to lose yet - stay quiet rather than nag on a
  // freshly installed app.
  if (lastBackupAt === null && dosesSinceBackup === 0) return { level: 'none', message: '' };

  const days = lastBackupAt === null ? Infinity : Math.floor((now - lastBackupAt) / DAY);

  // Decide level and wording first, THEN apply the snooze. The snooze check
  // used to sit after an early return for the never-backed-up case, so "Later"
  // was silently ignored on exactly the state every new install starts in: the
  // setting was written, the banner re-rendered, and this function returned
  // 'due' again. Level is computed once here so that cannot recur.
  const nag: Nag =
    lastBackupAt === null
      ? {
          level: dosesSinceBackup >= NAG.dueAfterDoses ? 'overdue' : 'due',
          message:
            `Back up now: ${dosesSinceBackup} ` +
            `${dosesSinceBackup === 1 ? 'entry has' : 'entries have'} never been backed up.`,
        }
      : days >= NAG.overdueAfterDays
        ? {
            level: 'overdue',
            message: `Back up now: last backup was ${days} days ago (${dateLabel(lastBackupAt)}).`,
          }
        : days >= NAG.dueAfterDays || dosesSinceBackup >= NAG.dueAfterDoses
          ? {
              level: 'due',
              message:
                `Back up now: ${
                  dosesSinceBackup >= NAG.dueAfterDoses
                    ? `${dosesSinceBackup} entries since ${dateLabel(lastBackupAt)}`
                    : `last backup ${dateLabel(lastBackupAt)}`
                }.`,
            }
          : { level: 'none', message: '' };

  // A snooze only silences the amber state. Overdue is not snoozable, because
  // at two weeks the risk outweighs the annoyance.
  if (nag.level === 'due' && input.snoozedUntil && now < input.snoozedUntil) {
    return { level: 'none', message: '' };
  }
  return nag;
}

export function lastBackupLabel(lastBackupAt: number | null): string {
  if (lastBackupAt === null) return 'Last backup: never';
  const d = new Date(lastBackupAt);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const time = `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  return `Last backup: ${dateLabel(lastBackupAt)}, ${time}`;
}
