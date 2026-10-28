import type { Db } from '../db/driver';
import { PUSH_ORDER, type SyncTable } from '../db/migrations/m002_sync';
import { MOVEMENT_ANNOTATIONS, type Row, type SyncBackend } from './backend';

/**
 * Pull - the half that makes a second writing device possible.
 *
 * The merge rules are short because the schema did the hard work. Movements are
 * append-only with client-generated UUIDs, so there is no "which edit wins"
 * question for the ledger; and on-hand is recomputed from movements rather than
 * transferred, so once two devices hold the same movements they agree on every
 * number by construction.
 *
 * What is left is the four places two devices can create the same THING twice.
 * See docs/MULTI-DEVICE-PLAN.md.
 */

const PAGE = 500;

export interface PullOutcome {
  appliedRows: number;
  conflicts: PullConflict[];
  ok: boolean;
  error?: string;
}

export interface PullConflict {
  table: SyncTable;
  id: string;
  reason: 'duplicate-vaccine-name' | 'already-reversed' | 'rejected';
  detail: string;
}

/** Bookkeeping columns are per-device and must never travel. */
function localise(row: Row, allowed: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (allowed.has(k)) out[k] = v;
  // It came FROM the server, so it is already replicated.
  out.dirty = 0;
  return out;
}

async function columnsOf(db: Db, table: SyncTable): Promise<Set<string>> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(cols.map((c) => c.name));
}

async function cursorFor(db: Db, table: SyncTable): Promise<string | null> {
  const row = await db.first<{ server_synced_at: string | null }>(
    `SELECT server_synced_at FROM sync_cursor WHERE table_name = ?`,
    [table],
  );
  return row?.server_synced_at ?? null;
}

async function setCursor(db: Db, table: SyncTable, at: string, now: number): Promise<void> {
  await db.run(
    `INSERT INTO sync_cursor (table_name, server_synced_at, updated_at) VALUES (?,?,?)
     ON CONFLICT(table_name) DO UPDATE SET server_synced_at = excluded.server_synced_at,
                                           updated_at = excluded.updated_at`,
    [table, at, now],
  );
}

/**
 * Apply one incoming row. Returns whether it changed anything, and any
 * conflict worth telling a human about.
 */
async function applyRow(
  db: Db,
  table: SyncTable,
  incoming: Row,
  allowed: Set<string>,
  now: number,
): Promise<{ changed: boolean; conflict?: PullConflict }> {
  const id = String(incoming.id);
  const row = localise(incoming, allowed);

  if (table === 'stock_movements') {
    // Append-only: the first writer wins and the arithmetic is never
    // overwritten. A second REVERSAL of the same movement is REJECTED by
    // UNIQUE(reverses_id), and that rejection is correct - it is exactly what
    // stops stock being credited twice when two offline devices both
    // corrected one dose.
    const existing = await db.first<{ updated_at: number }>(
      `SELECT updated_at FROM stock_movements WHERE id = ?`,
      [id],
    );
    if (existing) {
      // The one later edit a movement has: its annotations, such as a child's
      // name filled in on the other device. Newer edit wins, as for the
      // mutable tables below, and only those columns are written.
      if (Number(row.updated_at ?? 0) <= Number(existing.updated_at)) return { changed: false };
      const keys = MOVEMENT_ANNOTATIONS.filter((k) => k in row);
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      try {
        await db.run(`UPDATE stock_movements SET ${sets} WHERE id = ?`, [...keys.map((k) => row[k]), id]);
      } catch (e) {
        const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        return { changed: false, conflict: { table, id, reason: 'rejected', detail } };
      }
      // It came from the server, so it must not be pushed straight back.
      await db.run(`UPDATE stock_movements SET dirty = 0 WHERE id = ?`, [id]);
      return { changed: true };
    }

    if (row.reverses_id) {
      const already = await db.first<{ id: string }>(
        `SELECT id FROM stock_movements WHERE reverses_id = ?`,
        [row.reverses_id],
      );
      if (already) {
        return {
          changed: false,
          conflict: {
            table,
            id,
            reason: 'already-reversed',
            detail: `entry ${String(row.reverses_id).slice(0, 8)} was corrected on both devices; kept the first`,
          },
        };
      }
    }

    const keys = Object.keys(row);
    const res = await db.run(
      `INSERT OR IGNORE INTO stock_movements (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => row[k]),
    );
    return { changed: res.changes > 0 };
  }

  // ------------------------------------------------------------------
  // Mutable tables: last write wins on the CLIENT's updated_at.
  //
  // Deliberately the client clock here, not the server's: `updated_at` records
  // when a human made the edit, and the later edit is the one that should
  // survive. `synced_at` only records when it happened to reach the server,
  // which says nothing about intent.
  // ------------------------------------------------------------------
  const local = await db.first<{ updated_at: number }>(
    `SELECT updated_at FROM ${table} WHERE id = ?`,
    [id],
  );

  if (local) {
    if (Number(row.updated_at ?? 0) <= Number(local.updated_at)) return { changed: false };
    const sets = Object.keys(row)
      .filter((k) => k !== 'id')
      .map((k) => `${k} = ?`)
      .join(', ');
    const vals = Object.keys(row)
      .filter((k) => k !== 'id')
      .map((k) => row[k]);
    await db.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...vals, id]);
    // The re-dirty trigger fires when updated_at changes, so clear it again -
    // this value came from the server and must not be pushed straight back.
    await db.run(`UPDATE ${table} SET dirty = 0 WHERE id = ?`, [id]);
    return { changed: true };
  }

  // New row. The one collision that matters is a vaccine name, because
  // `ux_vaccines_name` is what makes "one row per vaccine" true - and that is
  // the whole reason this app exists. Import the loser under a marked name
  // rather than dropping it: nothing is lost, the ledger stays valid, and a
  // human can see there is something to merge.
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  try {
    await db.run(sql, keys.map((k) => row[k]));
    return { changed: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (table === 'vaccines' && msg.includes('UNIQUE') && msg.includes('name')) {
      const renamed: Row = { ...row, name: `${String(row.name)} (duplicate)`, updated_at: now };
      const k2 = Object.keys(renamed);
      await db.run(
        `INSERT OR IGNORE INTO vaccines (${k2.join(',')}) VALUES (${k2.map(() => '?').join(',')})`,
        k2.map((k) => renamed[k]),
      );
      return {
        changed: true,
        conflict: {
          table,
          id,
          reason: 'duplicate-vaccine-name',
          detail: `"${String(row.name)}" exists on both devices; imported as "${String(row.name)} (duplicate)" — merge them on the Vaccines tab`,
        },
      };
    }
    return { changed: false, conflict: { table, id, reason: 'rejected', detail: msg.slice(0, 200) } };
  }
}

/**
 * One full pull. Safe to interrupt: the cursor advances only after a page has
 * been committed, so an interrupted run resumes rather than skips.
 *
 * Pages resume after the last row by (synced_at, id), not by synced_at alone:
 * the server stamps a whole upload with one synced_at, so a page that ended
 * part-way through one skipped the rest of it, for good. The saved cursor
 * keeps its old meaning - "every row up to this synced_at is applied" - so it
 * only moves to a synced_at whose rows are all in.
 */
export async function pullOnce(
  db: Db,
  backend: SyncBackend,
  now: number = Date.now(),
): Promise<PullOutcome> {
  let applied = 0;
  const conflicts: PullConflict[] = [];

  try {
    // Parents before children, same order as push: a movement whose vaccine
    // has not arrived yet would fail the foreign key.
    for (const table of PUSH_ORDER) {
      const allowed = await columnsOf(db, table);
      let saved = await cursorFor(db, table);
      // The last row applied in this pass.
      let after: { syncedAt: string; id: string } | null = null;
      for (;;) {
        const rows = await backend.pullSince(table, after?.syncedAt ?? saved, PAGE, after?.id);

        if (rows.length) {
          // A REVERSAL can share its synced_at with the movement it reverses
          // (one upload), and its foreign key needs that movement in first.
          // sort() is stable, so the rest keep the server's order.
          const isReversal = (r: Row) => Number(r.movement_type === 'REVERSAL');
          const ordered = [...rows].sort((a, b) => isReversal(a) - isReversal(b));
          await db.tx(async (tx) => {
            for (const r of ordered) {
              const res = await applyRow(tx, table, r, allowed, now);
              if (res.changed) applied += 1;
              if (res.conflict) conflicts.push(res.conflict);
            }
          });
          const last = rows[rows.length - 1];
          const next = { syncedAt: String(last.synced_at), id: String(last.id) };
          // Defensive: a backend that ignored the filter would hand back the
          // same page forever.
          if (after && next.syncedAt === after.syncedAt && next.id === after.id) break;
          after = next;
        }

        // A short page means the server had nothing more to give, so the
        // last synced_at is complete. A full page may have stopped inside the
        // last one, so only the synced_ats before it are.
        const done = rows.length < PAGE;
        let mark = done ? after?.syncedAt : undefined;
        if (!done) for (const r of rows) if (String(r.synced_at) !== after!.syncedAt) mark = String(r.synced_at);
        if (mark && mark !== saved) {
          await setCursor(db, table, mark, now);
          saved = mark;
        }
        if (done) break;
      }
    }
    return { appliedRows: applied, conflicts, ok: true };
  } catch (e) {
    return {
      appliedRows: applied,
      conflicts,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
