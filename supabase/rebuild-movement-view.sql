-- Rebuild v_movement_effective so it carries price_rupees.
--
-- Run once in the Supabase SQL Editor. Safe to run again.
--
-- Why: in Postgres, SELECT * inside a view is expanded when the view is
-- CREATED. This view predates migration m005, which added price_rupees to
-- stock_movements, so the column is on the table but not on the view. Checked
-- 9 Nov 2026 against the live server:
--   stock_movements.price_rupees       -> 42501 permission denied  (exists)
--   v_movement_effective.price_rupees  -> 42703 does not exist
-- The iPhone dashboard's Money tab asks the view for that column.
--
-- What it does NOT touch: no table, no row, no policy on any table. Phone
-- uploads write to stock_movements, never to this view, so they are
-- unaffected. Nothing else selects from this view (checked against
-- supabase/schema.sql), so it can be dropped on its own.
--
-- One transaction, so the dashboard never sees a moment with no view.
-- Dropping a view drops its GRANT too, so the grant is re-applied here.

BEGIN;

DROP VIEW IF EXISTS public.v_movement_effective;

CREATE VIEW public.v_movement_effective
  WITH (security_invoker = true) AS
SELECT m.* FROM public.stock_movements m
WHERE m.movement_type <> 'REVERSAL'
  AND NOT EXISTS (
    SELECT 1 FROM public.stock_movements r WHERE r.reverses_id = m.id
  );

GRANT SELECT ON public.v_movement_effective TO authenticated;

COMMIT;

-- Check: this should return one row naming the column.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'v_movement_effective'
   AND column_name = 'price_rupees';
