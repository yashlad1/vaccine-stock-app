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
  const raw = await SQLite.openDatabaseAsync(name);
  return { db: wrapExpoDb(raw), raw };
}
