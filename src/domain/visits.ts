import type { Db } from '../db/driver';
import { bumpDosesSinceBackup } from '../db/repo/settings';
import { newId } from './ids';
import { recordAdministration, type WriteContext, type WriteResult } from './ledger';
import type { UnitMode } from './types';

export interface CoGiven {
  vaccine_id: string;
  name: string;
  on_hand_doses: number;
  unit_mode: UnitMode;
  doses_per_vial: number;
  min_balance_doses: number;
  /** How many doses of the main vaccine had this one beside them. */
  times: number;
}

/**
 * What this clinic usually gives the same child at the same visit, for the
 * dose screen's `Also giving now` chips. 61 of 156 visits gave one child 2 or
 * 3 vaccines, and each used to need its own tile, child and Give.
 *
 * The same child is the same `patient_id`, or the exact typed label when
 * either dose is not linked to a saved child (almost every name is typed). An
 * unnamed dose matches nothing. Activity, so the effective view: an undone
 * dose was not given.
 */
export function coGiven(db: Db, vaccineId: string, sinceLocalDate: string, limit = 4): Promise<CoGiven[]> {
  return db.all<CoGiven>(
    `SELECT s.vaccine_id, s.name, s.on_hand_doses, s.unit_mode, s.doses_per_vial, s.min_balance_doses,
            COUNT(DISTINCT m.id) AS times
       FROM v_movement_effective m
       JOIN v_movement_effective o
         ON o.local_date = m.local_date
        AND o.movement_type = 'ADMINISTRATION'
        AND o.vaccine_id <> m.vaccine_id
        AND (o.patient_id = m.patient_id
             OR ((o.patient_id IS NULL OR m.patient_id IS NULL) AND o.patient_label = m.patient_label))
       JOIN v_stock_on_hand s ON s.vaccine_id = o.vaccine_id AND s.is_active = 1
      WHERE m.vaccine_id = ? AND m.movement_type = 'ADMINISTRATION' AND m.local_date >= ?
      GROUP BY s.vaccine_id
      ORDER BY times DESC, s.name COLLATE NOCASE
      LIMIT ?`,
    [vaccineId, sinceLocalDate, limit],
  );
}

/** One tap on Give: the main vaccine, plus one dose of each vaccine under "Also giving now". */
export interface Visit {
  vaccineId: string;
  doses: number;
  lotId: string | null;
  patientId: string | null;
  patientLabel: string | null;
  note: string | null;
  extras: { vaccineId: string; lotId: string | null }[];
}

export interface VisitIds {
  /** The inputs these ids were minted for. */
  key: string;
  main: string;
  extras: Record<string, string>;
}

/**
 * The clientActionIds for a tap on Give, given the last tap's if it failed.
 *
 * The same inputs keep the same ids, so a write that half-happened replays as
 * a no-op instead of a second dose. Anything changed gets new ids: replaying
 * the old ones would keep the earlier tap's dose in the ledger while the
 * toast named the new child, batch or count.
 */
export function visitIds(last: VisitIds | null, v: Visit, mint: () => string = newId): VisitIds {
  const extras = v.extras.map((x) => `${x.vaccineId}:${x.lotId}`).sort();
  const key = JSON.stringify([v.vaccineId, v.doses, v.lotId, v.patientId, v.patientLabel, v.note, extras]);
  if (last?.key === key) return last;
  return { key, main: mint(), extras: Object.fromEntries(v.extras.map((x) => [x.vaccineId, mint()])) };
}

/**
 * Write one Give. It fails only if the main dose fails.
 *
 * Once that dose is in the ledger, nothing after it may report failure: she
 * would give it again, and that is a second dose. An added vaccine that fails
 * comes back in `failed`, for the toast to name, and the backup count is
 * bookkeeping. Rows come back as the ledger holds them, replays included, so
 * the toast and Undo describe what is there, not what the screen shows.
 */
export async function recordVisit(
  db: Db,
  ctx: WriteContext,
  ids: VisitIds,
  v: Visit,
): Promise<{ main: WriteResult; extras: WriteResult[]; failed: string[] }> {
  const main = await recordAdministration(db, ctx, {
    clientActionId: ids.main,
    vaccineId: v.vaccineId,
    lotId: v.lotId,
    doses: v.doses,
    patientId: v.patientId,
    patientLabel: v.patientLabel,
    note: v.note ?? undefined,
  });
  const extras: WriteResult[] = [];
  const failed: string[] = [];
  for (const x of v.extras) {
    try {
      extras.push(
        await recordAdministration(db, ctx, {
          clientActionId: ids.extras[x.vaccineId],
          vaccineId: x.vaccineId,
          lotId: x.lotId,
          doses: 1,
          patientId: v.patientId,
          patientLabel: v.patientLabel,
        }),
      );
    } catch {
      failed.push(x.vaccineId);
    }
  }
  // Only a real write moves the backup nag; a replayed row is a no-op.
  const created = [main, ...extras].reduce((n, r) => n + (r.created ? -r.movement.delta_doses : 0), 0);
  if (created) await bumpDosesSinceBackup(db, created, ctx.now).catch(() => undefined);
  return { main, extras, failed };
}
