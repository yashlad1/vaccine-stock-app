# Multi-device plan — clinic phone + clinic tablet + iPhone at home

**Requirement (8 Sep 2026).** Stock and entry data should be visible on the clinic tablet and on a
personal iPhone, so the clinician can tell from home or out of office whether stock is present and
whether the day's entries were actually made.

**Decisions taken:** phone *and* Android tablet both enter data; the iPhone gets a read-only web page
saved to the home screen (no Apple Developer account, no App Store).

```
   Android phone  ──┐                   ┌──►  Android tablet   (enters + views)
   (enters + views) ├──►  Supabase  ◄───┤
                    │     (Postgres)    └──►  iPhone web page  (views only)
   both push AND pull                        Safari → Home Screen
```

---

## 1. What is already free, and why

Three earlier decisions make the expensive part of multi-device cheap:

| Existing design | What it buys here |
| --- | --- |
| `stock_movements` is append-only with client-generated UUIDs | Doses **merge without conflict resolution**. There is no "which edit wins" question because there are no edits |
| `idempotency_key` is `deviceId:clientActionId` | Two devices can never collide on a movement, even recording the same child at the same second |
| On-hand is `SUM(delta_doses)`, never stored | Any device holding the full ledger computes the **identical** number. Stock does not need syncing — only the movements do |
| `synced_at timestamptz DEFAULT now()` already on every server table | Gives a **server-clock** watermark for incremental pull. Using the client's `updated_at` would silently skip rows from any device with a wrong clock |

So the work is not "build sync". It is "add pull, and handle the four places where two devices can
create the same thing twice".

---

## 2. The hazards, in order of how certain they are

### H1 — A new device seeds its own catalog. **This is a certainty, not a risk.**

`catalog_seeded` is a *local* setting ([provider.tsx:74](../src/db/provider.tsx#L74)). Install the APK
on the tablet and it seeds its own ~26 vaccines with **fresh UUIDs**, marks them `dirty = 1`, and
pushes them. The server ends up with two BCG rows, two Pentavac rows, and so on.

That is **failure mode 1 recreated by the sync layer** — the exact "same vaccine, more than one row"
problem this whole app exists to prevent. It would happen on day one, before anyone gave a dose.

**Fix:** first launch must **pull before it seeds**. If the server already has vaccines, adopt them
and set `catalog_seeded` without seeding. A device joining an existing clinic is a *restore*, not a
fresh install.

### H2 — Two devices add the same vaccine

`ux_vaccines_name` is `UNIQUE(name) WHERE deleted_at IS NULL`. Both devices add "Pneumosil" while
offline → two rows, same name, different ids. The incoming row violates the local index.

The index is load-bearing and must stay. But a true merge is impossible today: `vaccine_id` is in the
immutability trigger's column list, so past doses cannot be re-pointed.

**Fix, in two parts:**
- **Prevent:** adding a vaccine is an admin action, not a daily one. Restrict **"Add a new vaccine"
  to the primary device only** (a `settings` flag). Near-zero cost, removes almost all of H2.
- **Survive:** if it happens anyway, import the loser as `name || ' (duplicate)'` and show a
  "2 vaccines need merging" card. Nothing is lost and the ledger stays valid.
- **Later:** add `merged_into_id` to `vaccines` and have reads follow the pointer. That is a real
  merge without touching the append-only ledger. Sprint 4.

### H3 — Two devices log the same delivery

`ux_lots_identity` is `UNIQUE(vaccine_id, lot_number, funding_source)`. Both devices receive from lot
AB123 → two rows for one physical batch → incoming row rejected.

**Fix: relax `ux_lots_identity` to a non-unique index.** `findOrCreateLot` keeps deduplicating
locally, so duplicates only appear when two devices genuinely raced. The consequence is two batch
chips instead of one — **untidy, but the totals stay correct**, because per-vaccine stock sums
movements, not lots.

> This is the one place the plan breaks the additive-only migration rule in CLAUDE.md section 6. It
> drops an **index**, never a table or a column, and no row is lost. A unique constraint the merge
> cannot satisfy has to be relaxed; the alternative is rejecting real deliveries. Documented as a
> deliberate exception rather than a quiet one.

### H4 — Two devices undo the same entry

`ux_movements_reverses` is `UNIQUE(reverses_id)` — a movement can be reversed at most once, which is
what stops stock being double-credited. Two offline devices both tap "Correct this entry" on the same
dose → two REVERSAL rows pointing at it.

**And here is a defect in what already shipped:** the generated server schema has **zero unique
constraints** beyond primary keys. So the server would accept both reversals, and any device pulling
them would double-credit the stock. Unreachable today because nothing pulls — reachable the moment
Phase 1 lands.

**Fix:** the schema generator must emit the unique indexes too, and pull must treat a `reverses_id`
collision as "already corrected, keep the first" rather than an error.

### H5 — A number seen at home is stale, and nothing says so

The whole point of the iPhone view is to answer "is there stock?" and "was today entered?". If the
clinic phone has not synced for three hours, the answer shown is wrong and looks authoritative.

CLAUDE.md section 9 already says it: *a stock number without an as-of is a rumour.* On a remote
screen that stops being a nicety.

**Fix:** the dashboard leads with **freshness, not stock**:

```
   Clinic phone   last entry 25 min ago   ✓ synced 2 min ago
   Clinic tablet  last entry  3 hrs ago   ⚠ not synced since 9:40 am
   ─────────────────────────────────────────────────────────────
   Stock as of 2:14 pm today
```

If a device is behind, that is said **before** any number is shown.

### H6 — Both devices give the last dose

Two devices each record the last dose of a vaccine → on-hand goes negative after merge. This is
**correct and intended**: invariant 8 says negative is surfaced loudly, never clamped, because it is
the drift signal. It shows as a red **CHECK** badge. No fix needed; worth stating so it is not
mistaken for a bug.

### H7 — Clock skew changes what "today" means

`local_date` is stamped from the device clock at write time. Two devices in the same city agree. A
device with a badly wrong clock would file entries under the wrong day, and no merge can repair that
because `local_date` is immutable. Mitigation is a one-line check on the dashboard: if a device's
clock is more than a few minutes off the server's, say so.

---

## 3. Phase 1 — two-way sync (the app)

**Migration v3**
- `sync_cursor(table TEXT PRIMARY KEY, server_synced_at TEXT, updated_at INTEGER)` — the pull
  watermark, per table, keyed on the **server's** clock.
- Relax `ux_lots_identity` → non-unique (H3).
- `settings` flag `is_primary_device` for the catalog restriction (H2).
- Test: build v2 with rows, migrate, assert nothing lost and a duplicate lot now inserts.

**`src/sync/pull.ts`** — mirrors `push.ts`, same `SyncBackend` seam, same in-memory adapter for tests.
- `GET /rest/v1/{table}?synced_at=gt.{cursor}&order=synced_at.asc&limit=1000`, paged.
- `stock_movements` → `INSERT OR IGNORE` (append-only; first writer wins).
- Mutable tables → apply only if incoming `updated_at > local.updated_at`; then set `dirty = 0` so
  the pulled value is not immediately pushed back.
- Advance the cursor **only after** a page is committed, so an interrupted pull resumes rather than
  skips.
- Pull runs **before** push on each cycle, so a device learns about existing catalog rows before
  offering its own.

**First-run adoption (H1)** — `provider.tsx`: if sync is configured, attempt a pull before the
`catalogSeeded` check. Server has vaccines → adopt, mark seeded, do not seed.

**Server schema** — regenerate with unique indexes emitted (H4), plus the derived views (below).

**Tests worth having**
1. Two independent databases, interleaved doses, both sync → **identical derived stock** on both.
2. Same-lot delivery on both devices → both inserts survive, per-vaccine total still correct.
3. Same movement reversed on both → exactly one reversal, stock credited once.
4. A new device with sync configured adopts the catalog instead of seeding a second one.
5. Pull interrupted mid-page → resumes, loses nothing, duplicates nothing.
6. Property test: N random operations across 2 devices, converged stock equals single-device replay.

### Move the arithmetic into Postgres, once

`v_movement_effective` and `v_stock_on_hand` should be **created on the server too**, generated from
the same source as the SQLite definitions. Otherwise the web dashboard reimplements ledger
arithmetic in JavaScript, and two implementations of "what is on hand" will drift — which is the
category of bug this project has spent all its effort making impossible.

## 4. Phase 2 — the iPhone web page

Read-only static page, Supabase email login, saved to the home screen.

- **Hosting:** Cloudflare Pages or Vercel free tier. Static HTML + a little JS; no server.
- **Auth:** the same clinic login, typed once; Safari remembers it. RLS already scopes every row to
  that account, so the page cannot see anything else.
- **Reads:** `SELECT` from the Postgres views. No arithmetic in the page.
- **Shows, in this order:** device freshness (H5) → doses today → per-vaccine on-hand with LOW/OUT →
  today's entries with times.
- **Writes:** none. No write UI at all. It shares the clinic account, so this is a UI guarantee, not
  a cryptographic one — acceptable for her own phone; if that ever needs hardening, the answer is a
  `clinic_id` membership model with a read-only role, which is a bigger change.

**Not** React Native Web. A separate ~300-line page is smaller, loads instantly on mobile data, and
cannot break the app when it changes.

## 5. Phase 3 — tidy-up, only if needed

Merge duplicate batches; `merged_into_id` on vaccines for a true catalog merge; per-device names in
Settings so the dashboard says "Clinic phone" rather than a UUID prefix.

## 6. Effort and order

| Phase | Contents | Rough size |
| --- | --- | --- |
| 1a | Migration v3, server unique indexes, server views | half a day |
| 1b | `pull.ts` + merge rules + first-run adoption | 1–2 days |
| 1c | The six tests above | half a day |
| 2 | Web dashboard + hosting | 1–2 days |
| 3 | Tidy-up | later, if it turns out to matter |

**Ship 1a–1c before 2.** The dashboard is the visible half, but a dashboard reading a server that two
devices have quietly duplicated into is worse than no dashboard — it would show confident wrong
numbers, which is the one outcome this project treats as unacceptable.

## 7. What I would not do

- **No native iOS app.** $99/year and 90-day TestFlight expiry to answer "is there stock?".
- **No live push notifications.** "Stock is low" alerts are a separate feature and a separate
  conversation about interrupting someone's evening.
- **No entry from the iPhone.** Two entry devices already introduce H1–H4. A third, outside the
  clinic, adds backdating questions and no clinical benefit.
- **No abandoning the zip backup.** Three devices and a server still all depend on one Supabase
  account. A file she holds herself remains the only copy that depends on nothing.
