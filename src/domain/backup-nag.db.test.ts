import { NAG, backupNag, coveredByServer, lastBackupLabel } from './backup-nag';

const DAY = 86_400_000;
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 8, 6, 12, 0);

/** The clinic's real state: red for weeks, while every dose was on the server. */
const UPLOADING = { serverOn: true, pendingUploads: 0, lastUploadAt: NOW - 60_000 };

describe('the server as the second copy', () => {
  // The clinic ran 55 days red on its only tablet while the server held every
  // dose and copied itself 8 times a day. The nag was asking for a zip that
  // had stopped being the only safeguard on 27 Oct 2026.
  it('goes quiet two months overdue when every entry is on the server', () => {
    const stranded = { lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW };
    expect(backupNag(stranded).level).toBe('overdue');
    expect(backupNag({ ...stranded, ...UPLOADING }).level).toBe('none');
  });

  it('still nags when server backup is switched off', () => {
    const off = { ...UPLOADING, serverOn: false };
    expect(backupNag({ lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW, ...off }).level).toBe('overdue');
  });

  it('still nags when sync is configured but has never once succeeded', () => {
    // Wrong password since setup: switched on proves nothing.
    const never = { serverOn: true, pendingUploads: 40, lastUploadAt: null };
    expect(coveredByServer({ lastBackupAt: null, dosesSinceBackup: 40, now: NOW, ...never })).toBe(false);
  });

  it('does not flicker back during the seconds a dose is waiting to upload', () => {
    const justWritten = { serverOn: true, pendingUploads: 1, lastUploadAt: NOW - 10_000 };
    expect(coveredByServer({ lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW, ...justWritten })).toBe(true);
  });

  it('comes back the moment uploads are genuinely stuck', () => {
    // Four hours behind with entries waiting is a fault, not a delay - and a
    // zip is exactly the right fallback, so both banners show together.
    const stuck = { serverOn: true, pendingUploads: 12, lastUploadAt: NOW - 5 * HOUR };
    expect(coveredByServer({ lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW, ...stuck })).toBe(false);
    expect(backupNag({ lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW, ...stuck }).level).toBe('overdue');
  });

  it('a call site that forgets the server fields nags, never goes silent', () => {
    expect(coveredByServer({ lastBackupAt: NOW - 55 * DAY, dosesSinceBackup: 190, now: NOW })).toBe(false);
  });
});

describe('backup nag', () => {
  it('stays quiet on a fresh install with nothing to lose', () => {
    expect(backupNag({ lastBackupAt: null, dosesSinceBackup: 0, now: NOW }).level).toBe('none');
  });

  it('stays quiet just after a backup', () => {
    expect(backupNag({ lastBackupAt: NOW - DAY, dosesSinceBackup: 3, now: NOW }).level).toBe('none');
  });

  it('goes amber after 3 days', () => {
    expect(backupNag({ lastBackupAt: NOW - 3 * DAY, dosesSinceBackup: 1, now: NOW }).level).toBe('due');
  });

  it('goes amber on dose COUNT even when the last backup was recent', () => {
    // The case time-only logic misses: a single busy immunisation morning.
    const nag = backupNag({ lastBackupAt: NOW - 6 * 3600_000, dosesSinceBackup: NAG.dueAfterDoses, now: NOW });
    expect(nag.level).toBe('due');
    expect(nag.message).toContain('41'.slice(0, 0) + '25 entries');
  });

  it('goes red after 14 days', () => {
    const nag = backupNag({ lastBackupAt: NOW - 14 * DAY, dosesSinceBackup: 0, now: NOW });
    expect(nag.level).toBe('overdue');
    expect(nag.message).toContain('14 days ago');
  });

  it('nags when there has NEVER been a backup but doses exist', () => {
    const nag = backupNag({ lastBackupAt: null, dosesSinceBackup: 4, now: NOW });
    expect(nag.level).toBe('due');
    expect(nag.message).toContain('never been backed up');
  });

  it('escalates a never-backed-up phone with many entries straight to red', () => {
    expect(backupNag({ lastBackupAt: null, dosesSinceBackup: 40, now: NOW }).level).toBe('overdue');
  });

  it('honours a snooze for the amber state', () => {
    const base = { lastBackupAt: NOW - 4 * DAY, dosesSinceBackup: 1, now: NOW };
    expect(backupNag(base).level).toBe('due');
    expect(backupNag({ ...base, snoozedUntil: NOW + DAY }).level).toBe('none');
  });

  it('does NOT let a snooze silence the red state', () => {
    // At two weeks the risk of losing the ledger outweighs the annoyance.
    const nag = backupNag({
      lastBackupAt: NOW - 20 * DAY, dosesSinceBackup: 1, now: NOW, snoozedUntil: NOW + DAY,
    });
    expect(nag.level).toBe('overdue');
  });
});

describe('last backup label', () => {
  it('is explicit when there has never been one', () => {
    expect(lastBackupLabel(null)).toBe('Last backup: never');
  });

  it('shows date and 12-hour time so she can answer "am I safe?" without tapping', () => {
    const at = new Date(2026, 8, 4, 18, 30).getTime();
    expect(lastBackupLabel(at)).toBe('Last backup: 4 Sep, 6:30 pm');
  });
});
