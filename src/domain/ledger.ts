import type { Db } from '../db/driver';
import { newId, idempotencyKey } from './ids';
import { stamp } from './time';
import type { MovementType, StockMovement, StockSource, WastageReason } from './types';

/**
 * All writes to the ledger go through this module.
 *
 * Three properties are non-negotiable and are the reason this file exists:
 *
 *  1. APPEND-ONLY. Nothing here updates or deletes a movement. Undo and
 *     corrections append a REVERSAL. The database enforces it too (triggers in
 *     m001), because application-level agreements not to mutate a ledger have a
 *     perfect record of eventually being broken.
 *
 *  2. IDEMPOTENT. Every write carries a key derived from the user's tap, so a
 *     retry, a replay, or a double-submit collides on a UNIQUE index and
 *     becomes a no-op that reports success. A double-decrement is not merely
 *     unlikely, it is unrepresentable.
 *
 *  3. DOSE-DENOMINATED. Callers pass doses. Vial conversion happens in the UI
 *     layer via domain/stock.ts before it ever reaches here.
 */

export interface WriteContext {
  deviceId: string;
  /** Injectable for tests; defaults to now. */
  now?: number;
  /** Injectable for tests; defaults to the device's current offset. */
  tzOffsetMinutes?: number;
}

export interface WriteResult {
  movement: StockMovement;
  /** false means an identical intent had already been recorded - a safe no-op. */
  created: boolean;
}

interface MovementInput {
  /** Minted when the button is pressed, reused across every retry of that intent. */
  clientActionId: string;
  vaccineId: string;
  lotId?: string | null;
  deltaDoses: number;
  movementType: MovementType;
  wastageReason?: WastageReason | null;
  stockSource?: StockSource;
  patientId?: string | null;
  patientLabel?: string | null;
  reversesId?: string | null;
  note?: string | null;
  needsDetail?: boolean;
  /** Backdating. Defaults to ctx.now. */
  occurredAt?: number;
}

async function insertMovement(db: Db, ctx: WriteContext, input: MovementInput): Promise<WriteResult> {
  const now = ctx.now ?? Date.now();
  const s = stamp(input.occurredAt ?? now, ctx.tzOffsetMinutes);
  const key = idempotencyKey(ctx.deviceId, input.clientActionId);

  const res = await db.run(
    `INSERT INTO stock_movements (
       id, idempotency_key, vaccine_id, lot_id, delta_doses, movement_type,
       wastage_reason, stock_source, patient_id, patient_label,
       occurred_at, local_date, local_time, tz_offset_minutes, recorded_at,
       reverses_id, note, needs_detail, created_at, updated_at, device_id, price_rupees
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
       -- A dose stamps today's price, so a later price edit cannot re-price it.
       (SELECT price_rupees FROM vaccines WHERE id = ?))
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [
      newId(now),
      key,
      input.vaccineId,
      input.lotId ?? null,
      input.deltaDoses,
      input.movementType,
      input.wastageReason ?? null,
      input.stockSource ?? 'CLINIC_STOCK',
      input.patientId ?? null,
      input.patientLabel ?? null,
      s.occurredAt,
      s.localDate,
      s.localTime,
      s.tzOffsetMinutes,
      now,
      input.reversesId ?? null,
      input.note ?? null,
      input.needsDetail ? 1 : 0,
      now,
      now,
      ctx.deviceId,
      input.movementType === 'ADMINISTRATION' ? input.vaccineId : null,
    ],
  );

  // Always read back by the idempotency key, so a conflicting write returns the
  // row that already exists rather than failing.
  const movement = await db.first<StockMovement>(
    `SELECT * FROM stock_movements WHERE idempotency_key = ?`,
    [key],
  );
  if (!movement) throw new Error('movement insert produced no row');
  return { movement, created: res.changes > 0 };
}

/** Log a delivery. `doses` must already be converted from vials by the caller. */
export async function recordReceipt(
  db: Db,
  ctx: WriteContext,
  input: { clientActionId: string; vaccineId: string; lotId: string; doses: number; note?: string },
): Promise<WriteResult> {
  if (input.doses <= 0) throw new Error('a receipt must add a positive number of doses');
  return insertMovement(db, ctx, { ...input, deltaDoses: input.doses, movementType: 'RECEIPT' });
}

/**
 * Log a dose given. The child is OPTIONAL by design: an unnamed dose is
 * enormously better than an unlogged dose, so stock arithmetic is never held
 * hostage to a data-entry field. Skipping flags needs_detail so the name can be
 * filled in at day end.
 */
export async function recordAdministration(
  db: Db,
  ctx: WriteContext,
  input: {
    clientActionId: string;
    vaccineId: string;
    lotId?: string | null;
    doses?: number;
    patientId?: string | null;
    patientLabel?: string | null;
    occurredAt?: number;
    note?: string;
  },
): Promise<WriteResult> {
  const doses = input.doses ?? 1;
  if (doses <= 0) throw new Error('an administration must remove a positive number of doses');
  return insertMovement(db, ctx, {
    ...input,
    deltaDoses: -doses,
    movementType: 'ADMINISTRATION',
    needsDetail: !input.patientId && !input.patientLabel,
  });
}

export async function recordWastage(
  db: Db,
  ctx: WriteContext,
  input: {
    clientActionId: string;
    vaccineId: string;
    lotId?: string | null;
    doses: number;
    reason: WastageReason;
    note?: string;
  },
): Promise<WriteResult> {
  if (input.doses <= 0) throw new Error('wastage must remove a positive number of doses');
  return insertMovement(db, ctx, {
    ...input,
    deltaDoses: -input.doses,
    movementType: 'WASTAGE',
    wastageReason: input.reason,
  });
}

/** One-time migration of the paper notebook's closing balance. */
export async function recordOpeningBalance(
  db: Db,
  ctx: WriteContext,
  input: { clientActionId: string; vaccineId: string; lotId?: string | null; doses: number },
): Promise<WriteResult> {
  if (input.doses <= 0) throw new Error('an opening balance must be positive');
  return insertMovement(db, ctx, {
    ...input,
    deltaDoses: input.doses,
    movementType: 'OPENING_BALANCE',
  });
}

/**
 * The result of a physical count disagreeing with the ledger. The discrepancy
 * is recorded as a fact in its own right - never absorbed by silently
 * overwriting the balance, because the pattern of discrepancies over time is
 * the single best diagnostic this app will ever produce.
 */
export async function recordAdjustment(
  db: Db,
  ctx: WriteContext,
  input: {
    clientActionId: string;
    vaccineId: string;
    lotId?: string | null;
    deltaDoses: number;
    note: string;
  },
): Promise<WriteResult> {
  if (input.deltaDoses === 0) throw new Error('an adjustment of zero is not a movement');
  return insertMovement(db, ctx, { ...input, movementType: 'ADJUSTMENT' });
}

/**
 * THE ONLY UNDO MECHANISM, and the only correction mechanism.
 *
 * The 3.5-second snackbar and a correction made three weeks later run through
 * this exact path. One code path means one set of bugs, and it means undo can
 * never be quietly implemented as a delete that breaks the audit trail.
 */
export async function reverseMovement(
  db: Db,
  ctx: WriteContext,
  input: { clientActionId: string; movementId: string; note?: string },
): Promise<WriteResult> {
  const original = await db.first<StockMovement>(`SELECT * FROM stock_movements WHERE id = ?`, [
    input.movementId,
  ]);
  if (!original) throw new Error(`cannot reverse unknown movement ${input.movementId}`);
  if (original.movement_type === 'REVERSAL') {
    throw new Error('cannot reverse a REVERSAL - append a new forward movement instead');
  }

  // A movement can be reversed at most once - UNIQUE(reverses_id) enforces it.
  // A second attempt is a double-tap on "Correct this entry", not a second
  // intent, so return the reversal that already exists instead of letting the
  // constraint surface as an unhandled rejection. Same reasoning as the
  // idempotency key: a repeated request becomes a no-op that reports success.
  const already = await db.first<StockMovement>(
    `SELECT * FROM stock_movements WHERE reverses_id = ?`,
    [original.id],
  );
  if (already) return { movement: already, created: false };

  return insertMovement(db, ctx, {
    clientActionId: input.clientActionId,
    vaccineId: original.vaccine_id,
    lotId: original.lot_id,
    deltaDoses: -original.delta_doses,
    movementType: 'REVERSAL',
    reversesId: original.id,
    stockSource: original.stock_source,
    note: input.note ?? null,
  });
}

export async function isReversed(db: Db, movementId: string): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE reverses_id = ?`,
    [movementId],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Soft double-tap detection. Deliberately NOT a block.
 *
 * Legitimate rapid repeats are common - siblings, twins, a queue of infants at
 * the same schedule point. A hard dedupe window silently LOSES administrations,
 * and under-recording is worse than double-recording: a double shows up at
 * reconciliation, whereas a miss just looks like theft. So the UI shows a
 * non-modal nudge ("BCG 1 dose recorded 20s ago. Another child?") and lets the
 * clinician decide.
 */
export async function findRecentSimilar(
  db: Db,
  input: { vaccineId: string; movementType: MovementType; deltaDoses: number; withinMs?: number },
  now: number = Date.now(),
): Promise<StockMovement | null> {
  const since = now - (input.withinMs ?? 45_000);
  return db.first<StockMovement>(
    `SELECT * FROM v_movement_effective
      WHERE vaccine_id = ? AND movement_type = ? AND delta_doses = ? AND recorded_at >= ?
      ORDER BY recorded_at DESC LIMIT 1`,
    [input.vaccineId, input.movementType, input.deltaDoses, since],
  );
}

/** Complete a skipped child name. Annotations are editable; arithmetic is not. */
export async function fillMissingChild(
  db: Db,
  input: { movementId: string; patientId?: string | null; patientLabel: string },
  now: number = Date.now(),
): Promise<void> {
  await db.run(
    `UPDATE stock_movements
        SET patient_id = ?, patient_label = ?, needs_detail = 0, updated_at = ?
      WHERE id = ?`,
    [input.patientId ?? null, input.patientLabel, now, input.movementId],
  );
}
