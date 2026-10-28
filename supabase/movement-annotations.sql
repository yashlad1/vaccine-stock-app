-- One-off: let a child's name that is filled in AFTER the dose was uploaded
-- reach the server (and so the other device and the 4x-a-day backups).
--
-- Run it once in the Supabase SQL Editor. Safe to run again, and safe to run
-- before or after the app update: until it has run, the app behaves exactly
-- as before - every dose uploads, and only the names filled in later wait on
-- the phone. They go up by themselves on the first sync after this has run.
--
-- What it changes, on public.stock_movements only:
--   1. An UPDATE policy for the signed-in clinic's own rows. There is still
--      no DELETE policy, so nothing can be deleted.
--   2. A trigger that refuses any change except the annotations: patient_id,
--      patient_label, needs_detail, note and updated_at. It compares whole
--      rows, so the arithmetic (vaccine, batch, doses, type, times, price,
--      reversal link, owner) and any column added later stay as written.
--      This mirrors the phone's trg_movements_immutable_arithmetic.
--   3. The stale-edit guard the other tables already have: an older edit
--      never overwrites a newer one, and an accepted edit gets a fresh
--      synced_at, which is what lets the other device's pull see it.
--
-- Matches supabase/schema.sql, which carries the same three things, and uses
-- its public.reject_stale_update(), already on the server.

CREATE OR REPLACE FUNCTION public.movement_annotations_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - ARRAY['patient_id', 'patient_label', 'needs_detail', 'note', 'updated_at', 'synced_at']
     IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['patient_id', 'patient_label', 'needs_detail', 'note', 'updated_at', 'synced_at'] THEN
    RAISE EXCEPTION 'stock_movements is append-only: only the child name, needs_detail and note can change';
  END IF;
  RETURN NEW;
END; $$;

-- BEFORE triggers fire in name order, so this check runs before the guard.
DROP TRIGGER IF EXISTS trg_stock_movements_annotations_only ON public.stock_movements;
CREATE TRIGGER trg_stock_movements_annotations_only BEFORE UPDATE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.movement_annotations_only();

DROP TRIGGER IF EXISTS trg_stock_movements_stale ON public.stock_movements;
CREATE TRIGGER trg_stock_movements_stale BEFORE UPDATE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_stale_update();

DROP POLICY IF EXISTS stock_movements_update ON public.stock_movements;
CREATE POLICY stock_movements_update ON public.stock_movements
  FOR UPDATE TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

-- Check it took. Expect exactly these three rows:
--   policy   stock_movements_update
--   trigger  trg_stock_movements_annotations_only
--   trigger  trg_stock_movements_stale
SELECT 'policy' AS kind, policyname::text AS name
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'stock_movements' AND cmd = 'UPDATE'
UNION ALL
SELECT 'trigger', tgname::text
  FROM pg_trigger
 WHERE tgrelid = 'public.stock_movements'::regclass AND NOT tgisinternal
ORDER BY 1, 2;
