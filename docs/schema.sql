-- Reference DDL for Vialbook, schema v5.
--
-- GENERATED from src/db/migrations by scripts/dump-schema.ts.
-- Do not edit by hand; run `npm run schema:dump` instead.
--
-- The migrations are the source of truth. This file exists so reviewers and
-- the ERD have a single flat view of what they produce.

PRAGMA user_version = 5;

CREATE TABLE lots (
  id                TEXT    PRIMARY KEY NOT NULL,
  vaccine_id        TEXT    NOT NULL REFERENCES vaccines(id),
  lot_number        TEXT    NOT NULL,
  expiry_date       TEXT,                                -- 'YYYY-MM-DD', last day of printed month
  funding_source    TEXT    NOT NULL DEFAULT 'PRIVATE'
                            CHECK (funding_source IN ('PRIVATE','GOVT_UIP')),
  first_received_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  device_id         TEXT    NOT NULL
, dirty INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER);

CREATE TABLE patients (
  id             TEXT    PRIMARY KEY NOT NULL,
  name           TEXT    NOT NULL,
  dob            TEXT,
  guardian_phone TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  device_id      TEXT    NOT NULL
, dirty INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER, sex TEXT CHECK (sex IN ('M','F')));

CREATE TABLE settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE staff (
  id         TEXT    PRIMARY KEY NOT NULL,
  name       TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id  TEXT    NOT NULL
, dirty INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER);

CREATE TABLE stock_movements (
  id                TEXT    PRIMARY KEY NOT NULL,
  -- Derived from (device_id, client_action_id) at the moment of the user's tap,
  -- so a retried or replayed write is a no-op that looks like success.
  idempotency_key   TEXT    NOT NULL UNIQUE,
  vaccine_id        TEXT    NOT NULL REFERENCES vaccines(id),
  lot_id            TEXT    REFERENCES lots(id),
  delta_doses       INTEGER NOT NULL CHECK (delta_doses <> 0),
  movement_type     TEXT    NOT NULL CHECK (movement_type IN
                      ('OPENING_BALANCE','RECEIPT','ADMINISTRATION',
                       'WASTAGE','ADJUSTMENT','REVERSAL')),
  wastage_reason    TEXT    CHECK (wastage_reason IS NULL OR wastage_reason IN
                      ('OPEN_VIAL_TIMEOUT','BREAKAGE','EXPIRED',
                       'COLD_CHAIN','CONTAMINATION','OTHER')),
  -- Only CLINIC_STOCK affects on-hand. Present from day one with no UI: it costs
  -- one column and means adding patient-supplied doses later is not a migration
  -- of the entire ledger.
  stock_source      TEXT    NOT NULL DEFAULT 'CLINIC_STOCK'
                            CHECK (stock_source IN ('CLINIC_STOCK','PATIENT_SUPPLIED')),
  patient_id        TEXT    REFERENCES patients(id),
  -- The child's name exactly as typed at that moment. Renaming or merging a
  -- patient later must never rewrite history.
  patient_label     TEXT,
  staff_id          TEXT    REFERENCES staff(id),
  occurred_at       INTEGER NOT NULL,   -- epoch ms UTC; the clinical time
  -- local_date/local_time are computed and STORED at write time. 'Given today'
  -- is then an indexed equality test that is deterministic and unit-testable;
  -- date('now','localtime') at query time depends on the device's *current*
  -- timezone and cannot be tested in CI.
  local_date        TEXT    NOT NULL,   -- 'YYYY-MM-DD'
  local_time        TEXT    NOT NULL,   -- 'HH:MM'
  tz_offset_minutes INTEGER NOT NULL,
  recorded_at       INTEGER NOT NULL,   -- when the row was actually written
  reverses_id       TEXT    REFERENCES stock_movements(id),
  note              TEXT,
  needs_detail      INTEGER NOT NULL DEFAULT 0 CHECK (needs_detail IN (0,1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  device_id         TEXT    NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER, price_rupees INTEGER CHECK (price_rupees IS NULL OR price_rupees >= 0),

  -- Sign invariants: the type and the sign of delta_doses must agree.
  CHECK (movement_type NOT IN ('OPENING_BALANCE','RECEIPT') OR delta_doses > 0),
  CHECK (movement_type NOT IN ('ADMINISTRATION','WASTAGE')  OR delta_doses < 0),
  -- Only a REVERSAL may point at another movement, and it must.
  CHECK (movement_type <> 'REVERSAL' OR reverses_id IS NOT NULL),
  CHECK (reverses_id IS NULL OR movement_type = 'REVERSAL'),
  CHECK (wastage_reason IS NULL OR movement_type = 'WASTAGE')
);

CREATE TABLE sync_cursor (
  table_name        TEXT PRIMARY KEY NOT NULL,
  server_synced_at  TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE sync_log (
  id            TEXT    PRIMARY KEY NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  pushed_rows   INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
  -- Kept so a failing phone can be diagnosed over WhatsApp without a debugger.
  error         TEXT,
  device_id     TEXT    NOT NULL
);

CREATE TABLE vaccines (
  id                TEXT    PRIMARY KEY NOT NULL,
  name              TEXT    NOT NULL,                    -- trade name, as printed on the vial
  generic_name      TEXT,                                -- nullable; groups trade names later
  aliases           TEXT    NOT NULL DEFAULT '[]',       -- JSON array; powers search only
  unit_mode         TEXT    NOT NULL CHECK (unit_mode IN ('DOSE','VIAL')),
  doses_per_vial    INTEGER NOT NULL DEFAULT 1 CHECK (doses_per_vial >= 1),
  min_balance_doses INTEGER NOT NULL DEFAULT 0 CHECK (min_balance_doses >= 0),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_hint         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  device_id         TEXT    NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER, price_rupees INTEGER CHECK (price_rupees IS NULL OR price_rupees >= 0),
  -- A single-dose presentation cannot claim more than one dose per vial.
  CHECK (unit_mode <> 'DOSE' OR doses_per_vial = 1)
);

CREATE INDEX ix_lots_dirty ON lots (updated_at) WHERE dirty = 1;

CREATE INDEX ix_lots_expiry  ON lots(expiry_date) WHERE deleted_at IS NULL;

CREATE INDEX ix_lots_identity ON lots(vaccine_id, lot_number, funding_source);

CREATE INDEX ix_lots_vaccine ON lots(vaccine_id) WHERE deleted_at IS NULL;

CREATE INDEX ix_movements_local_date ON stock_movements(local_date);

CREATE INDEX ix_movements_lot        ON stock_movements(lot_id);

CREATE INDEX ix_movements_needs_detail
  ON stock_movements(needs_detail) WHERE needs_detail = 1;

CREATE INDEX ix_movements_occurred   ON stock_movements(occurred_at);

CREATE INDEX ix_movements_patient    ON stock_movements(patient_id);

CREATE INDEX ix_movements_vaccine    ON stock_movements(vaccine_id);

CREATE INDEX ix_patients_dirty ON patients (updated_at) WHERE dirty = 1;

CREATE INDEX ix_patients_name  ON patients(name) WHERE deleted_at IS NULL;

CREATE INDEX ix_patients_phone ON patients(guardian_phone) WHERE deleted_at IS NULL;

CREATE INDEX ix_staff_dirty ON staff (updated_at) WHERE dirty = 1;

CREATE INDEX ix_stock_movements_dirty ON stock_movements (updated_at) WHERE dirty = 1;

CREATE INDEX ix_sync_log_started ON sync_log (started_at DESC);

CREATE INDEX ix_vaccines_active ON vaccines(is_active) WHERE deleted_at IS NULL;

CREATE INDEX ix_vaccines_dirty ON vaccines (updated_at) WHERE dirty = 1;

CREATE UNIQUE INDEX ux_movements_reverses
  ON stock_movements(reverses_id) WHERE reverses_id IS NOT NULL;

CREATE UNIQUE INDEX ux_vaccines_name ON vaccines(name) WHERE deleted_at IS NULL;

CREATE VIEW v_lot_balance AS
SELECT
  l.id                            AS lot_id,
  l.vaccine_id                    AS vaccine_id,
  l.lot_number                    AS lot_number,
  l.expiry_date                   AS expiry_date,
  l.funding_source                AS funding_source,
  COALESCE(SUM(m.delta_doses), 0) AS on_hand_doses
FROM lots l
LEFT JOIN stock_movements m
       ON m.lot_id = l.id
      AND m.stock_source = 'CLINIC_STOCK'
WHERE l.deleted_at IS NULL
GROUP BY l.id;

CREATE VIEW v_movement_effective AS
SELECT m.* FROM stock_movements m
WHERE m.movement_type <> 'REVERSAL'
  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id);

CREATE VIEW v_stock_on_hand AS
SELECT
  v.id                                AS vaccine_id,
  v.name                              AS name,
  v.generic_name                      AS generic_name,
  v.unit_mode                         AS unit_mode,
  v.doses_per_vial                    AS doses_per_vial,
  v.min_balance_doses                 AS min_balance_doses,
  v.is_active                         AS is_active,
  COALESCE(SUM(m.delta_doses), 0)     AS on_hand_doses
FROM vaccines v
LEFT JOIN stock_movements m
       ON m.vaccine_id = v.id
      AND m.stock_source = 'CLINIC_STOCK'
WHERE v.deleted_at IS NULL
GROUP BY v.id;

CREATE TRIGGER trg_lots_dirty
AFTER UPDATE ON lots
WHEN NEW.updated_at <> OLD.updated_at
BEGIN
  UPDATE lots SET dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER trg_movements_immutable_arithmetic
BEFORE UPDATE OF
  id, idempotency_key, vaccine_id, lot_id, delta_doses, movement_type,
  wastage_reason, stock_source, occurred_at, local_date, local_time,
  tz_offset_minutes, reverses_id, device_id
ON stock_movements
BEGIN
  SELECT RAISE(ABORT,
    'stock_movements is append-only: append a REVERSAL instead of editing a movement');
END;

CREATE TRIGGER trg_movements_immutable_price
BEFORE UPDATE OF price_rupees ON stock_movements
BEGIN
  SELECT RAISE(ABORT,
    'stock_movements is append-only: append a REVERSAL instead of editing a movement');
END;

CREATE TRIGGER trg_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT,
    'stock_movements is append-only: append a REVERSAL instead of deleting a movement');
END;

CREATE TRIGGER trg_movements_no_reversal_of_reversal
BEFORE INSERT ON stock_movements
WHEN NEW.reverses_id IS NOT NULL
 AND (SELECT movement_type FROM stock_movements WHERE id = NEW.reverses_id) = 'REVERSAL'
BEGIN
  SELECT RAISE(ABORT,
    'cannot reverse a REVERSAL: append a new forward movement instead');
END;

CREATE TRIGGER trg_patients_dirty
AFTER UPDATE ON patients
WHEN NEW.updated_at <> OLD.updated_at
BEGIN
  UPDATE patients SET dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER trg_staff_dirty
AFTER UPDATE ON staff
WHEN NEW.updated_at <> OLD.updated_at
BEGIN
  UPDATE staff SET dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER trg_stock_movements_dirty
AFTER UPDATE ON stock_movements
WHEN NEW.updated_at <> OLD.updated_at
BEGIN
  UPDATE stock_movements SET dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER trg_vaccines_dirty
AFTER UPDATE ON vaccines
WHEN NEW.updated_at <> OLD.updated_at
BEGIN
  UPDATE vaccines SET dirty = 1 WHERE id = NEW.id;
END;

