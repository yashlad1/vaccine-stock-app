import type { Db } from '../driver';
import { LATEST_VERSION } from '../migrate';

export const BACKUP_FORMAT = 'clinic-stock-backup';
export const DB_ENTRY = 'clinic.db';
export const MANIFEST_ENTRY = 'manifest.json';

export interface BackupManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  deviceId: string;
  exportedAt: number;
  counts: Record<string, number>;
}

/** Tables whose loss would be unrecoverable. Absence means this is not our backup. */
export const REQUIRED_TABLES = [
  'vaccines',
  'lots',
  'patients',
  'staff',
  'stock_movements',
  'settings',
] as const;

export class BackupInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupInvalidError';
  }
}

/** What the restore screen compares, for the backup and for the phone alike. */
export interface LedgerSummary {
  doses: number;
  vaccines: number;
  latestEntryAt: number | null;
}

export interface BackupPreview extends LedgerSummary {
  schemaVersion: number;
  exportedAt: number | null;
  appVersion: string | null;
  counts: Record<string, number>;
}

/** Raw rows per table: the manifest's numbers, and the truncation check's. */
export async function tableCounts(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of REQUIRED_TABLES) {
    const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = row?.n ?? 0;
  }
  return counts;
}

/**
 * Doses actually given (an undone dose is not one) and vaccines still on the
 * list (a removed one is not). ONE function for both sides of the restore
 * confirmation: the backup's side once counted every row, so a backup of this
 * very phone read as more doses and vaccines than the phone.
 */
export async function ledgerSummary(db: Db): Promise<LedgerSummary> {
  const doses = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM v_movement_effective WHERE movement_type='ADMINISTRATION'`,
  );
  const vaccines = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM vaccines WHERE deleted_at IS NULL`,
  );
  const latest = await db.first<{ n: number | null }>(
    `SELECT MAX(occurred_at) AS n FROM stock_movements`,
  );
  return { doses: doses?.n ?? 0, vaccines: vaccines?.n ?? 0, latestEntryAt: latest?.n ?? null };
}

export function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupInvalidError('This backup is damaged - its manifest is not readable.');
  }
  const m = parsed as Partial<BackupManifest>;
  if (m?.format !== BACKUP_FORMAT) {
    throw new BackupInvalidError('This file is not a Vialbook backup.');
  }
  return m as BackupManifest;
}

/**
 * Inspect a CANDIDATE database before a single byte touches the live one.
 *
 * deserializeDatabaseAsync gives us an in-memory database, which is the gift
 * that makes this possible: the confirmation screen can show the doctor real
 * numbers instead of a generic scary warning.
 *
 * Every rejection carries a SPECIFIC message. "Restore failed" teaches nobody
 * anything and leaves her unsure whether her data is safe.
 */
export async function inspectBackup(
  candidate: Db,
  manifest?: BackupManifest | null,
): Promise<BackupPreview> {
  const vRow = await candidate.first<{ user_version: number }>('PRAGMA user_version');
  const schemaVersion = vRow?.user_version ?? 0;

  if (schemaVersion === 0) {
    throw new BackupInvalidError('This backup does not contain a Vialbook database.');
  }
  if (schemaVersion > LATEST_VERSION) {
    throw new BackupInvalidError(
      `This backup was made by a newer version of the app (data v${schemaVersion}, ` +
        `this app reads up to v${LATEST_VERSION}). Please update the app, then restore.`,
    );
  }

  const tables = await candidate.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  );
  const present = new Set(tables.map((t) => t.name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length) {
    throw new BackupInvalidError(
      `This backup is incomplete - it is missing: ${missing.join(', ')}.`,
    );
  }

  const counts = await tableCounts(candidate);

  // A manifest that disagrees with the file it describes means truncation or
  // tampering. Trust neither.
  if (manifest?.counts) {
    for (const [table, claimed] of Object.entries(manifest.counts)) {
      const actual = counts[table];
      if (actual !== undefined && actual !== claimed) {
        throw new BackupInvalidError(
          `This backup looks truncated: it claims ${claimed} ${table} rows but contains ${actual}.`,
        );
      }
    }
  }

  return {
    schemaVersion,
    exportedAt: manifest?.exportedAt ?? null,
    appVersion: manifest?.appVersion ?? null,
    counts,
    ...(await ledgerSummary(candidate)),
  };
}
