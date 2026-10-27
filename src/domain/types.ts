export type UnitMode = 'DOSE' | 'VIAL';

export type MovementType =
  | 'OPENING_BALANCE'
  | 'RECEIPT'
  | 'ADMINISTRATION'
  | 'WASTAGE'
  | 'ADJUSTMENT'
  | 'REVERSAL';

export type WastageReason =
  | 'OPEN_VIAL_TIMEOUT'
  | 'BREAKAGE'
  | 'EXPIRED'
  | 'COLD_CHAIN'
  | 'CONTAMINATION'
  | 'OTHER';

export type FundingSource = 'PRIVATE' | 'GOVT_UIP';
export type StockSource = 'CLINIC_STOCK' | 'PATIENT_SUPPLIED';

export interface Vaccine {
  id: string;
  name: string;
  generic_name: string | null;
  aliases: string;
  unit_mode: UnitMode;
  doses_per_vial: number;
  min_balance_doses: number;
  is_active: number;
  sort_hint: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  device_id: string;
  /** Selling price per dose in whole rupees (m005); null when not set. */
  price_rupees: number | null;
}

export interface Lot {
  id: string;
  vaccine_id: string;
  lot_number: string;
  expiry_date: string | null;
  funding_source: FundingSource;
  first_received_at: number | null;
}

export interface StockMovement {
  id: string;
  idempotency_key: string;
  vaccine_id: string;
  lot_id: string | null;
  delta_doses: number;
  movement_type: MovementType;
  wastage_reason: WastageReason | null;
  stock_source: StockSource;
  patient_id: string | null;
  patient_label: string | null;
  staff_id: string | null;
  occurred_at: number;
  local_date: string;
  local_time: string;
  tz_offset_minutes: number;
  recorded_at: number;
  reverses_id: string | null;
  note: string | null;
  needs_detail: number;
  device_id: string;
  /** The price this dose was given at (m005); null for doses before prices, and for non-doses. */
  price_rupees: number | null;
}

/** A row of v_stock_on_hand. */
export interface StockRow {
  vaccine_id: string;
  name: string;
  generic_name: string | null;
  /** JSON array, search only - never identity. */
  aliases: string | null;
  unit_mode: UnitMode;
  doses_per_vial: number;
  min_balance_doses: number;
  is_active: number;
  on_hand_doses: number;
}
