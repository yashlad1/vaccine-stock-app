import type { Db } from '../driver';

/**
 * Migration 005 - a selling price per dose, for the Trends sales value.
 *
 * Reverses the "no cost" decision at the owner's request (27 Oct 2026), and
 * only that far: one price per vaccine, in whole rupees. No billing, GST,
 * invoices or payments.
 *
 * Two columns, because a price edit must not re-price the past. The vaccine
 * holds today's price; each dose stamps the price it was given at, the way
 * `patient_label` keeps the name as typed. Doses from before this migration
 * have no stamp, and are valued at today's price instead.
 *
 * The server needs both columns BEFORE this ships: vaccines push first in
 * PUSH_ORDER, so an unknown column there would stop every upload.
 */
export const m005 = {
  to: 5,
  name: 'prices',
  up: async (tx: Db) => {
    await tx.exec(`
ALTER TABLE vaccines ADD COLUMN price_rupees INTEGER CHECK (price_rupees IS NULL OR price_rupees >= 0);
ALTER TABLE stock_movements ADD COLUMN price_rupees INTEGER CHECK (price_rupees IS NULL OR price_rupees >= 0);

-- The stamp is part of the record, so it is as immutable as the arithmetic
-- (trg_movements_immutable_arithmetic lists its columns by name).
CREATE TRIGGER trg_movements_immutable_price
BEFORE UPDATE OF price_rupees ON stock_movements
BEGIN
  SELECT RAISE(ABORT,
    'stock_movements is append-only: append a REVERSAL instead of editing a movement');
END;
    `);
  },
};
