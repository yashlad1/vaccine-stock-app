-- One-off: the columns the Trends update adds on the phone (migrations 004 and 005).
--   patients.sex                  - the boys/girls split
--   vaccines.price_rupees         - today's selling price per dose
--   stock_movements.price_rupees  - the price each dose was given at
--
-- Run this in the Supabase SQL Editor BEFORE the update ships. Push sends every
-- local column of a table, and PostgREST answers an unknown column with a 400.
-- `vaccines` is the first table in the push order, so until this has run an
-- updated phone's push would fail at once and no dose would upload (they stay
-- safe on the phone, and go up once this has run).
--
-- Safe to run twice, and safe to run early: an older phone simply never sends them.

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS sex text;
ALTER TABLE public.vaccines ADD COLUMN IF NOT EXISTS price_rupees bigint;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS price_rupees bigint;
