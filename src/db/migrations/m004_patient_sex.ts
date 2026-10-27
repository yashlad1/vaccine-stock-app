import type { Db } from '../driver';

/**
 * Migration 004 - the child's sex, for the Trends screen's boys/girls split.
 *
 * On the child, not the dose, for the same reason the age is: it is entered
 * once and every dose that child ever had reads it. Nullable, because the
 * dose screen never requires it (invariant 5) and every existing child
 * predates it.
 *
 * The server needs the same column BEFORE this ships: push sends every local
 * column, and PostgREST rejects an unknown one with a 400 - which would stop
 * the doses behind patients in PUSH_ORDER from uploading.
 * See supabase/add-trends-columns.sql.
 */
export const m004 = {
  to: 4,
  name: 'patient_sex',
  up: async (tx: Db) => {
    await tx.exec(`ALTER TABLE patients ADD COLUMN sex TEXT CHECK (sex IN ('M','F'))`);
  },
};
