import * as SQLite from 'expo-sqlite';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import { zipSync, strToU8 } from 'fflate';
import type { Db } from '../driver';
import { collectCsvs } from './collect';
import { BACKUP_FORMAT, DB_ENTRY, MANIFEST_ENTRY, tableCounts, type BackupManifest } from './validate';
import { currentVersion } from '../migrate';

const BACKUP_DIR = 'backups';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function backupFileName(at: number = Date.now()): string {
  const d = new Date(at);
  return `clinic-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
}

export function backupsDirectory(): Directory {
  const dir = new Directory(Paths.document, BACKUP_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Build the backup bundle.
 *
 * Both formats go in one file, so the doctor never has to choose: the .db is
 * the only thing that restores losslessly (it carries UUIDs, reversal links and
 * soft deletes), while the CSVs are what she can actually open in Excel or
 * Google Sheets. ~50KB for a year of data, which sends fine over WhatsApp.
 */
export async function buildBackupBundle(
  db: Db,
  raw: SQLite.SQLiteDatabase,
  opts: { appVersion: string; deviceId: string; at?: number },
): Promise<{ bytes: Uint8Array; manifest: BackupManifest; fileName: string }> {
  const at = opts.at ?? Date.now();

  // serializeAsync, NEVER a raw file copy. Under journal_mode = WAL the most
  // recent commits live in clinic.db-wal, not clinic.db, so copying just the
  // .db yields a silently stale - sometimes unopenable - backup. This is the
  // single most common way a homegrown SQLite backup gets quietly broken.
  const dbBytes = await raw.serializeAsync();

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    schemaVersion: await currentVersion(db),
    appVersion: opts.appVersion,
    deviceId: opts.deviceId,
    exportedAt: at,
    counts: await tableCounts(db),
  };

  const csvs = await collectCsvs(db);
  const entries: Record<string, Uint8Array> = {
    [DB_ENTRY]: dbBytes,
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const [name, content] of Object.entries(csvs)) entries[name] = strToU8(content);

  return { bytes: zipSync(entries, { level: 6 }), manifest, fileName: backupFileName(at) };
}

/**
 * Write the bundle to disk and open the share sheet.
 *
 * The copy under Paths.document/backups exists so a backup is on the device
 * even if she cancels the share sheet - but it does NOT survive a lost phone,
 * so it supplements the share-out and never replaces it.
 */
export async function exportBackup(
  db: Db,
  raw: SQLite.SQLiteDatabase,
  opts: { appVersion: string; deviceId: string; at?: number },
): Promise<{ uri: string; fileName: string; shared: boolean; sizeBytes: number }> {
  const { bytes, fileName } = await buildBackupBundle(db, raw, opts);

  const persisted = new File(backupsDirectory(), fileName);
  persisted.create({ overwrite: true, intermediates: true });
  persisted.write(bytes);

  const outbound = new File(Paths.cache, fileName);
  outbound.create({ overwrite: true, intermediates: true });
  outbound.write(bytes);

  let shared = false;
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(outbound.uri, {
      mimeType: 'application/zip',
      dialogTitle: 'Send clinic backup',
      UTI: 'public.zip-archive',
    });
    shared = true;
  }

  return { uri: persisted.uri, fileName, shared, sizeBytes: bytes.byteLength };
}

/**
 * A plain .db snapshot, used before every migration and once a day.
 *
 * This is the highest-value safety feature in the app: it makes every schema
 * change recoverable on the device itself, with no user action, and it costs
 * nothing at this data volume.
 */
export async function snapshotDb(
  raw: SQLite.SQLiteDatabase,
  label: string,
  keep = 7,
): Promise<string> {
  const dir = backupsDirectory();
  const file = new File(dir, `${label}.db`);
  file.create({ overwrite: true, intermediates: true });
  file.write(await raw.serializeAsync());
  pruneSnapshots(label.split('-')[0], keep);
  return file.uri;
}

/** Keep the most recent `keep` snapshots of a given kind; delete older ones. */
export function pruneSnapshots(prefix: string, keep: number): void {
  const dir = backupsDirectory();
  const files = dir
    .list()
    .filter((f): f is File => f instanceof File && f.name.startsWith(prefix) && f.name.endsWith('.db'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files.slice(0, Math.max(0, files.length - keep))) f.delete();
}

export function listLocalBackups(): { name: string; uri: string; size: number | null }[] {
  return backupsDirectory()
    .list()
    .filter((f): f is File => f instanceof File)
    .map((f) => ({ name: f.name, uri: f.uri, size: f.size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}
