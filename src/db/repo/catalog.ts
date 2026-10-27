import type { Db } from '../driver';
import { newId } from '../../domain/ids';
import type { SeedVaccine } from '../../domain/seed';
import { SEED_VACCINES } from '../../domain/seed';
import type { Vaccine } from '../../domain/types';

/**
 * Catalog writes. Reachable from the Catalog admin screen ONLY.
 *
 * If a data-entry screen can create a catalog row, we have re-invented free
 * text with extra steps - and failure mode 1 (misspelling) comes straight back.
 */

export async function insertVaccine(
  db: Db,
  v: SeedVaccine,
  deviceId: string,
  now: number = Date.now(),
): Promise<string> {
  const id = newId(now);
  await db.run(
    `INSERT INTO vaccines
       (id, name, generic_name, aliases, unit_mode, doses_per_vial,
        min_balance_doses, created_at, updated_at, device_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      v.name,
      v.generic_name ?? null,
      JSON.stringify(v.aliases ?? []),
      v.unit_mode,
      v.doses_per_vial,
      v.min_balance_doses,
      now,
      now,
      deviceId,
    ],
  );
  return id;
}

/** Idempotent: safe to run on every launch. */
export async function seedCatalog(
  db: Db,
  deviceId: string,
  now: number = Date.now(),
  vaccines: SeedVaccine[] = SEED_VACCINES,
): Promise<number> {
  let inserted = 0;
  await db.tx(async (tx) => {
    for (const v of vaccines) {
      const existing = await tx.first<{ id: string }>(
        `SELECT id FROM vaccines WHERE name = ? AND deleted_at IS NULL`,
        [v.name],
      );
      if (existing) continue;
      await insertVaccine(tx, v, deviceId, now);
      inserted++;
    }
  });
  return inserted;
}

export function listVaccines(db: Db, activeOnly = true): Promise<Vaccine[]> {
  return db.all<Vaccine>(
    `SELECT * FROM vaccines
      WHERE deleted_at IS NULL ${activeOnly ? 'AND is_active = 1' : ''}
      ORDER BY name COLLATE NOCASE`,
  );
}

/**
 * Alias-aware search, so the picker is generous while identity stays single.
 */
export function searchVaccines(db: Db, q: string): Promise<Vaccine[]> {
  const needle = `%${q.toLowerCase()}%`;
  return db.all<Vaccine>(
    `SELECT * FROM vaccines
      WHERE deleted_at IS NULL AND is_active = 1
        AND (LOWER(name) LIKE ? OR LOWER(COALESCE(generic_name,'')) LIKE ? OR LOWER(aliases) LIKE ?)
      ORDER BY name COLLATE NOCASE`,
    [needle, needle, needle],
  );
}

export async function setMinBalance(
  db: Db,
  vaccineId: string,
  minBalanceDoses: number,
  now: number = Date.now(),
): Promise<void> {
  await db.run(`UPDATE vaccines SET min_balance_doses = ?, updated_at = ? WHERE id = ?`, [
    minBalanceDoses,
    now,
    vaccineId,
  ]);
}

/** Hide from the pickers but keep it in the catalog. Reversible in one tap. */
/** Selling price per dose in whole rupees, or null to clear it. New doses stamp it; past ones keep theirs. */
export async function setVaccinePrice(db: Db, vaccineId: string, rupees: number | null, now: number = Date.now()) {
  await db.run(`UPDATE vaccines SET price_rupees = ?, updated_at = ? WHERE id = ?`, [rupees, now, vaccineId]);
}

export async function deactivateVaccine(db: Db, vaccineId: string, now: number = Date.now()) {
  await db.run(`UPDATE vaccines SET is_active = 0, updated_at = ? WHERE id = ?`, [now, vaccineId]);
}

export async function activateVaccine(db: Db, vaccineId: string, now: number = Date.now()) {
  await db.run(`UPDATE vaccines SET is_active = 1, updated_at = ? WHERE id = ?`, [now, vaccineId]);
}

export interface VaccineUsage {
  movements: number;
  dosesGiven: number;
  onHandDoses: number;
}

/**
 * What removing this vaccine would cost. Drives the confirmation copy, so the
 * clinician is told the consequence in real numbers instead of a generic
 * "are you sure?".
 */
export async function vaccineUsage(db: Db, vaccineId: string): Promise<VaccineUsage> {
  const row = await db.first<{ movements: number; given: number | null }>(
    `SELECT COUNT(*) AS movements,
            SUM(CASE WHEN movement_type = 'ADMINISTRATION' THEN -delta_doses ELSE 0 END) AS given
       FROM v_movement_effective WHERE vaccine_id = ?`,
    [vaccineId],
  );
  const stock = await db.first<{ n: number }>(
    `SELECT on_hand_doses AS n FROM v_stock_on_hand WHERE vaccine_id = ?`,
    [vaccineId],
  );
  return {
    movements: row?.movements ?? 0,
    dosesGiven: row?.given ?? 0,
    onHandDoses: stock?.n ?? 0,
  };
}

/**
 * Remove a vaccine from the catalog.
 *
 * This is a SOFT delete - `deleted_at` is stamped and the row stays. A hard
 * DELETE is not available and should not be added: every past dose references
 * this row, so removing it would orphan the ledger and break the history
 * screen, the CSV export and every report that names the vaccine.
 *
 * What the clinician sees is a removal: it disappears from the Give Dose grid,
 * from the stock list and from every picker. What the ledger keeps is an intact
 * record of everything that was ever given.
 *
 * Because `ux_vaccines_name` is partial on `deleted_at IS NULL`, the name is
 * freed for reuse - so a mistake can be undone by simply adding it again.
 */
export async function removeVaccine(db: Db, vaccineId: string, now: number = Date.now()) {
  await db.run(
    `UPDATE vaccines SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?`,
    [now, now, vaccineId],
  );
}

/** Undo a removal. */
export async function restoreVaccine(db: Db, vaccineId: string, now: number = Date.now()) {
  await db.run(
    `UPDATE vaccines SET deleted_at = NULL, is_active = 1, updated_at = ? WHERE id = ?`,
    [now, vaccineId],
  );
}

export function listRemovedVaccines(db: Db): Promise<Vaccine[]> {
  return db.all<Vaccine>(
    `SELECT * FROM vaccines WHERE deleted_at IS NOT NULL ORDER BY name COLLATE NOCASE`,
  );
}
