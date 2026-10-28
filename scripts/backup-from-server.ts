import './resolve.ts';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Back up the clinic onto this Mac, from the server, without the doctor's
 * phone doing anything.
 *
 * Writes one dated folder: the readable files to open in Numbers or Excel -
 * doses.csv (date, time, vaccine, batch, child, age, doses) and vaccines.csv
 * (each vaccine with its stock now), plus stock_movements.csv and
 * patients.csv - the bare clinic.db, and the same zip the app's Back up
 * button makes, so the phone's Restore screen accepts it. Then it re-opens the zip and runs the app's own restore
 * check on it, so a backup that would be refused says so here, now.
 *
 * It holds what has reached the server. Entries still waiting on a phone with
 * no signal are not in it; the line it prints names the latest entry, so check
 * that against the phone.
 *
 * The credentials come from EAS's production environment and never touch a
 * file. Run it with node, never as an npm script: `packageJson:scripts` is an
 * OTA fingerprint source (CLAUDE.md section 10a).
 *
 *   npx eas-cli env:exec production \
 *     'NODE_OPTIONS="--disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON" node scripts/backup-from-server.ts'
 *
 * Output goes to backups/ in this project (or the first argument). That folder
 * is gitignored - the repo is public - and owner-only: it holds children's
 * names and dates of birth.
 */

// Reuses the app's tested restore and CSV code through scripts/resolve.ts.
const { openNodeDb } = await import('../src/db/driver.node.ts');
const { migrate, currentVersion } = await import('../src/db/migrate.ts');
const { supabaseBackend } = await import('../src/sync/backend.supabase.ts');
const { restoreFromServer } = await import('../src/sync/restore.ts');
const { collectCsvs } = await import('../src/db/backup/collect.ts');
const { BACKUP_FORMAT, DB_ENTRY, MANIFEST_ENTRY, inspectBackup, parseManifest, tableCounts } = await import(
  '../src/db/backup/validate.ts'
);
const { strFromU8, strToU8, unzipSync, zipSync } = await import('fflate');

const env = process.env;
const cfg = {
  url: env.EXPO_PUBLIC_SYNC_URL ?? '',
  publishableKey: env.EXPO_PUBLIC_SYNC_KEY ?? '',
  email: env.EXPO_PUBLIC_SYNC_EMAIL ?? '',
  password: env.EXPO_PUBLIC_SYNC_PASSWORD ?? '',
};
if (!cfg.url || !cfg.publishableKey || !cfg.email || !cfg.password) {
  console.error('No server credentials. Run this through `npx eas-cli env:exec production` (see the top of the file).');
  process.exit(1);
}

const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../backups', import.meta.url)));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const d = new Date();
const p2 = (n: number) => String(n).padStart(2, '0');
const base = `clinic-server-copy-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const out = join(dir, base);
mkdirSync(out, { recursive: true, mode: 0o700 });
const dbPath = join(out, 'clinic.db');
const zipPath = join(out, `${base}.zip`);

const db = openNodeDb(dbPath);
await migrate(db);
const report = await restoreFromServer(db, supabaseBackend(cfg));
const counts = await tableCounts(db);
const csvs = await collectCsvs(db);
const schemaVersion = await currentVersion(db);
// Folds the WAL back into the file, so the file's bytes are the whole database.
await db.exec('PRAGMA journal_mode = DELETE');

const appVersion = String(JSON.parse(readFileSync('app.json', 'utf8')).expo.version);
const manifest = {
  format: BACKUP_FORMAT,
  formatVersion: 1,
  schemaVersion,
  appVersion,
  deviceId: 'server-copy-on-mac',
  exportedAt: Date.now(),
  counts,
};
const entries: Record<string, Uint8Array> = {
  [DB_ENTRY]: readFileSync(dbPath),
  [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
};
for (const [name, content] of Object.entries(csvs)) entries[name] = strToU8(content);
writeFileSync(zipPath, zipSync(entries, { level: 6 }), { mode: 0o600 });
for (const [name, content] of Object.entries(csvs)) writeFileSync(join(out, name), content, { mode: 0o600 });
chmodSync(dbPath, 0o600);

// The check the phone makes before it restores, run on the file just written.
// The copy holds children's names, so it goes in an owner-only folder (0700)
// as an owner-only file, and is removed even when the check throws.
const back = unzipSync(readFileSync(zipPath));
const scratchDir = mkdtempSync(join(tmpdir(), 'clinic-check-'));
let preview;
try {
  const scratch = join(scratchDir, 'clinic.db');
  writeFileSync(scratch, back[DB_ENTRY], { mode: 0o600 });
  preview = await inspectBackup(openNodeDb(scratch), parseManifest(strFromU8(back[MANIFEST_ENTRY])));
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

const latest = await db.first<{ d: string; t: string }>(
  `SELECT local_date AS d, local_time AS t FROM stock_movements ORDER BY occurred_at DESC LIMIT 1`,
);
console.log(`Copied ${report.total} rows from the server:`);
for (const [table, n] of Object.entries(report.perTable)) console.log(`  ${table.padEnd(16)} ${n}`);
console.log(`Latest entry on the server: ${latest ? `${latest.d} ${latest.t}` : 'none'}`);
console.log(`The app's restore check accepts it: ${JSON.stringify(preview)}`);
console.log(`\n${out}/  ${Object.keys(csvs).join('  ')}  clinic.db  ${base}.zip`);
