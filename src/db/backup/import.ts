import * as SQLite from 'expo-sqlite';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { unzipSync, strFromU8 } from 'fflate';
import { wrapExpoDb } from '../driver.expo';
import { migrate } from '../migrate';
import { snapshotDb } from './export';
import {
  BackupInvalidError, DB_ENTRY, MANIFEST_ENTRY, inspectBackup, parseManifest,
  type BackupManifest, type BackupPreview,
} from './validate';

/**
 * Restore, in the only safe order: READ -> VALIDATE -> PREVIEW -> CONFIRM ->
 * SNAPSHOT THE LIVE DB -> COMMIT.
 *
 * deserializeDatabaseAsync returns an IN-MEMORY database, which is what makes
 * this possible. The candidate backup can be opened, inspected and counted
 * without a single byte touching the live file, so the confirmation screen
 * shows real numbers rather than a generic warning - and a bad file is rejected
 * with a specific reason instead of half-destroying the clinic's data.
 */

export interface PickedBackup {
  uri: string;
  name: string;
  dbBytes: Uint8Array;
  manifest: BackupManifest | null;
}

export async function pickBackup(): Promise<PickedBackup | null> {
  const res = await DocumentPicker.getDocumentAsync({
    // Android's mime detection for .zip from WhatsApp/Drive is unreliable, so
    // we accept broadly and validate the CONTENTS instead of trusting the type.
    type: ['application/zip', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;

  const asset = res.assets[0];
  const bytes = await new File(asset.uri).bytes();

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new BackupInvalidError(
      'That file is not a Clinic Stock backup - it is not a zip file. Pick the ' +
        'clinic-backup-....zip file you saved or sent to yourself.',
    );
  }

  const dbBytes = entries[DB_ENTRY];
  if (!dbBytes) {
    throw new BackupInvalidError(
      `That zip does not contain ${DB_ENTRY}, so it cannot be a Clinic Stock backup.`,
    );
  }

  const manifestRaw = entries[MANIFEST_ENTRY];
  const manifest = manifestRaw ? parseManifest(strFromU8(manifestRaw)) : null;

  return { uri: asset.uri, name: asset.name, dbBytes, manifest };
}

/** Open the candidate in memory and describe it. Nothing is written. */
export async function previewBackup(
  picked: PickedBackup,
): Promise<{ preview: BackupPreview; candidate: SQLite.SQLiteDatabase }> {
  const candidate = await SQLite.deserializeDatabaseAsync(picked.dbBytes);
  try {
    const preview = await inspectBackup(wrapExpoDb(candidate), picked.manifest);
    return { preview, candidate };
  } catch (e) {
    await candidate.closeAsync().catch(() => undefined);
    throw e;
  }
}

/**
 * Commit the restore. Only call this after the doctor has confirmed a preview.
 * The live database is snapshotted first, so even an unwanted restore is
 * reversible.
 */
export async function commitRestore(
  candidate: SQLite.SQLiteDatabase,
  live: SQLite.SQLiteDatabase,
  at: number = Date.now(),
): Promise<void> {
  await snapshotDb(live, `prerestore-${at}`, 5);

  await SQLite.backupDatabaseAsync({
    sourceDatabase: candidate,
    sourceDatabaseName: 'main',
    destDatabase: live,
    destDatabaseName: 'main',
  });
  await candidate.closeAsync().catch(() => undefined);

  // The restored file may predate the current schema, so bring it forward.
  await migrate(wrapExpoDb(live));
}
