import type { SyncTable } from '../db/migrations/m002_sync';

/**
 * The seam between "what to sync" and "where it goes".
 *
 * Same trick as `src/db/driver.ts`: one narrow interface, a real adapter and an
 * in-memory adapter, so the whole sync engine is testable in plain Node with no
 * network and no Supabase project. Nothing outside `backend.*.ts` may know that
 * the server is Supabase.
 */

export type Row = Record<string, unknown>;

export interface PushBatch {
  table: SyncTable;
  rows: Row[];
}

export interface SyncBackend {
  /**
   * Upload rows. MUST be idempotent per row id, because a push that succeeds
   * on the server and then loses the response will be retried: the phone only
   * clears `dirty` after it hears back.
   */
  push(batch: PushBatch): Promise<void>;
  /** Everything the server holds, for rebuilding a lost phone. */
  pullAll(table: SyncTable): Promise<Row[]>;
  /**
   * Rows the server has stamped after `since`, ordered by (synced_at, id).
   * With `afterId`, rows after the PAIR (since, afterId) instead, which is how
   * a page resumes part-way through rows that share one synced_at.
   *
   * `since` is the SERVER's clock (`synced_at`), never a device's. A device
   * with a skewed clock writes a skewed `updated_at`, and a watermark built on
   * that silently skips its rows forever - a sync that loses data while
   * reporting success.
   *
   * Many rows share one synced_at: Postgres's now() is fixed for a whole
   * transaction, so every row of one upload (or one server-side UPDATE) gets
   * the same stamp. Paging on synced_at alone skipped the rest of such a group
   * whenever a page ended inside it.
   */
  pullSince(table: SyncTable, since: string | null, limit: number, afterId?: string): Promise<Row[]>;
  /** Cheap reachability + credential check for the Settings screen. */
  ping(): Promise<void>;
}

export class SyncAuthError extends Error {
  readonly kind = 'auth';
  constructor(message: string) {
    super(message);
    this.name = 'SyncAuthError';
  }
}

export class SyncNetworkError extends Error {
  readonly kind = 'network';
  constructor(message: string) {
    super(message);
    this.name = 'SyncNetworkError';
  }
}
