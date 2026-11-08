/**
 * Build a device clinic.db from the LOCAL Postgres test server.
 *
 * This is the production topology in miniature: Postgres is the server (what
 * Supabase runs), SQLite is the device. The SQLite schema comes from the app's
 * own migration chain, never hand-written, so the copy cannot drift from what
 * the app expects.
 *
 * Test rig only. It talks to a local database and never to production.
 *   node scripts/pg-to-device.ts <outDir> [dbname]
 */
import './resolve.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'backups/synthetic');
const DB = process.argv[3] ?? 'vialbook_test';
const PSQL = '/Applications/Postgres.app/Contents/Versions/latest/bin/psql';

const rows = (table: string): Record<string, unknown>[] => {
  const out = execFileSync(PSQL, ['-At', '-d', DB, '-c',
    `select coalesce(json_agg(t),'[]') from (select * from public.${table}) t`], { encoding: 'utf8' });
  return JSON.parse(out.trim());
};

// resolve.ts only helps DYNAMIC imports: static ones are all resolved before
// any module body runs, so the hook would not be registered yet.
const { openNodeDb } = await import('../src/db/driver.node.ts');
const { migrate } = await import('../src/db/migrate.ts');

mkdirSync(OUT, { recursive: true });
const file = join(OUT, 'clinic.db');
rmSync(file, { force: true });

const db = openNodeDb(file);

await migrate(db);

// Strip the server's own bookkeeping; `dirty = 0` because these rows came FROM
// the server, so the device has nothing to upload.
const DROP = new Set(['owner', 'synced_at']);
for (const table of ['vaccines', 'patients', 'lots', 'stock_movements']) {
  const data = rows(table);
  if (!data.length) continue;
  const cols = Object.keys(data[0]).filter((c) => !DROP.has(c));
  const sql = `INSERT INTO ${table} (${cols.join(',')},dirty,last_synced_at) VALUES (${cols.map(() => '?').join(',')},0,?)`;
  await db.tx(async (tx) => {
    for (const r of data) await tx.run(sql, [...cols.map((c) => r[c] ?? null), Date.now()]);
  });
  console.log(`${table}: ${data.length}`);
}

// Without `catalog_seeded` the app re-seeds its starter catalogue over these
// vaccines on first open. `device_id` identifies this copy; no credentials are
// written, so it cannot sync anywhere.
for (const [k, v] of [['catalog_seeded', '1'], ['device_id', 'tablet-7f3a9c21'],
                      ['onboarding_done', '1'], ['is_primary_device', '1'],
                      ['clinic_name', 'Demo Child Clinic']] as const) {
  await db.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [k, v, Date.now()]);
}
// migrate() turns on WAL, and `deserializeDatabaseAsync` - which is how the
// browser loads this file - cannot open a WAL-mode database in memory
// (SQLITE_CANTOPEN, error 14). The app's own backups avoid this by going
// through serializeAsync(). Going back to the rollback journal checkpoints
// everything into clinic.db and drops the sidecars, so the bytes stand alone.
await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
await db.exec('PRAGMA journal_mode = DELETE');

console.log('wrote', file);
