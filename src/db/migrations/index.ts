import { m001 } from './m001_initial';
import { m002 } from './m002_sync';
import { m003 } from './m003_multidevice';
import { m004 } from './m004_patient_sex';
import { m005 } from './m005_prices';

/**
 * Ordered migration chain. Append new migrations; never edit a shipped one.
 *
 * Rules (see CLAUDE.md section 6):
 *   - Additive only. No DROP TABLE, no DROP COLUMN, no DELETE. To retire a
 *     column, stop reading it.
 *   - Every migration gets a test that builds v(N-1) with seeded rows, runs the
 *     chain, and asserts every pre-existing row survived.
 */
export const MIGRATIONS = [m001, m002, m003, m004, m005];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].to;
