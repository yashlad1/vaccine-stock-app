import type { Db } from '../driver';
import { newId } from '../../domain/ids';

/**
 * The patient registry is deliberately minimal and structurally separable from
 * the ledger: inventory records must stay valid with patient rows redacted.
 *
 * Capture is designed around not typing. In order of how often each is used:
 *   1. `recentPatients()` - one tap. Hits constantly: second and third doses in
 *      a series, and siblings vaccinated together.
 *   2. `searchPatients()` - name prefix OR last 4 digits of the guardian's
 *      phone. Parents reliably remember phone numbers; names get spelled a
 *      dozen ways.
 *   3. `createPatient()` - inline quick-add, name only, from the dose screen.
 *   4. Skip entirely - always allowed.
 */

export interface Patient {
  id: string;
  name: string;
  dob: string | null;
  guardian_phone: string | null;
  sex: Sex | null;
}

/** As the clinic records it. Optional everywhere; null is "not recorded". */
export type Sex = 'M' | 'F';

export async function createPatient(
  db: Db,
  input: { name: string; dob?: string | null; guardianPhone?: string | null; sex?: Sex | null },
  deviceId: string,
  now: number = Date.now(),
): Promise<string> {
  const id = newId(now);
  await db.run(
    `INSERT INTO patients (id, name, dob, guardian_phone, sex, created_at, updated_at, device_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, input.name.trim(), input.dob ?? null, input.guardianPhone ?? null, input.sex ?? null, now, now, deviceId],
  );
  return id;
}

export function searchPatients(db: Db, q: string, limit = 20): Promise<Patient[]> {
  const name = `${q.toLowerCase()}%`;
  const phone = `%${q}`;
  return db.all<Patient>(
    `SELECT id, name, dob, guardian_phone, sex FROM patients
      WHERE deleted_at IS NULL
        AND (LOWER(name) LIKE ? OR guardian_phone LIKE ?)
      ORDER BY name COLLATE NOCASE LIMIT ?`,
    [name, phone, limit],
  );
}

/** Last N distinct children by most recent dose - the one-tap path. */
export function recentPatients(db: Db, limit = 15): Promise<Patient[]> {
  return db.all<Patient>(
    `SELECT p.id, p.name, p.dob, p.guardian_phone, p.sex, MAX(m.occurred_at) AS last_at
       FROM patients p
       JOIN stock_movements m ON m.patient_id = p.id
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY last_at DESC LIMIT ?`,
    [limit],
  );
}

/**
 * The age on every dose is worked out from this, so it is entered once per
 * child rather than once per visit. Bumping `updated_at` is what queues the
 * change for the server (the m002 dirty trigger).
 */
export async function setPatientDob(db: Db, id: string, dob: string, now: number = Date.now()) {
  await db.run(`UPDATE patients SET dob = ?, updated_at = ? WHERE id = ?`, [dob, now, id]);
}

/** Same as the date of birth: once per child, and the edit queues for the server. */
export async function setPatientSex(db: Db, id: string, sex: Sex, now: number = Date.now()) {
  await db.run(`UPDATE patients SET sex = ?, updated_at = ? WHERE id = ?`, [sex, now, id]);
}

export function getPatient(db: Db, id: string): Promise<Patient | null> {
  return db.first<Patient>(`SELECT id, name, dob, guardian_phone, sex FROM patients WHERE id = ?`, [id]);
}

/** A child's vaccination history. Uses the effective view - undone doses are not history. */
export function patientHistory(db: Db, patientId: string) {
  return db.all<{ local_date: string; local_time: string; vaccine_name: string; doses: number }>(
    `SELECT m.local_date, m.local_time, v.name AS vaccine_name, -m.delta_doses AS doses
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
      WHERE m.patient_id = ? AND m.movement_type = 'ADMINISTRATION'
      ORDER BY m.occurred_at DESC`,
    [patientId],
  );
}
