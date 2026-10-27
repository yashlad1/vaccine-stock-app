import type { Db } from '../db/driver';

export interface CoGiven {
  vaccine_id: string;
  name: string;
  on_hand_doses: number;
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
    `SELECT s.vaccine_id, s.name, s.on_hand_doses, COUNT(DISTINCT m.id) AS times
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
