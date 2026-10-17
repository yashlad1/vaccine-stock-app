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
}

export interface Nag {
  level: NagLevel;
  message: string;
}

import { formatDate } from './time';

const DAY = 86_400_000;

const dateLabel = formatDate;

export function backupNag(input: NagInput): Nag {
  const { lastBackupAt, dosesSinceBackup, now } = input;

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
