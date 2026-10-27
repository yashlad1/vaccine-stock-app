import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import type { Db, RunResult } from './driver';

/**
 * The device adapter. This is the ONLY file in the app allowed to import
 * expo-sqlite - everything else talks to the Db interface, which is what makes
 * the whole data layer testable in plain Node.
 */

type Exec = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

function wrapExec(h: Exec): Omit<Db, 'tx'> {
  return {
    async exec(sql) {
      await h.execAsync(sql);
    },
    async run(sql, params = []) {
      const r = await h.runAsync(sql, params as SQLite.SQLiteBindValue[]);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId } satisfies RunResult;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return h.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]);
    },
    async first<T>(sql: string, params: unknown[] = []) {
      return h.getFirstAsync<T>(sql, params as SQLite.SQLiteBindValue[]);
    },
  };
}

export function wrapExpoDb(raw: SQLite.SQLiteDatabase): Db {
  const db: Db = {
    ...wrapExec(raw),
    async tx<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      let out!: R;
      // withExclusiveTransactionAsync hands us a `txn` and every query inside
      // MUST use it. Reaching for the outer `raw` here either deadlocks or
      // silently runs outside the transaction - so the handle is threaded
      // through rather than captured.
      const body = async (h: Exec) => {
        const inner: Db = {
          ...wrapExec(h),
          // SQLite has no real nested transactions; reuse the outer one.
          tx: async <R2>(f: (t: Db) => Promise<R2>) => f(inner),
        };
        out = await fn(inner);
      };
      // expo-sqlite throws on exclusive transactions in the browser, which
      // took down the whole web smoke loop (CLAUDE.md section 11, Layer B) at
      // the first migration. A plain transaction on the one shared connection
      // is NOT exclusive - two overlapping top-level tx calls would collide -
      // which is acceptable for a single-user layout loop and never runs on
      // the phone.
      if (Platform.OS === 'web') await raw.withTransactionAsync(() => body(raw));
      else await raw.withExclusiveTransactionAsync((txn) => body(txn as unknown as Exec));
      return out;
    },
  };
  return db;
}

export const DATABASE_NAME = 'clinic.db';

/** The live database. `migrate()` sets the pragmas it needs. */
export async function openDeviceDb(name = DATABASE_NAME): Promise<{ db: Db; raw: SQLite.SQLiteDatabase }> {
  const raw = Platform.OS === 'web' ? await openInBrowser(name) : await SQLite.openDatabaseAsync(name);
  if (__DEV__ && Platform.OS === 'web') await loadMacCopy(raw);
  return { db: wrapExpoDb(raw), raw };
}

/**
 * The browser lets ONE page hold the database file, so a second tab (or a
 * reload that beats the old page's exit) is refused. Retrying in the same page
 * does not help - the VFS is left in an invalid state - so say what to do
 * instead of showing the raw OPFS error.
 */
async function openInBrowser(name: string): Promise<SQLite.SQLiteDatabase> {
  try {
    return await SQLite.openDatabaseAsync(name);
  } catch (e) {
    if (!/createSyncAccessHandle/.test(String(e))) throw e;
    throw new Error('Clinic Stock is open in another tab of this browser. Close the other tab, then reload this one.');
  }
}

/**
 * Browser dev loop only: start from the clinic's real records instead of an
 * empty catalogue, so screens are judged against real volumes and names.
 *
 * The copy is the Mac's nightly server backup, served on 127.0.0.1 by
 * scripts/dev-data-server.ts, so it never leaves this machine. It carries no
 * settings - no server login, no device id - so this browser cannot sync into
 * the clinic's record. Loads into an empty database, or over the current one
 * when the URL has ?macdata. Silent when that server is not running.
 */
const MAC_COPY = 'http://127.0.0.1:8099/clinic.db';

async function loadMacCopy(raw: SQLite.SQLiteDatabase) {
  const force = new URLSearchParams(globalThis.location?.search ?? '').has('macdata');
  const v = await raw.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (v?.user_version && !force) return;
  const res = await fetch(MAC_COPY).catch(() => null);
  if (!res?.ok) return;
  const copy = await SQLite.deserializeDatabaseAsync(new Uint8Array(await res.arrayBuffer()));
  await SQLite.backupDatabaseAsync({
    sourceDatabase: copy,
    sourceDatabaseName: 'main',
    destDatabase: raw,
    destDatabaseName: 'main',
  });
  await copy.closeAsync();
  // A server copy has no settings, so the app would take it for a new phone
  // and seed the starter catalogue over vaccines the clinic has since removed.
  await raw.runAsync(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('catalog_seeded', '1', ?)`,
    [Date.now()],
  );
}
