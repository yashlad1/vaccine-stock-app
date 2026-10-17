import type { Db } from '../driver';
import { objectsToCsv, type CsvValue } from './csv';
import { formatAge, formatTime12h } from '../../domain/time';
import { REQUIRED_TABLES } from './validate';

/**
 * The CSVs that go in the backup zip.
 *
 * `doses.csv` is the one the doctor will actually open. It is shaped like the
 * notebook page she is replacing - one row per dose, in plain language - not
 * like a database dump. The raw ledger is alongside it for completeness.
 */

export async function dosesCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, CsvValue>>(
    `SELECT m.local_date AS date, m.local_time AS time24, v.name AS vaccine,
            l.lot_number AS batch, m.patient_label AS child,
            p.dob AS dob, -m.delta_doses AS doses
       FROM v_movement_effective m
       JOIN vaccines v ON v.id = m.vaccine_id
       LEFT JOIN lots l ON l.id = m.lot_id
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE m.movement_type = 'ADMINISTRATION'
      ORDER BY m.occurred_at ASC`,
  );
  const shaped = rows.map((r) => ({
    date: r.date,
    time: formatTime12h(String(r.time24)),
    vaccine: r.vaccine,
    batch: r.batch,
    child: r.child,
    // The age AT THIS DOSE, the way the notebook recorded it.
    age: formatAge(r.dob as string | null, String(r.date)),
    doses: r.doses,
  }));
  return objectsToCsv(['date', 'time', 'vaccine', 'batch', 'child', 'age', 'doses'], shaped);
}

export async function movementsCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, CsvValue>>(
    `SELECT m.local_date AS date, m.local_time AS time, m.movement_type AS type,
            v.name AS vaccine, l.lot_number AS batch, m.delta_doses AS change_doses,
            m.wastage_reason AS wastage_reason, m.patient_label AS child,
            m.note AS note,
            CASE WHEN m.reverses_id IS NULL THEN '' ELSE 'reverses an earlier entry' END AS correction
       FROM stock_movements m
       JOIN vaccines v ON v.id = m.vaccine_id
       LEFT JOIN lots l ON l.id = m.lot_id
      ORDER BY m.occurred_at ASC, m.recorded_at ASC`,
  );
  return objectsToCsv(
    ['date', 'time', 'type', 'vaccine', 'batch', 'change_doses', 'wastage_reason', 'child', 'note', 'correction'],
    rows as never,
  );
}

export async function vaccinesCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, CsvValue>>(
    `SELECT name AS trade_name, generic_name, unit_mode AS counted_in,
            doses_per_vial, min_balance_doses AS safety_limit_doses,
            on_hand_doses AS present_stock_doses
       FROM v_stock_on_hand ORDER BY name COLLATE NOCASE`,
  );
  return objectsToCsv(
    ['trade_name', 'generic_name', 'counted_in', 'doses_per_vial', 'safety_limit_doses', 'present_stock_doses'],
    rows as never,
  );
}

export async function patientsCsv(db: Db): Promise<string> {
  const rows = await db.all<Record<string, CsvValue>>(
    `SELECT name, dob, guardian_phone FROM patients WHERE deleted_at IS NULL
      ORDER BY name COLLATE NOCASE`,
  );
  return objectsToCsv(['name', 'dob', 'guardian_phone'], rows as never);
}

export async function tableCounts(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of REQUIRED_TABLES) {
    const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = row?.n ?? 0;
  }
  return counts;
}

export async function collectCsvs(db: Db): Promise<Record<string, string>> {
  return {
    'doses.csv': await dosesCsv(db),
    'stock_movements.csv': await movementsCsv(db),
    'vaccines.csv': await vaccinesCsv(db),
    'patients.csv': await patientsCsv(db),
  };
}
