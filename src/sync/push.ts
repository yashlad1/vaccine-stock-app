import type { Db } from '../db/driver';
import { PUSH_ORDER, SYNC_TABLES, type SyncTable } from '../db/migrations/m002_sync';
import { MOVEMENT_ANNOTATIONS, type Row, type SyncBackend } from './backend';
import { newId } from '../domain/ids';
import { getSetting, setSetting } from '../db/repo/settings';

/**
 * Push-only replication.
 *
 * The phone stays the source of truth; the server is a live off-phone copy. So
 * this never reads from the server during normal operation and never merges -
 * which removes conflict resolution from the design entirely, and with it the
 * class of bug that would be hardest to notice and worst to have.
 *
 * Two ordering rules that are correctness, not tidiness:
 *
 *  1. Tables push in FK order (vaccines and patients before the movements that
 *     reference them), so the server never holds a movement whose vaccine has
 *     not arrived yet. A half-pushed phone is still a readable clinic record.
 *  2. `dirty` is cleared only AFTER the server acknowledges. A push that
 *     succeeds and then loses the response is retried and lands on the row id
 *     again, which is a no-op. The failure mode is therefore "uploaded twice",
 *     never "believed uploaded but wasn't".
 *
 * Movements upload with ignore-duplicates, so an edit made after the first
 * upload (a child's name filled in at day end) cannot ride on the insert. A
 * movement the server has acknowledged (`last_synced_at` set) that is dirty
 * again is "on the server, name waiting": it goes up through
 * `backend.annotate`, and it is NOT pending - the dose itself is safe there.
 * A server without supabase/movement-annotations.sql takes no annotations;
 * then those rows simply wait, uncounted, and every dose still uploads.
 */

export { PUSH_ORDER };

if (PUSH_ORDER.length !== SYNC_TABLES.length) {
  throw new Error('PUSH_ORDER must cover every table in SYNC_TABLES');
}

export const BATCH = 200;

export interface PushOutcome {
  pushedRows: number;
  ok: boolean;
  error?: string;
}

/** Rows not on the server yet. A movement waiting only for its name is on it. */
const unsent = (table: SyncTable) =>
  table === 'stock_movements' ? 'dirty = 1 AND last_synced_at IS NULL' : 'dirty = 1';

export async function countDirty(db: Db): Promise<number> {
  let n = 0;
  for (const table of PUSH_ORDER) {
    const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${unsent(table)}`);
    n += row?.n ?? 0;
  }
  return n;
}

async function dirtyRows(db: Db, table: SyncTable, limit: number): Promise<Row[]> {
  return db.all<Row>(
    `SELECT * FROM ${table} WHERE ${unsent(table)} ORDER BY updated_at ASC LIMIT ?`,
    [limit],
  );
}

/**
 * The columns `dirty` and `last_synced_at` are this phone's bookkeeping, not
 * clinic data, so they are stripped before upload. Sending them would let one
 * phone's sync state overwrite another's.
 */
function forUpload(row: Row): Row {
  const { dirty: _d, last_synced_at: _l, ...rest } = row;
  return rest;
}

/**
 * Clears `dirty` only on the VERSION that was uploaded. An edit made while the
 * request was in flight has bumped `updated_at`, so its row stays dirty and
 * goes on the next pass - clearing by id alone marked that edit as sent when
 * the server never saw it (a date of birth entered four seconds after the
 * child was added, exactly when the debounced push fires).
 */
async function markSynced(db: Db, table: SyncTable, rows: Row[], at: number, dirty = '0'): Promise<void> {
  if (!rows.length) return;
  // Deliberately does NOT touch updated_at: the re-dirty trigger fires on
  // updated_at changing, so bumping it here would re-queue what we just sent.
  await db.tx(async (tx) => {
    for (const r of rows) {
      await tx.run(
        `UPDATE ${table} SET dirty = ${dirty}, last_synced_at = ? WHERE id = ? AND updated_at IS ?`,
        [at, r.id, r.updated_at],
      );
    }
  });
}

/**
 * Annotations for movements the server already holds. Stops at the first row
 * the server does not take: asking again in this pass would only be refused
 * again, and the rows wait for the next one.
 */
async function pushAnnotations(db: Db, backend: SyncBackend): Promise<number> {
  let sent = 0;
  for (;;) {
    const rows = await db.all<Row>(
      `SELECT id, ${MOVEMENT_ANNOTATIONS.join(', ')} FROM stock_movements
        WHERE dirty = 1 AND last_synced_at IS NOT NULL ORDER BY updated_at ASC LIMIT ?`,
      [BATCH],
    );
    if (!rows.length) return sent;
    const taken = await backend.annotate(rows);
    await markSynced(db, 'stock_movements', rows.filter((r) => taken.has(String(r.id))), Date.now());
    sent += taken.size;
    if (taken.size < rows.length || rows.length < BATCH) return sent;
  }
}

/**
 * Once: before annotations were sent, a name filled in after upload was
 * marked sent although the server ignored it. Queue those names again.
 */
const REQUEUED = 'annotations_requeued';
async function requeueLostNames(db: Db): Promise<void> {
  if (await getSetting(db, REQUEUED)) return;
  await db.run(
    `UPDATE stock_movements SET dirty = 1
      WHERE dirty = 0 AND updated_at <> created_at AND last_synced_at IS NOT NULL`,
  );
  await setSetting(db, REQUEUED, '1');
}

/** One full attempt. Safe to call repeatedly; safe to interrupt. */
export async function pushOnce(
  db: Db,
  backend: SyncBackend,
  deviceId: string,
  now: number = Date.now(),
): Promise<PushOutcome> {
  const logId = newId(now);
  await db.run(
    `INSERT INTO sync_log (id, started_at, device_id) VALUES (?,?,?)`,
    [logId, now, deviceId],
  );

  let pushed = 0;
  try {
    await requeueLostNames(db);
    for (const table of PUSH_ORDER) {
      // Loop rather than one query: a phone that has been offline for a week
      // may have thousands of rows, and one giant request is the request most
      // likely to time out on clinic mobile data.
      for (;;) {
        const rows = await dirtyRows(db, table, BATCH);
        if (!rows.length) break;
        await backend.push({ table, rows: rows.map(forUpload) });
        // An edited movement stays queued for pushAnnotations: if the server
        // already had it, the insert was ignored and carried none of the edit.
        const stay = table === 'stock_movements' ? '(updated_at <> created_at)' : '0';
        await markSynced(db, table, rows, Date.now(), stay);
        pushed += rows.length;
        if (rows.length < BATCH) break;
      }
    }
    pushed += await pushAnnotations(db, backend);
    await db.run(
      `UPDATE sync_log SET finished_at = ?, pushed_rows = ?, ok = 1 WHERE id = ?`,
      [Date.now(), pushed, logId],
    );
    return { pushedRows: pushed, ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Whatever was acknowledged before the failure stays marked synced; the
    // rest is still dirty and goes out next time. Partial progress is kept.
    await db.run(
      `UPDATE sync_log SET finished_at = ?, pushed_rows = ?, ok = 0, error = ? WHERE id = ?`,
      [Date.now(), pushed, error, logId],
    );
    return { pushedRows: pushed, ok: false, error };
  }
}

export interface SyncStatus {
  pending: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
}

export async function syncStatus(db: Db): Promise<SyncStatus> {
  const pending = await countDirty(db);
  const lastOk = await db.first<{ finished_at: number }>(
    `SELECT finished_at FROM sync_log WHERE ok = 1 ORDER BY started_at DESC LIMIT 1`,
  );
  const last = await db.first<{ started_at: number; error: string | null; ok: number }>(
    `SELECT started_at, error, ok FROM sync_log ORDER BY started_at DESC LIMIT 1`,
  );
  return {
    pending,
    lastOkAt: lastOk?.finished_at ?? null,
    lastError: last && last.ok === 0 ? last.error : null,
    lastAttemptAt: last?.started_at ?? null,
  };
}
