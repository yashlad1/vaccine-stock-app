/**
 * Generates docs/schema.sql from the migration chain, so the reference DDL can
 * never drift from what the app actually creates.
 *
 * Run with: npm run schema:dump
 *
 * Runs the app's own `migrate()`, so every migration is in it: a hand-kept
 * list here once stopped at m001 and left the file four versions behind.
 */
import './resolve.ts';

const { openNodeDb } = await import('../src/db/driver.node.ts');
const { migrate, LATEST_VERSION } = await import('../src/db/migrate.ts');

const db = openNodeDb();
await migrate(db);

const rows = await db.all<{ type: string; name: string; sql: string | null }>(
  `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1
                       WHEN 'view' THEN 2 ELSE 3 END, name`,
);

const out: string[] = [
  `-- Reference DDL for Clinic Stock, schema v${LATEST_VERSION}.`,
  `--`,
  `-- GENERATED from src/db/migrations by scripts/dump-schema.ts.`,
  `-- Do not edit by hand; run \`npm run schema:dump\` instead.`,
  `--`,
  `-- The migrations are the source of truth. This file exists so reviewers and`,
  `-- the ERD have a single flat view of what they produce.`,
  ``,
  `PRAGMA user_version = ${LATEST_VERSION};`,
  ``,
];
for (const r of rows) out.push(`${r.sql};`, ``);
console.log(out.join('\n'));
