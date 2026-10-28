-- One-off cleanup: two catalog rows with the same name on the server.
--
-- The phone cannot hold this (ux_vaccines_name is UNIQUE on active rows), but
-- Postgres deliberately does not enforce it (see the note by ix_vaccines_name),
-- so a device that seeded its own catalog instead of adopting the clinic's left
-- a second, never-used copy here. The dashboard reads the server directly, so
-- it shows both: "BCG · 10 doses" and "BCG · OUT 0" side by side, and the
-- 0-dose ghost sorts to the top of Needs attention.
--
-- Run STEP 1 and read it before running STEP 2.

-- STEP 1 - what is duplicated, and which row the ledger actually uses.
SELECT v.name,
       v.id,
       v.device_id,
       to_timestamp(v.created_at / 1000) AS created,
       (SELECT count(*) FROM public.stock_movements m WHERE m.vaccine_id = v.id) AS movements
  FROM public.vaccines v
 WHERE v.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM public.vaccines d
                WHERE d.deleted_at IS NULL AND d.owner = v.owner
                  AND d.name = v.name AND d.id <> v.id)
 ORDER BY v.name, movements DESC;

-- STEP 2 - soft-delete the copies that have no ledger history at all.
--
-- Soft delete, never DELETE (invariant 3), and the NOT EXISTS is the safety
-- belt: a row any dose was ever recorded against is left alone even if it loses
-- the ranking, because merging two live histories is a human decision.
-- updated_at and synced_at are bumped on purpose - updated_at so the server's
-- stale-write guard accepts it and a phone's pull sees it as newer, synced_at
-- so pull's cursor delivers it at all.
WITH ranked AS (
  SELECT v.id,
         row_number() OVER (
           PARTITION BY v.owner, v.name
           ORDER BY (SELECT count(*) FROM public.stock_movements m
                      WHERE m.vaccine_id = v.id) DESC,
                    v.created_at ASC
         ) AS rn
    FROM public.vaccines v
   WHERE v.deleted_at IS NULL
)
UPDATE public.vaccines v
   SET deleted_at = (extract(epoch FROM now()) * 1000)::bigint,
       updated_at = (extract(epoch FROM now()) * 1000)::bigint,
       synced_at  = now()
  FROM ranked r
 WHERE r.id = v.id
   AND r.rn > 1
   AND NOT EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.vaccine_id = v.id)
RETURNING v.name, v.id;
