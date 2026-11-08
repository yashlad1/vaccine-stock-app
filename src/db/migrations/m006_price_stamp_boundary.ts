import type { Db } from '../driver';

/**
 * Migration 006 - tell "no stamp, the column did not exist" from "no stamp,
 * this vaccine had no price".
 *
 * Before this, both were NULL, and Trends valued every NULL at today's price,
 * so the first price the owner set would have re-priced a vaccine's whole
 * history (CLAUDE.md section 9: editing a price never re-prices the past).
 *
 * The fix is a boundary, not a backfill: `trg_movements_immutable_price`
 * forbids UPDATEs of the stamp, and 0 cannot mean "unpriced" because 0 is a
 * real price (government doses). `price_stamp_from` is the `recorded_at` before
 * which an unstamped dose is treated as predating m005 and valued at today's
 * price; at or after it, a NULL stamp stays "Price not set".
 *
 * Existing rows: the earliest STAMPED movement proves m005 had shipped by then.
 * With none stamped there is no evidence any row predates m005, and valuing
 * history at a later price is the worse mistake (a wrong rupee figure versus
 * "Price not set"), so the boundary is 0 and nothing falls back. A fresh
 * install also gets 0. `settings` is not replicated, so this is per device.
 *
 * Also hardens the append-only trigger: `recorded_at` and `created_at` were
 * missing from trg_movements_immutable_arithmetic. Restore orders its replay
 * by `recorded_at` and push keys a re-queue on `updated_at <> created_at`, so
 * neither may change. A new trigger, because shipped migrations are not edited.
 *
 * No server-visible column changes.
 */
export const m006 = {
  to: 6,
  name: 'price_stamp_boundary',
  up: async (tx: Db) => {
    const first = await tx.first<{ at: number | null }>(
      `SELECT MIN(recorded_at) AS at FROM stock_movements WHERE price_rupees IS NOT NULL`,
    );
    await tx.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('price_stamp_from', ?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [String(first?.at ?? 0), Date.now()],
    );
    await tx.exec(`
CREATE TRIGGER trg_movements_immutable_times
BEFORE UPDATE OF recorded_at, created_at ON stock_movements
BEGIN
  SELECT RAISE(ABORT,
    'stock_movements is append-only: append a REVERSAL instead of editing a movement');
END;
    `);
  },
};
