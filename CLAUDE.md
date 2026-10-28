# CLAUDE.md — Clinic Vaccine Stock Logger

Authoritative spec for this repository. Read this before changing anything.

---

## 1. What this is

An offline Android app that replaces a pediatric clinic's paper vaccine-stock notebook. Two jobs
happen all day:

1. **Log a delivery** — new vaccine stock arrives daily or weekly.
2. **Log a dose given** — a child is vaccinated, and stock goes down.

Plus three reports the clinician explicitly asked for: vaccines given today (with time and count),
vaccines remaining, and the unique list of vaccines in stock.

### The two failure modes this app exists to eliminate

| # | Paper failure | How the app kills it |
| --- | --- | --- |
| 1 | The same vaccine is spelled several ways, so the notebook no longer has one row per vaccine | Vaccine names are **picked from a catalog, never typed**. `vaccine_id` is a foreign key that no data-entry screen can create. "Unique values" becomes a property of the schema, not a report that de-duplicates |
| 2 | The wrong vaccine's count is decremented, or a decrement is doubled or missed, and recorded stock silently drifts from the fridge | Stock is **never a number anyone edits**. It is `SUM(delta_doses)` over an append-only ledger. A mistake is fixed by *appending a reversing entry*, never by editing or deleting |

**Scope discipline: this is not an EMR, a practice-management system, or a billing tool.** Resist
every feature that pulls it that way.

---

## 2. Non-negotiable invariants

Violating any of these is a bug, however convenient the shortcut looks.

1. **`stock_movements` is append-only.** No `UPDATE`, no `DELETE`, ever. Undo and corrections insert
   a `REVERSAL` row pointing at the original via `reverses_id`. Both rows survive forever.
2. **On-hand stock is always derived**, never stored as a mutable column. A `current_stock` integer
   *is* the paper notebook in a database — it is the artifact that drifts.
3. **Vaccine identity comes from a `vaccines` row.** Free text is fine for *notes*; never for
   *identity*. Adding a vaccine is reachable ONLY from the Vaccines tab (`catalog/new.tsx`), never
   from a dose or stock entry screen.
   **Removing a vaccine is a soft delete** (`deleted_at`), and a hard `DELETE` must never be added:
   every past dose references that row, so deleting it would orphan the ledger and break the history
   screen, the CSV export and every report that names the vaccine. The clinician sees a removal; the
   record keeps everything that was ever given. Because `ux_vaccines_name` is partial on
   `deleted_at IS NULL`, the name is freed, so a mistaken removal is undone by simply adding it back.
4. **The clinician never does arithmetic.** The app converts vials to doses. If a screen asks a
   human to multiply, the screen is wrong.
5. **Recording a dose must never be blocked** by a missing child name, a low-stock warning, or a
   confirmation dialog. An unnamed dose is enormously better than an unlogged dose; an app that
   refuses to record a vaccination to protect its own inventory numbers gets abandoned, correctly.
6. **Nothing outside `src/db/driver.*.ts` may import `expo-sqlite` at runtime.** This is what keeps
   the whole data layer testable in plain Node.
   **Two documented exceptions**, enforced as an exact allowlist by
   `src/ui/audit/invariants.db.test.ts`: `db/backup/export.ts` and `db/backup/import.ts` need
   `serializeAsync` / `deserializeDatabaseAsync` / `backupDatabaseAsync`, which have no `Db`
   equivalent and which section 10 *requires*. The invariant's purpose survives because the logic is
   already extracted into `csv.ts`, `validate.ts` and `collect.ts`, all Node-tested; what remains in
   those two files is a thin platform shim. `import type` is fine anywhere — it is erased at compile
   time.
7. **Migrations are forward-only and additive.** Never `DROP TABLE`, `DROP COLUMN`, or `DELETE` in a
   migration. To retire a column, stop reading it.
8. **Negative on-hand is surfaced loudly, never clamped to zero.** A negative balance means a receipt
   wasn't logged — clamping destroys the exact drift signal the ledger exists to produce.

---

## 3. Locked product decisions

Confirmed with the user. Do not relitigate without asking.

| Decision | Choice |
| --- | --- |
| Platform | React Native, Expo SDK 57, real installable Android app |
| Storage | On-device SQLite is the **source of truth**. The app runs fully offline and needs no internet to use. Since 7 Sep 2026 it also replicates to a server — see section 10a |
| Dose entry captures | Vaccine + timestamp, batch/lot, child (**optional**), and the child's **age at that dose**, worked out from a date of birth saved once on the child (added 16 Oct 2026; see section 6), and **boy or girl**, also saved once on the child and optional (added 27 Oct 2026, for the Trends split) |
| Child identification | Saved patient list, type-ahead + inline quick-add |
| Child required? | **No — always skippable** |
| Multi-dose vials | Per-vaccine setting: `unit_mode` is `DOSE` or `VIAL` with `doses_per_vial` |
| Language | English only |
| Multiple staff | **No.** The doctor gives every dose herself, so per-entry attribution was a name to maintain and get wrong — one mistyped row stamped itself on every dose in the clinic. Removed 16 Sep 2026. The `staff` table and `staff_id` stay in the schema unread (invariant 7); nothing writes them |
| Government (UIP) stock | Tracked as a balance separate from privately purchased stock |
| Cost / billing / GST / accounting | **Out of scope** — user explicitly excluded it. One exception (27 Oct 2026, user's decision): a **selling price per dose** on each vaccine, so Trends can show a sales value. Still no billing, GST, invoices, payments or purchase cost |
| Local Android toolchain | **Not used.** Expo Go for dev, EAS cloud build for the APK |
| Updates | Over the air by default. The doctor agreed (16 Oct 2026) to install a new APK when an update cannot go over the air — always an in-place upgrade signed with the same keystore, never uninstall-then-install (section 16) |

### Explicitly out of scope for v1

The clinic confirmed it does **not** do these, so they are not modelled: patient-supplied vials
(parent buys the vaccine and brings it), outreach camps, inter-branch transfers, cold-chain excursion
events, lot quarantine, cost/GST fields, appointment scheduling, due-date reminders.

`stock_movements` nonetheless keeps a `stock_source` column defaulting to `CLINIC_STOCK`. It costs one
column and zero UI, and it means adding patient-supplied doses later is not a migration of the whole
ledger. Do not build UI for it.

---

## 4. Environment

Verified on this machine, not assumed:

| Fact | Value |
| --- | --- |
| Node / npm | `v25.6.1` / `11.9.0`. Node 25 ships built-in `node:sqlite` — the test strategy depends on it |
| Expo | `expo@57.0.20`, `expo-sqlite@57.0.2`, RN 0.86.x, React 19.2.x |
| `gh` | 2.97.0, authenticated as `yashlad1` (`repo`, `workflow`, `gist`, `read:org`) |
| Local Android SDK | Present but **incomplete and deliberately unused** — no `cmdline-tools`, no system images, no AVDs, so the emulator cannot run. No JDK 17/21 either |
| Jira | No CLI, no MCP server, no credentials — Jira tickets ship as an import CSV |

### Dev loop (no emulator, by design)

```sh
npx expo start                 # scan the QR with Expo Go on the real Android phone
npx expo start --web           # fast browser smoke loop for layout/contrast
npm test                       # Node tests, no device needed
```

`expo-sqlite` is included in Expo Go, so **no custom dev client is needed.** The only exception is
SQLCipher (encryption at rest), which needs a native build — deferred.

### Release loop

```sh
eas build -p android --profile production   # APK, built in Expo's cloud
adb install -r clinic-stock.apk             # -r reinstalls IN PLACE, preserving the database
eas update --branch production               # JS-only fixes, incl. new migrations, ship OTA
```

**Keystore warning — treat as a data-integrity requirement.** A sideloaded APK can only be upgraded
in place if signed with the same key. If EAS's keystore is lost or rotated, the doctor must
*uninstall* to update, **and uninstalling deletes the database.** On day one run `eas credentials`,
download the keystore and password, archive them durably. Never change `android.package`.

---

## 5. Stack and dependency policy

**In:** `expo` 57, `expo-router` (file-based, `experiments.typedRoutes`), TypeScript, `expo-sqlite`
with **raw SQL behind a thin typed driver**, `expo-file-system`, `expo-sharing`,
`expo-document-picker`, `expo-haptics`, `expo-crypto` (`Crypto.randomUUID()`), `expo-updates`,
`fflate`, `jest` + `jest-expo`.

**Out, with reasons — do not add these:**

| Rejected | Why |
| --- | --- |
| `drizzle-orm` / `drizzle-kit` | Open migration bugs specific to Expo Go (drizzle-orm #4617 "Missing migration", #2384 crash with >1 migration). Migration is the one subsystem that must never fail on a phone holding the only copy of clinic data. Six tables don't earn an ORM |
| `nativewind` | Adds a Babel + Metro layer that breaks on SDK upgrades; an explicit type scale is easier to enforce for accessibility than utility classes |
| `zustand` / `@tanstack/react-query` | SQLite *is* the state. A ~20-line revision-counter context is enough |
| `uuid` / `nanoid` | `expo-crypto` needs no `getRandomValues` polyfill |
| `better-sqlite3` | Node 25 has built-in `node:sqlite` |
| `papaparse` | We generate CSV and never parse it (restore uses the `.db`). A 15-line `toCsv()` wins |
| Dark mode / theming libs | Clinics are bright. One palette is one palette to get contrast right in. The user asked explicitly to keep the UI minimal — no dark mode, no theming |
| `@react-navigation/material-top-tabs` + `react-native-pager-view` | Two native dependencies for a five-item segmented control. `src/ui/top-tabs.tsx` is ~120 lines and enforces the 56dp targets and per-tab accent directly |

---

## 6. Data layer

### The `Db` driver interface — the highest-leverage code in the project

```ts
// src/db/driver.ts
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}
```

Two adapters: `driver.expo.ts` (the device, and the browser smoke loop through expo-sqlite's wasm
build) and `driver.node.ts` (`node:sqlite`, tests). Every repository function takes `Db` as its first
argument.

**Trap:** `withExclusiveTransactionAsync` hands you a `txn` object and queries **must** run on it.
Using the outer `db` inside the callback deadlocks or silently escapes the transaction. The adapter
threads `txn` through.

### Migration rules

`PRAGMA user_version` is the single source of truth.

1. **Bump `user_version` inside the same transaction as the DDL.** It lives in the DB header and is
   transactional, so a crash mid-migration rolls back schema *and* version atomically. Bumping after
   the transaction is how you get a DB claiming v3 with a v2 schema.
2. **Additive only** — `CREATE TABLE/INDEX/VIEW`, `ALTER TABLE … ADD COLUMN … DEFAULT`, backfills.
3. **Snapshot before any migration runs** — `serializeAsync()` to
   `Paths.document/backups/premigration-v{from}-to-v{to}-{ts}.db`, keep 5.
4. **Downgrade guard** — if `user_version > LATEST_VERSION`, the app is older than the data (usually
   a rolled-back OTA). Do not open for writing; show "This version of the app is older than your
   saved data. Please update."
5. `PRAGMA journal_mode = WAL` runs **outside** any transaction. `PRAGMA foreign_keys = ON` is
   per-connection — set it on **every** open.
6. **Every migration gets a test**: build v(N−1) with seeded rows, run the chain, assert row counts
   are preserved and new columns exist.

### Schema

Every table carries `id TEXT PRIMARY KEY` (UUID), `created_at`, `updated_at`, `deleted_at` (soft
delete), `device_id`. The rule for what to include now: **add what cannot be backfilled, defer what
can.** Identity, origin and write time are unrecoverable retroactively; sync columns (`dirty`,
`last_synced_at`) are a trivial `ADD COLUMN` later, so they are not pre-added.

```
vaccines          id, name (trade name), generic_name?, aliases (JSON, search only),
                  unit_mode ('DOSE'|'VIAL'), doses_per_vial, min_balance_doses,
                  is_active, sort_hint
lots              id, vaccine_id FK, lot_number, expiry_date?,
                  funding_source ('PRIVATE'|'GOVT_UIP')
                  UNIQUE(vaccine_id, lot_number, funding_source)
patients          id, name, dob?, guardian_phone?, sex? ('M'|'F', v4)
staff             id, name, is_active            ← retired 16 Sep 2026, never read or written
stock_movements   id, idempotency_key UNIQUE, vaccine_id FK, lot_id FK?,
                  delta_doses (CHECK <> 0), movement_type, wastage_reason?,
                  stock_source DEFAULT 'CLINIC_STOCK',
                  patient_id FK?, patient_label?, staff_id FK? (retired, always NULL),
                  occurred_at, local_date (INDEXED), local_time, tz_offset_minutes,
                  recorded_at, reverses_id FK? UNIQUE, note?, needs_detail
settings          key PK, value
```

`movement_type` ∈ `OPENING_BALANCE`, `RECEIPT`, `ADMINISTRATION`, `WASTAGE`, `ADJUSTMENT`, `REVERSAL`,
with a `CHECK` that the sign of `delta_doses` matches the type. `UNIQUE(reverses_id)` means a
movement can be reversed at most once. A `REVERSAL` may not itself be reversed — to undo an undo,
write a fresh forward movement.

### Four modelling decisions worth remembering

- **Age is derived, never stored.** The dose screen saves a date of birth once on `patients.dob`
  (a column since v1), and every dose's age is `formatAge(dob, local_date)` in `domain/time.ts`:
  weeks under six months, months under two years, then years and months (`11 w`, `4 y 8 m`) — the
  same rule and format as clinic-queue, so the doctor reads one format in both apps. So it cost no
  migration and no server column, a returning child's age fills itself in, and a corrected date of
  birth corrects every past dose's age, which is right: the old age was wrong too. No date of birth
  is a blank, never `0 w`.

- **`local_date` / `local_time` are computed and stored at write time**, alongside UTC `occurred_at`.
  "Given today" is then an indexed `WHERE local_date = ?` — deterministic and unit-testable.
  `date('now','localtime')` at query time depends on the device's *current* timezone and cannot be
  tested in CI.
- **Expiry is stored as the LAST day of the printed month.** Vials print `MM/YYYY` and are usable
  *through* that month. Storing `2027-03-01` writes off a whole lot 30 days early, every time.
- **`patient_label` is denormalised onto the movement row** — the name exactly as typed at that
  moment. Renaming or merging a patient later must never rewrite an append-only ledger.

### Derived reads

```sql
CREATE VIEW v_movement_effective AS
SELECT m.* FROM stock_movements m
WHERE m.movement_type <> 'REVERSAL'
  AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id);
```

**The subtlety most likely to become a reporting bug:** for *balances*, sum the raw table — reversals
cancel arithmetically, which is the whole reason reversing entries are the right design. For
*activity counts* ("doses given today"), you **must** use `v_movement_effective`, or "3 given, 1
undone" renders as 3.

### Idempotency

`idempotency_key` is generated **at the moment of the user's tap**, not at write time:
`sha256(device_id || client_action_id)`. Writes are `INSERT … ON CONFLICT(idempotency_key) DO
NOTHING`. A retried write, a killed app replaying its queue, a double-submit — all become no-ops that
look like success.

Accidental double-*tap* is handled separately and **softly**: if the same
`(vaccine_id, movement_type, delta_doses)` arrives within 45s, do **not** block it — show a
non-modal nudge, *"BCG 1 dose recorded 20s ago. Another child?"* → `[Yes, different child]` /
`[No — undo that]`. Legitimate rapid repeats are common (siblings, twins, a queue of infants at the
same schedule point), and a hard dedupe window silently *loses* administrations. Under-recording is
worse than double-recording, because double-recording is visible at reconciliation while
under-recording just looks like theft.

---

## 7. Screens

**Home is the dose-entry screen, not a dashboard.** Any design where the doctor lands on summary
tiles and then taps "Give dose" has already lost.

**Five tabs, at the TOP of the screen**, each owning an accent colour (Trends added 27 Oct 2026,
at the user's request, as its own tab rather than a row under More):

```
app/
  _layout.tsx              SQLiteProvider + migration gate (holds splash)
  (tabs)/_layout.tsx       tabBarPosition: 'top' + the custom TopTabBar
  (tabs)/index.tsx         ► GIVE DOSE   blue    ← launch destination
  (tabs)/stock.tsx         ► ADD STOCK   teal    (deliveries + current position)
  (tabs)/vaccines.tsx      ► VACCINES    violet  (add new, remove old, edit)
  (tabs)/trends.tsx        ► TRENDS      pink    (read-only: doses by week/month, ages, boys/girls)
  (tabs)/more.tsx          ► MORE        slate   (everything infrequent)
  dose/[vaccineId].tsx     full-screen modal — dose entry
  receive/[vaccineId].tsx  full-screen modal — log a delivery
  catalog/new.tsx          full-screen modal — add a vaccine
  catalog/[id].tsx         edit a vaccine
  reports/today.tsx  children/  ledger/  backup/  settings/
```

**The per-tab accent is a safety feature, not styling.** Give dose and Add stock are adjacent and
move the ledger in OPPOSITE directions, so each owns a hue that carries through to the screen
heading and the primary button on it (`Give n doses` in blue, `Add to stock` in teal). A wrong tab
looks wrong before anything is written. Status colours — amber/red/green — are reserved for stock
levels and are never reused as a context accent.

The top bar is hand-written (`src/ui/top-tabs.tsx`) rather than pulling in
`@react-navigation/material-top-tabs` + `react-native-pager-view`: two native dependencies for a
five-item segmented control is a bad trade. It scrolls horizontally so it degrades gracefully at
font scale 1.6× instead of clipping the last tab. With five tabs it scrolls at normal font size too
(More is off-screen on a 360dp phone at launch), and the selected tab is always scrolled into view.
The user chose that over smaller tabs (27 Oct 2026); do not shrink tab padding to make five fit.

Nothing nested deeper than two levels.

**Give Dose:** a one-line 18pt status strip (`Tue 27 Oct · 5 doses today`, flags `4 OUT · 9 LOW`
beside it) → search field (**not** autofocused; the keyboard must not cover the grid on arrival;
cleared when a tile is tapped) → a grid of large tiles for the vaccines **in use** (given in the last
30 days, or below zero), then one-tap chips under `Not given in the last 30 days` for the rest. Each
tile: trade name 22pt semibold, stock beneath it **in doses only** (`18 doses`), amber `LOW` pill at
or below `min_balance_doses`. Ordered by 30-day usage **up to yesterday**, so the grid holds still
all day, then alphabetical. The OUT/LOW flags count only vaccines in use: on 27 Oct, 12 of 16 OUT
had not been given in 30 days, and a badge that is mostly noise gets ignored. CHECK always counts.

**Doses are the only unit shown anywhere.** `describeStock` still returns a `secondary` vial
breakdown (`2 vials + 7 doses`), but no screen renders it — the user asked for it removed, on the
grounds that it reads like the app is thinking out loud. Invariant 4 is unaffected: the app still does
every vial→dose conversion internally and still reports the *result* in doses, which is what "the
clinician never does arithmetic" actually requires. The intermediate `= 30 doses` line under the
receive stepper is gone for the same reason. Do not reintroduce either without asking.

That grid is the design's best trick: **two of the three requested reports are ambient on the home
screen.** The doctor never navigates to read remaining stock.

**Dose modal:** header `Give Rotavac` (the confirmation stays visible while she types), the name
large at top with its stock and LOW/OUT/CHECK word beside it and any below-zero warning right
under · batch: one line when there is one, chips with the most-recently-used preselected when there
are more, the earliest expiry marked `use first` · child: search + `Given a dose today` chips (at
most 3, today only, each with the age) + `Skip, no name` until a name is typed · then, once a name
is chosen or typed, optional rows: the date-of-birth wheel (or the age with `Change date of
birth`), `Boy` / `Girl`, `Which dose` (`1st` `2nd` `3rd` `Booster`, saved in the dose's `note`),
and `Also giving now` (the vaccines most often given with this one to the same child on the same
day; each becomes its own dose with its usual batch, one toast and one Undo for all) · dose stepper
defaulting to 1 · 64dp `Give 1 dose` button in the thumb zone.

A typed name with a date of birth, a sex or a dose number is saved as a child on Give, because she
types almost every name (198 of 204 doses on the server, 20 Oct 2026, and not one linked to a saved
child). She also typed the dose number into names (25 of 33 saved children, 27 Oct), so a trailing
`1 Dose` / `2nd dose` / `Bd` / `Booster` is stripped from the saved child's name (`stripDoseToken`)
and preselects the chip; `patient_label` still keeps exactly what was typed.

**Target: launch → tile → child chip → GIVE = 3 taps. Skipping the child = 2.**

---

## 8. UI rules

The user is a practising pediatrician, likely 50+, one-handed, between patients, coming from paper.
These are requirements, not preferences.

- **56×56dp minimum** touch targets (Android's guideline is 48 — go bigger). Primary CTAs 64dp tall,
  full width, in the bottom third. Portrait locked.
- **Tablets: bound the text, not the grid.** The type scale was chosen for a ~400dp phone; nothing
  about it is wrong on a tablet, but the *container* is — an 18pt line across 800dp is a long measure,
  and a full-width input for a six-character batch number looks broken. So text, forms, lists and the
  `Footer` are capped at `CONTENT_MAX` (560) and centred (`centred` in `src/ui/layout.ts`).
  **The vaccine grid is deliberately NOT capped.** Capping it made tiles *shrink* as the screen grew
  (123dp on a 10-inch tablet, against 184dp on a phone). Instead `useColumns()` adds columns —
  2 on a phone, 3–4 on a tablet, 6 in landscape — holding the tile at 158–198dp everywhere. A tile
  twice the size is not twice as easy to hit; it just pushes the rest of the grid off screen, and the
  grid being scannable at a glance is the whole point of the home screen.
  `FlatList` must be re-keyed on the column count or a rotation keeps the old layout.
- **Never position anything at `bottom: 0` directly.** Android's three-button navigation bar overlays
  it, and because every primary CTA lives in the bottom third by the rule above, the button is not
  merely clipped — it is *untappable*. Use `Footer` from `src/ui/components.tsx`, which adds
  `useSafeAreaInsets().bottom`; scrolling screens add `useBottomInset()` to their `paddingBottom`.
  This is not cosmetic: it is how "ADD A NEW VACCINE" spent a release looking like a feature that had
  never been built.
- **No icon-only controls** outside the tab bar. Every button gets a word — icons are ambiguous to
  someone coming from paper.
- Type scale: numbers that matter **28–34pt bold**, tile titles **22pt semibold**, body **18pt**,
  labels 16pt, **floor 14pt**. Body `#0F172A` on `#FFFFFF`
  (**17.9:1 measured**, 16.7:1 on the `#F6F8F7` ground). No grey below `#46586F` (**7.3:1
  measured**) for text, no thin weights.
  These are no longer hand-written guesses — `src/ui/audit/contrast.db.test.ts` computes every
  pairing on BOTH grounds and fails below 4.5:1 (3:1 for a control's edge). The tightest text
  pairings measure **4.7:1** (`ok` and `low` on the ground); change a soft tint only with the test
  open.
- **Dimensions do not change** (owner, 17 Oct 2026: "what we were using before was working
  perfectly fine for doc"). Sizes, radii (`10/14/20/28`), font weights (700 included), letter
  spacing, padding, margins, border boxes, row widths and the 0.985 press scale are the ones the
  doctor has used since launch. A restyle may change colour and wording only. Where a new outline
  was added, it sits inside the old box and the padding gives its pixel back, so nothing moves.
  **Four approved exceptions (user, 27 Oct 2026), from a design review:** banner buttons rise
  from 44 to the 56dp floor; the undo toast may run to 3 lines; the Home header puts the
  OUT/LOW badges under the dose count instead of beside it; and the dose screen gains optional
  dose-number chips. Each exception is limited to exactly that change. The rule still stands for
  everything else.
  **Density on Add stock, Vaccines and Trends (user, 27 Oct 2026: "too cluttered and has too much
  white space"):** height follows what a row is. A row she taps keeps the 56dp floor; a line she
  only reads sits at its text height (`Row dense`, a non-pressable `BarRow`). An empty answer
  collapses to one sentence rather than rows of zeros. The type scale is unchanged. The same day
  the user extended it to the dose modal ("even more shit": every field on it is optional, so the
  gaps between them were the clutter; `Field dense`), and approved for Give dose a one-line 18pt
  status strip and compact chips for vaccines not given in 30 days. Tile size, the 64dp Give
  button and the 56dp floor are unchanged.
- **The look is clinic-queue's colours and words** (16 Oct 2026, replacing the Aero Clinic palette
  of 17 Sep), so the doctor's two apps read as one family. The source is `clinic-queue/docs/context/design/`. What came
  across: white surfaces on a soft `#F6F8F7` ground; cards and tiles with one hairline `border` edge
  and no shadow; `borderControl` (`#64748B`, 4.8:1) as the edge of every input, chip, stepper and
  secondary button, because the decorative `border` (1.2:1) may never be the only edge of a control;
  sentence case, verb first; no em dashes in rendered text; badges as a soft ground with a darker
  ink. What did **not**, on purpose: any of its sizes — 44px targets, 14–16px body, radius 8/12,
  weights 400/600 only, its 0.97 press (see the rule above); its `text-muted` as text (it fails the grey floor, so it is only ever an edge); its
  faded disabled primary (about 2:1 — disabled stays a readable token swap); its single teal primary
  (the four per-tab accents stay, and **Give dose stays blue, Add stock stays teal**: swapping them to
  give Give dose the teal would point the doctor's learned colour at the wrong tab); and Mukta, which
  clinic-queue ships only as `.woff2` for Devanagari — Android cannot load it, and this app is
  English only.
- Semantic colours, all ≥4.5:1 on both grounds: green `#15803D` ok, amber `#B45309` low, red
  `#B91C1C` out/expired (clinic-queue's success, warning, danger). **Never encode state by colour alone** — always colour **plus a word** ("LOW",
  "OUT", "CHECK"). ~8% of men are red-green colourblind and a bright clinic window destroys colour
  discrimination anyway.
- **Minimal, not decorated.** Structure comes from white surfaces, hairline edges and tints; the one
  shadow is the floating footer's (`elevation()` in `tokens.ts`). No gradients, no dark mode, no
  animation beyond the toast fade and a slight press scale. "Modern" must never mean thin,
  small or low-contrast.
- **Must be tested at Android font scale 1.3× and 1.6×** plus display size Large. This cohort very
  likely has both turned up; it is the most-skipped check and the most likely to bite here.
- **Expiry is a month/year wheel** (`src/ui/wheel.tsx`), not chips and not a text field — twelve
  month chips plus four year chips wrapped into an unreadable block. The first row of each wheel is
  `—`, meaning *not set*: a wheel always shows something under the selection band, so one that
  started on a real month would silently claim an expiry nobody entered, and expiry is optional.
  Hand-written for the same reason as the top tabs: `@react-native-picker/picker` is a native
  dependency, so it breaks Expo Go and rotates the OTA fingerprint. The resolved last usable day is
  spelled out beneath it (`Usable through 31 Mar 2028`), which is the visible half of the
  last-day-of-month rule in `domain/time.ts`.
- **Steppers, not keyboards**, for any value ≤20 (long-press to repeat; `10/20/50` quick chips when
  receiving). The reason is correctness, not comfort: *a stepper cannot produce 100 when you meant
  10*, and in a derived-stock ledger that typo is silent corruption surfacing weeks later.
- **Zero confirmation dialogs on the dose path.** Confirm only on genuine ambiguity: quantity > 1,
  backdating, resulting balance negative, expired lot, more than one open lot. A confirm dialog on
  the common path trains people to tap through confirms, which destroys its value on the rare path.
- **Undo replaces confirmation.** A **3.5s** snackbar at the bottom of the screen, large hit area,
  success haptic (she is often not looking at the screen when her thumb lands). Kept deliberately
  brief so it is not sitting over the grid while she moves to the next child. The cost of brevity is
  low, because undo **writes a reversing entry** rather than deleting — so the same correction stays
  available indefinitely from the All-entries screen, and the same code path serves a correction made
  three weeks later. The toast is only the fast path.
- **Show the consequence, not just the action.** The tile's stock number decrements immediately, so
  physical reality gets verified dozens of times a day instead of once at month-end. Highest-value
  single UI behaviour in the app.
- Skipping the child writes `patient_id NULL, needs_detail = 1`; a card on More reads *"3 entries
  missing child name"* for day-end completion.
- `autoCorrect={false}` + `autoCapitalize="words"` on names (autocorrect mangles Indian names);
  `autoCapitalize="characters"` + `autoCorrect={false}` on lot numbers.

---

## 9. The three required reports

| Asked for | Delivered as |
| --- | --- |
| "Vaccine stock, names, unique values" | `SUM(delta_doses) GROUP BY vaccine_id` — ambient on the Stock tab. Uniqueness is structural: one catalog row, so a vaccine *cannot* appear twice |
| "Vaccines given today, time, count" | Line items from `v_movement_effective WHERE local_date = today` — time, vaccine, lot, child — plus per-vaccine totals |
| "Vaccines remaining today, time, count" | Primary number is **on-hand right now**, stamped `as of 14:32`. Directly beneath it, a self-checking movement strip: `Opening 30 · +Received 20 · −Given 7 · −Wasted 3 · = Now 40` |

That strip is the point. "Remaining today" is genuinely ambiguous — on-hand now vs. opening minus
given — and showing both derivations reconciling on one line is exactly what the paper notebook was
trying to be. Every report renders its `as_of` time; **a stock number without an as-of is a rumour.**

### Trends (added 27 Oct 2026)

The Trends tab: doses per week or per month (last 12 of each), most-given vaccines, age bands and
boys/girls for the chosen period. Tapping a period or a vaccine narrows the rest. Rules:

- **Money is a sales value, not accounts.** Each vaccine has an optional selling price per dose in
  whole rupees (`vaccines.price_rupees`, m005). Each dose stamps the price at the moment it is given
  (`stock_movements.price_rupees`, immutable like the arithmetic), so editing a price never re-prices
  the past. Doses from before m005 have no stamp and are valued at today's price. Government (UIP)
  doses are worth ₹0. A dose of a vaccine with no price is shown as `Price not set`, never as ₹0.
- Activity, so `v_movement_effective`. One query for the window (`dosesSince`), then pure functions
  in `domain/insights.ts`, so a tap re-tallies without a query and the arithmetic is Node-tested.
- Age and sex come from the saved child. A typed-only name has neither, and `Not recorded` is shown
  as its own bar, never dropped: hiding it would make 6 known children look like the whole clinic.
- Bars are plain `View`s. No pie charts: they need `react-native-svg`, a native dependency and a
  new APK, for a share that a bar with a percent already shows.
- **The server column ships first.** `patients.sex` is pushed like every other column, and PostgREST
  rejects an unknown one with a 400. Patients push before `stock_movements`, so doses would stop
  uploading. Run `supabase/add-trends-columns.sql` on Supabase **before** the OTA.
- Each period also shows a comparison with the previous one **over the same number of days**
  (comparing "80 so far" with a whole month of 200 reads as a crash), the handbook's monthly strip
  (`Start · +Received · −Given · −Wasted · = End`), and which vaccines ran out and for how many days.
  Percents appear only for groups of 20 doses or more; "67%" over 3 doses misleads.
- Comparisons are neutral ink with no arrows. More doses is neither good nor bad, and red means OUT.

### Supply answers on Add stock (added 27 Oct 2026)

From research into how vaccine supply systems (India's UIP handbook, eVIN, mSupply) and pharmacy
apps present stock. `domain/supply.ts` answers the three questions she actually asks:

| Question | Shown as | Rule |
| --- | --- | --- |
| When will I run out? | `Lasts about 3 weeks` on each row | On hand ÷ doses per **in-stock** day over the last 8 weeks. Days out of stock are not days of zero demand (adjusted consumption). Under 4 doses in the window: `Not used enough to tell` |
| What should I order? | `Order this week`: `Rotavac: order about 14 doses` | When ≤ safety limit or under 2 weeks left: 4 weeks of use − on hand, whole vials for vial-mode. The UIP indent rule. Below zero gets `Check deliveries first`, never a number |
| What will expire on me? | `Use soon`: batches expiring within 60 days, with `About 3 may not be used in time` | First expiry used first, so a later batch only counts once earlier ones are gone |

In weeks and words, never decimal "months of stock": she restocks weekly. Deliberately not built:
a clinic-vs-government split and a wastage count (on 27 Oct every batch was clinic stock and no
wastage had ever been logged, so both would read 100% and 0), forecast lines, configurable reorder
rules, and colour-only heat maps.

---

## 10. Backup and restore

One tap produces `clinic-backup-YYYY-MM-DD-HHMM.zip`:

```
clinic.db             ← authoritative, the only thing that restores losslessly
manifest.json         ← schema_version, app_version, device_id, exported_at, row counts
doses.csv             ← date, time, vaccine, batch, child, doses  (the one she'll actually open)
stock_movements.csv   vaccines.csv   patients.csv
```

Ship both formats — don't make the doctor choose. A raw `.db` feels like nothing happened; CSV alone
can't restore ledger integrity (reversal links, UUIDs, soft deletes). ~50KB for a year; sends fine
over WhatsApp.

**Use `db.serializeAsync()`, never a raw file copy.** Under `journal_mode = WAL` recent commits live
in `clinic.db-wal`, not `clinic.db`. Copying only the `.db` yields a silently stale, sometimes
unopenable backup. This is the most common way homegrown SQLite backup gets quietly broken.

**Restore validates before committing.** `deserializeDatabaseAsync` returns an *in-memory* database,
so the candidate is fully inspected before a byte touches the live file. The confirmation therefore
shows real numbers:

> **Restore from backup?**
> This backup: **412 doses**, 26 vaccines, latest entry **4 Sep 2026, 6:12 pm**
> Your phone now: **380 doses**, latest entry **6 Sep 2026, 11:04 am**
> Restoring replaces everything on this phone. A copy of your current data will be saved first.

Reject with a **specific** message on: not a zip · no `clinic.db` inside · `user_version` newer than
the app · missing tables · row counts contradicting the manifest.

**Nagging:** amber banner on Home at >3 days **or** ≥25 doses since last backup; red at 14 days;
always non-modal, never blocking. The count trigger matters as much as the time one — a busy
immunisation morning is exactly when 40 unbacked entries sit on one phone. Plus a silent daily
on-device snapshot (keep 7) and a permanent "Last backup: 4 Sep, 6:30 pm" line on More, so she can
always answer "am I safe?" without tapping.

**Encryption:** child health data. For v1, Android app-private storage plus the device lock screen is
the real control; SQLCipher would mean abandoning Expo Go. Onboarding must state the phone needs a
screen lock. An in-app PIN gate is a cheap JS-only addition later.

---

## 10a. Server backup (added 7 Sep 2026)

The user asked for backend storage rather than phone-only. Provider: **Supabase**
(Postgres, `ap-south-1` Mumbai, so children's data stays in India). Accessed over plain `fetch`
against PostgREST — **no `@supabase/supabase-js`**, for the same reason the top tabs and the expiry
wheel are hand-written: it would be one more dependency to carry, it rotates the OTA fingerprint on
every upgrade, and we use four endpoints.

### The invariant that must not be traded away

**SQLite remains the source of truth, and no write ever waits on a network.** Invariant 5 is
unchanged: recording a dose must never be blocked. Sync is a background push that cannot fail the
user — it never blocks, never opens a dialog, and never reports its own failures as errors, because
a failed sync is not a failed dose. Status lives quietly on More.

It runs on four triggers: **4s after any write**, **on return to the foreground**, **on going to
the background** (best-effort — it shrinks the window where the day's last doses sit on the phone
until someone next opens the app, which is exactly when she is at home wondering why the evening is
missing), and a **15-minute heartbeat** while the app is open. The heartbeat exists for the case the other two miss —
the app left open on a clinic counter while entries go in on the *other* device — where the screen
would otherwise drift out of date while looking authoritative. It only fires in the foreground; an
Android background timer is not a guarantee worth pretending to have. `syncNow` refuses to run
concurrently with itself, so overlapping triggers are no-ops rather than duplicate uploads.

**Nobody has to find a button.** Uploading is automatic; the failure worth designing for was the
*silent* one — sync quietly broken for hours while the only indication sat on the More tab, which
nobody opens mid-clinic. So `SyncBanner` on the dose screen says so unprompted, driven by
`domain/sync-nag.ts`.

It is **deliberately silent in ordinary use**: nothing below 30 minutes behind and 20 pending, because
an indicator that appears for four seconds after every dose is noise, and noise is how a real warning
gets trained into invisibility. At four hours it escalates to red. Every message states that the data
is **still safe on this phone**, because this is a delivery delay and must never read as data loss.

**More** also carries an explicit `Upload now`, one tap deep. It is not needed for correctness, but
"did it actually go?" is a fair thing to want settled before leaving the clinic, and it pulls before
pushing so it takes in the other device's entries too.

### Push-only, deliberately

Chosen over bidirectional sync because it removes conflict resolution from the design entirely — the
class of bug that would be hardest to notice and worst to have in a stock ledger. One phone writes;
the server is a live replica.

This is nearly free here because of decisions already made: `stock_movements` is append-only with
client-generated UUIDs, so replication is "push rows the server doesn't have", and derived stock is
recomputed rather than transferred, so any device that has the ledger computes the same numbers.

| Rule | Why |
| --- | --- |
| Tables push in `PUSH_ORDER` (FK order) | A half-uploaded phone still leaves a readable clinic record. Lives in `m002_sync.ts` because it is a property of the schema, not the transport |
| `dirty` clears only *after* the server acknowledges | The failure mode becomes "uploaded twice" (a no-op, keyed by row id) and never "believed uploaded but wasn't" |
| Re-dirtying is a **DB trigger**, not a call-site edit | Same reasoning as the immutability triggers. It fires on `updated_at` changing, so it cannot fight sync's own mark-uploaded write — a recursion that would mean the queue never drains |
| `settings` is **not** replicated | It holds `device_id` and the server credentials. Replicating it would overwrite one phone's identity with another's |
| `dirty`/`last_synced_at` are stripped before upload | They are this phone's bookkeeping, not clinic data |
| `stock_movements` has **no UPDATE or DELETE policy** server-side | With RLS on, a missing policy is a denial. This is the server's half of invariant 1 |

### Restore

`restore.ts` is what makes the backend worth having — replication without a restore path is theatre.
It restores in write order so a `REVERSAL` lands after the movement it reverses, satisfying the
self-referencing FK without deferring constraints. It is `INSERT OR IGNORE`, so it is safe to run
twice and never overwrites what the phone already has.

### Credentials

Live in the local `settings` table, entered once per phone on the Server backup screen. **Never in
`app.json` or any committed file** — the repo is public (section 13), and although a Supabase
publishable key is designed to be exposed (RLS is the real guard), publishing a specific clinic's key
is a standing invitation to probe it.

### The server schema is generated, not hand-written

`node scripts/supabase-schema.ts > supabase/schema.sql` derives the Postgres DDL from the live SQLite schema
via `PRAGMA table_info`. Hand-typing it is the obvious approach and the wrong one: PostgREST rejects
an unknown column with a 400, so one missed column silently breaks every push of that table. Re-run
it after any future migration.

**Invoke it as `node`, never as a new npm script.** `packageJson:scripts` is an EAS fingerprint
source, so adding an alias rotates the OTA `runtimeVersion` and cuts every installed phone off from
updates until a new APK is sideloaded onto a device holding live clinic data. Adding a
`supabase:schema` alias did exactly that — `fa84bf12` → `db41047e` — the **third** time this project
has been caught by it, after an earlier npm alias and a `web/config.js` gitignore line. `.gitignore`
is a fingerprint source too. Before publishing any update, check
`eas fingerprint:generate --platform android --environment production` against the installed build's
`runtimeVersion`; a mismatch is not an error on the phone, it is silence.

### This does not replace the zip backup

Both stay. A zip the clinician holds herself is the only copy that does not depend on an account
still working, a card not expiring, or a free tier not changing. The backup nag is unchanged.

### Copies of the server, with nobody at the clinic doing anything (added 27 Oct 2026)

The user's rule: **no backup step may be left to the staff, and no paid Supabase plan.** So the server
is copied by machines, not people:

| Copy | When | Where |
| --- | --- | --- |
| The phone (and any second device, which pulls everything) | live | the clinic |
| Supabase | about 4s after each entry, when online | Mumbai, free tier |
| **GitHub Actions job** | **08:00, 13:00, 18:00, 23:00 IST** | private repo `yashlad1/clinic-stock-backups`, one `YYYY/MM/clinic-…zip.age` per run |
| Mac nightly (launchd) | 23:59 IST, when the Mac is on | `backups/` here (gitignored) |

The job runs this repo's `scripts/backup-from-server.ts` from `main` (read-only, with the app's own
restore check), encrypts the zip with `age` to the public key in that repo's `recipients.txt`, and
commits it. The private key is `~/clinic-stock-keystore/backup-age-key.txt` on the owner's Mac;
without it the files cannot be opened, so keep a copy in a password manager. It also **fails, and
GitHub emails the owner, when no new entry has reached the server in 3 days**: a phone that has
quietly stopped syncing is the failure no person would notice. Its runs keep the free Supabase
project active, too. Secrets `SYNC_URL/KEY/EMAIL/PASSWORD` mirror the EAS `EXPO_PUBLIC_SYNC_*`
values; rotate them together. Restore: `age -d -i <key> file.zip.age > backup.zip`, which the app's
Restore screen accepts.

Because the job runs `main`'s copy of the script, **a new migration must be on GitHub's `main`
before the next run**, or the backup restores server rows into an older schema and silently drops
the new columns.

What no copy can hold: entries a phone made offline and never uploaded. The sync banner warns
after 30 minutes behind.

---

## 11. Testing

Three layers, cheapest first. A and B need no phone; **C is the only one that proves anything.**

**Layer A — ledger logic in plain Node.** `node:sqlite` via `driver.node.ts`. Jest projects: `db`
(node) and `ui` (`jest-expo`). Suppress the experimental warning with
`NODE_OPTIONS=--disable-warning=ExperimentalWarning`. Tests that earn their keep:

1. on-hand = Σ receipts − Σ administrations − Σ reversals
2. vial accounting — 3 from a 10-dose vial leaves 7; the 11th dose opens a second vial
3. reversal restores stock **exactly**, and the original row still exists afterwards
4. `local_date` doesn't shift at midnight IST, nor when the device timezone changes after the write
5. low-stock fires at `on_hand <= min_balance`, not `<` — off-by-one here means a silent stock-out
6. the full migration chain preserves every pre-existing row
7. restore rejects a truncated `.db`, a zip with no `clinic.db`, and a future `user_version`
8. CSV round-trips embedded commas and an apostrophe in a trade name
9. property test: 500 random movement sequences, derived on-hand equals a naive replay

**Layer B — browser smoke loop.** `npx expo start --web` runs expo-sqlite's wasm build through
`driver.expo.ts`, which uses a plain transaction there: exclusive transactions throw in the browser,
and until 16 Oct 2026 that stopped the loop at the first migration. Fast iteration on layout and
contrast; real DB behaviour is covered by Layer A. Driving it headless, one page holds the browser
database at a time, so go through `about:blank` between screens or the next one reports
"Cannot open clinic records". It cannot show Android font scale: that check stays on the phone.

**Layer C — the physical phone.** Expo Go + `npx expo start`, scan the QR. Full 20-step script in
`docs/test-plan.md`. Run the whole thing in **airplane mode**. The three steps people skip and that
matter most:

- **Backup actually arrives** — share to WhatsApp *and* Drive, then open `doses.csv` in Google Sheets
  on the phone. Attachment-type filtering is the most likely thing to break silently.
- **Restore actually works** — on a second device or after clearing app data. This validates the
  entire durability story.
- **Font scale 1.3× and 1.6×** — nothing clipped, nothing unreachable.

---

## 12. Seed catalog

`scripts/seed.ts` exports `SEED_VACCINES`, shared by tests and the app. Realistic Indian pediatric
catalog exercising both unit modes — vial-mode: BCG (10), OPV (20), MR (10), Tresivac/MMR (10), JE
(5), Td (10); dose-mode: Pentavac PFS, Hexaxim, Infanrix Hexa, Pentaxim, Easyfive-TT, Genevac-B, IPV,
Rotavac, Rotasiil, Rotarix, Prevenar 13, Pneumosil, Typbar-TCV, Varilrix, Havrix, Vaxigrip Tetra,
Menactra, Boostrix, Cervavac, Rabipur.

**Ship this as editable suggestions, not gospel.** Doses-per-vial varies by manufacturer and pack,
and getting it wrong corrupts the stock arithmetic. Onboarding must say: *"Check these numbers
against your fridge before you start."*

---

## 13. Repo hygiene

The GitHub repo is **public**. Nothing clinic-identifying or patient-related may ever be committed.
`.gitignore` must cover `*.db`, `*.db-wal`, `*.db-shm`, `backups/`, `*.zip`, `.env*`, `.idea/`.
Docs use a generic clinic name. The seed catalog is public information (trade names printed on
packaging), so it is safe to publish.

---

## 14. Documentation

| File | Contents |
| --- | --- |
| `docs/SRS.md` | IEEE-830 shaped; numbered `FR-*` / `NFR-*` requirements, each traceable to a use case and a test |
| `docs/ERD.md` | Mermaid `erDiagram` with types, constraints, indexes, derived views |
| `docs/waterfall.md` | Mermaid waterfall phase flowchart + Gantt timeline |
| `docs/test-plan.md` | Three test layers + the 20-step on-phone acceptance script |
| `docs/schema.sql` | Reference DDL for reviewers |
| `jira/backlog.csv` | Jira CSV import (Jira is not reachable from the dev environment) |

GitHub renders Mermaid natively, so no local diagram toolchain is needed (`mmdc` and `plantuml` are
absent, deliberately).

**A note kept honest in the docs:** *waterfall* and *sprints* are opposite methodologies — waterfall
is sequential phases with no sprints. Both are delivered because they answer different questions: the
waterfall diagrams document the SDLC as requested; the sprints are how work actually gets executed
and tracked. `docs/waterfall.md` says so in a sentence rather than pretending they're the same thing.

---

## 15. Build order

| Sprint | Contents |
| --- | --- |
| **0** | Docs, scaffold, repo, tickets |
| **1 — v0.1** | Migration v1, `Db` driver + adapters, seed catalog, Give Dose grid + dose modal + undo, Receive Stock, Stock tab with LOW badges, Given-today report, **backup export**, Layer-A tests. *Cut on purpose:* `patients` table (free-text `patient_label` + a `SELECT DISTINCT` recent list gives ~90% of the value, and promoting it later is purely additive), expiry/FEFO, restore, true open-vial tracking |
| **2** | EAS APK + **archive the keystore**, restore/import with preview, backup nag + daily snapshots, real `patients` table, lot chips from actual stock, staff list, `funding_source` split, `expo-updates` OTA |
| **3** | Per-lot expiry + FEFO suggestion (one-tap suggestion with a visible override, **never** a silent forced pick — the fridge may not match the app), true open-vial tracking with discard window + wastage reasons, history report + share-as-text, ledger/audit + corrections, **blind** stock-take reconciliation (do not show the expected number until after the count is entered — shown it first, a tired clinician types it), missing-child-name queue |
| **Backlog** | Due-date reminders (needs the IAP schedule — large, do last), multi-device merge (nearly free: `INSERT OR IGNORE` dedupes by UUID and derived stock is correct by construction), PIN lock, SQLCipher, iOS, cloud sync |

**The v0.1 argument, stated plainly:** the notebook already gives a permanent record. What it cannot
do without manual counting is **arithmetic** — remaining stock, low-stock warnings, today's total.
v0.1 wins by deriving all three automatically. Everything after that is polish on a product that
already earns its place.

---

## 16. The two ways this design loses all the data

Pinned here because everything else is secondary.

1. **Phone lost or broken with no recent backup** → since 7 Sep the server holds every uploaded
   entry, and a reinstalled or replacement phone pulls it all back by itself (pinned by
   `multidevice.db.test.ts`, "a phone reinstalled after an uninstall"). The server itself is copied
   4 times a day by a GitHub Actions job and nightly to the Mac (section 10a), with no step left to
   the staff. The nag, zip export, snapshots and "Last backup: …" line remain. A durable copy of the
   current APK lives in `backups/apk/`, because EAS deletes build files after about 30 days.
2. **Reinstall with a different signing key** → never rotate the EAS keystore, never change
   `android.package`, always `adb install -r`, prefer OTA updates so the APK rarely needs replacing,
   and always take a backup before any update.
