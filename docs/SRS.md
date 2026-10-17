# Software Requirements Specification
## Clinic Vaccine Stock Logger ("Clinic Stock")

| | |
| --- | --- |
| Version | 1.0 |
| Date | 6 September 2026 |
| Status | Approved for Sprint 1 |
| Standard | Structured after IEEE 830 |

---

## 1. Introduction

### 1.1 Purpose

This document specifies the requirements for **Clinic Stock**, an offline Android application that
replaces the paper vaccine-stock notebook used by a private pediatric clinic in India.

It is written for the developer implementing the system and for the clinician who will use it.
Every functional requirement is numbered (`FR-n`), every non-functional requirement (`NFR-n`), and
each is traceable to an automated test or a step in `docs/test-plan.md`.

### 1.2 Scope

The system records two events and derives everything else from them:

1. **Stock received** — vaccine deliveries, which arrive daily or weekly.
2. **Dose administered** — a vaccination given to a child, which reduces stock.

From those two events it produces the current stock position, low-stock warnings, and a daily
activity report.

**In scope:** a vaccine catalog with trade names; batch/lot tracking; per-vaccine vial-versus-dose
counting; an optional child register; separate balances for privately purchased and
government (UIP) stock; on-device storage; backup and restore.

**Out of scope, explicitly:** costing, billing, GST and any accounting or financial reporting;
electronic medical records; appointment scheduling; immunisation due-date reminders; cloud sync;
multi-clinic operation; patient-supplied vials; outreach camps; inter-branch transfers; cold-chain
excursion management. The clinic confirmed it does not perform the last three.

### 1.3 Definitions

| Term | Meaning |
| --- | --- |
| **Dose** | The atomic unit of the ledger. All stock arithmetic is in doses. |
| **Vial** | A physical container holding one or more doses. A packaging fact, not a ledger unit. |
| **Lot / batch** | A manufacturing batch, identified by a lot number and an expiry month. |
| **Movement** | One immutable row in the ledger: a signed change in doses, with a type and a time. |
| **Ledger** | `stock_movements`; the append-only single source of truth for stock. |
| **On-hand** | `SUM(delta_doses)`. Always derived, never stored. |
| **Reversal** | A movement that negates an earlier one. The only mechanism for undo or correction. |
| **Effective movement** | A movement that is neither a reversal nor has been reversed. Used for activity counts. |
| **Safety limit** | The clinician's "minimum balance to be maintained", per vaccine, in doses. |
| **UIP** | India's Universal Immunization Programme; the source of free government vaccine stock. |
| **IAP** | Indian Academy of Pediatrics, whose schedule informs the seeded catalog. |

### 1.4 Problem statement

The clinic currently writes stock into a paper notebook by hand. Two failure modes recur, and they
are the entire justification for this system:

| # | Failure | Consequence |
| --- | --- | --- |
| **P1** | The same vaccine is written several different ways. | The notebook no longer has one row per vaccine, so no total can be trusted. |
| **P2** | The wrong vaccine's count is reduced, or a reduction is applied twice, or missed. | Recorded stock silently drifts away from what is physically in the refrigerator. |

The clinician's own statement of the requirement:

> "Vaccine stock, time, names, unique values. Vaccines given today, time, count. Vaccines remaining
> today, time, count."
>
> "While writing the stock you can have features like trade name, present stock, min balance to be
> maintained / safety limit."

### 1.5 Success criterion

The system succeeds if recording a dose is **faster than writing it in the notebook**, and if
**P1 and P2 become structurally difficult rather than merely discouraged**. A system that is more
accurate but slower will be abandoned, and abandonment is the primary risk.

---

## 2. Overall description

### 2.1 Actors

| Actor | Description | Frequency of use |
| --- | --- | --- |
| **Clinician** | The pediatrician. Primary user. Likely 50+, working one-handed between patients, coming from pen and paper. | Many times daily |
| **Clinic staff** | A nurse or receptionist who also records doses. | Daily |
| **Administrator** | The same clinician, in a calmer moment, adjusting the catalog and safety limits. | Occasionally |

### 2.2 Operating environment

An Android phone, in a clinic, frequently with no usable internet. The application is installed as a
sideloaded APK, not from the Play Store. All data resides in the application's private storage on
that single device.

### 2.3 Assumptions and dependencies

| Ref | Assumption |
| --- | --- |
| A1 | One phone is the book of record. There is no server and no second authoritative device. |
| A2 | The phone has a screen lock. This is the actual access control for child health data. |
| A3 | The clinician will take backups when prompted. NFR-12 exists because this assumption is weak. |
| A4 | The seeded catalog's doses-per-vial values will be verified against real stock before first use. Pack sizes vary by manufacturer, and a wrong value corrupts all arithmetic for that vaccine. |
| A5 | The clinic timezone is Asia/Kolkata (UTC+05:30). |

### 2.4 Design constraints

| Ref | Constraint | Rationale |
| --- | --- | --- |
| C1 | The ledger is append-only. No `UPDATE` or `DELETE` of a movement's arithmetic, enforced by database triggers. | Enforcement in application code has a perfect record of eventually being bypassed. |
| C2 | On-hand stock is never a stored column. | A mutable `current_stock` integer is the paper notebook in a database; it is the artifact that drifts. |
| C3 | Vaccine identity is a foreign key, never a string. Catalog creation is unreachable from any entry screen. | If an entry screen can create a catalog row, free text has been re-invented with extra steps. |
| C4 | Only `src/db/driver.*.ts` may import `expo-sqlite`. | Keeps the whole data layer testable in plain Node with no device. |
| C5 | Migrations are forward-only and additive. | The phone holds the only copy of irreplaceable clinical data. |
| C6 | No local Android toolchain. Expo Go for development, EAS cloud build for the APK. | The build machine has no usable emulator and no JDK 17/21. |

---

## 3. Functional requirements

### 3.1 Vaccine catalog

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-1** | The system shall ship with a pre-loaded catalog of Indian pediatric vaccines, identified by the **trade name** printed on the vial. | `src/domain/seed.ts`; test-plan step 1 |
| **FR-2** | The system shall reject a second vaccine with a name already in use, so a vaccine cannot appear twice. **This eliminates P1 by construction.** | `schema.db.test.ts` — "rejects a duplicate vaccine name" |
| **FR-3** | Each catalog entry shall declare whether it is counted in **single doses** or in **vials of N doses**, and the system shall perform all vial-to-dose conversion itself. | `stock.db.test.ts` — vial arithmetic |
| **FR-4** | The system shall reject a single-dose entry that claims more than one dose per vial. | `schema.db.test.ts` |
| **FR-5** | Each catalog entry shall carry a **safety limit** in doses, editable by the clinician. | `catalog/[id].tsx`; `stock.db.test.ts` |
| **FR-6** | The clinician shall be able to edit any catalog entry, and to hide one without deleting it, so history keeps resolving. | `catalog/[id].tsx`; test-plan step 16 |
| **FR-7** | Vaccine search shall match trade name, generic name and aliases, so "penta", "dpt" and "easyfive" all find the right row. | `catalog.ts` `searchVaccines` |
| **FR-8** | Catalog creation shall not be reachable from any dose-entry or stock-entry screen. It shall be reachable only from the Vaccines tab. | Route inspection; C3 |
| **FR-9a** | The clinician shall be able to **add a new vaccine** to the catalog, specifying trade name, unit mode, doses per vial and safety limit. | `catalog/new.tsx`; `catalog.db.test.ts` — "adding a vaccine" |
| **FR-9b** | Attempting to add a vaccine whose name already exists shall be refused with a plain-language message naming the conflict, not a raw constraint error. | `catalog/new.tsx`; `catalog.db.test.ts` |
| **FR-9c** | The clinician shall be able to **hide** a vaccine (out of the pickers, one tap to restore) and separately to **remove** it (out of the catalog entirely). | `(tabs)/vaccines.tsx`; `catalog.db.test.ts` — "hiding versus removing" |
| **FR-9d** | Removal shall be a **soft delete**. It shall not orphan the ledger: every past dose shall still resolve to the vaccine's name in the history screen and in the CSV export. | `catalog.db.test.ts` — "does NOT orphan the ledger" |
| **FR-9e** | Before removing, the system shall state the consequence in real numbers — doses currently in stock, doses given, entries retained. | `(tabs)/vaccines.tsx`; `catalog.ts` `vaccineUsage` |
| **FR-9f** | A removal shall be reversible, both by restoring the row and by re-adding the same name. | `catalog.db.test.ts` — "frees the name" / "restoring the original row" |
| **FR-9g** | Removed vaccines shall remain listed under a "Removed" filter, so nothing disappears silently. | `catalog.db.test.ts` — "lists what has been removed" |

### 3.2 Receiving stock

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-10** | The clinician shall record a delivery by selecting a vaccine, entering the **batch/lot number**, the **expiry month**, the **source** (bought or government), and a **quantity**. | `receive/[vaccineId].tsx`; test-plan step 6 |
| **FR-11** | For vial-counted vaccines, quantity shall be entered in **vials** and converted to doses by the system. | `ledger.db.test.ts`; `stock.db.test.ts` |
| **FR-12** | Expiry shall be stored as the **last day of the printed month**, because a vial marked `03/2027` is usable throughout March 2027. | `time.db.test.ts` — "expiry is the LAST day" |
| **FR-13** | Government (UIP) and privately purchased stock shall be distinguishable, and shall form part of lot identity so they are never commingled. | `m001_initial.ts` `ux_lots_identity`; `lots.ts` |
| **FR-14** | Recording a delivery shall increase on-hand stock by exactly the number of doses received. | `ledger.db.test.ts` — "on-hand = sum of receipts…" |
| **FR-15** | A delivery shall not be recordable without a batch number. | `receive/[vaccineId].tsx` disabled state |

### 3.3 Administering a dose

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-20** | The clinician shall record a dose in **no more than three taps** from application launch, and **two** if the child is not recorded. | test-plan steps 2, 8 |
| **FR-21** | Each dose entry shall capture the vaccine, the time, the batch and optionally the child. The doctor gives every dose herself, so entries are not attributed to a named person. | `ledger.db.test.ts` — "stamps device and IST…" |
| **FR-22** | Recording the child shall be **optional and skippable**, and skipping shall never block or delay the entry. | `ledger.db.test.ts` — "the child is optional, by design" |
| **FR-23** | A dose recorded without a child shall be flagged so the name can be added later, without altering the stock arithmetic. | `schema.db.test.ts` — "still allows ANNOTATIONS"; `reports/today.tsx` |
| **FR-24** | The batch shall default to the most recently used batch in stock for that vaccine, so batch selection is usually zero taps. | `lots.ts` `lastUsedLot`; `dose/[vaccineId].tsx` |
| **FR-25** | Recording a dose shall decrease on-hand stock by exactly the number of doses given. | `ledger.db.test.ts` |
| **FR-26** | A repeated identical intent (a retry or a replayed write) shall **not** produce a second movement. | `ledger.db.test.ts` — "a replayed write cannot double-decrement" |
| **FR-27** | A genuine rapid repeat (siblings, twins) shall be **flagged but never blocked**. Under-recording is worse than double-recording: a double is visible at reconciliation, a miss is invisible. | `ledger.db.test.ts` — "flags a rapid repeat WITHOUT blocking it" |
| **FR-28** | The system shall not prevent administering a dose because stock is low, exhausted, or already negative. | `ledger.db.test.ts` — "PERMITS negative on-hand" |
| **FR-29** | Administration from an **expired** batch shall be blocked, with the expiry shown. | `dose/[vaccineId].tsx`; `lots.ts` `isExpired` |
| **FR-30** | The child register shall support type-ahead by name **or** guardian phone number, recent-children shortcuts, and inline creation of a new child from the dose screen. | `patients.ts`; test-plan step 2 |
| **FR-31** | The dose screen shall let the clinician save a child's date of birth, optionally and without ever blocking the dose. Every dose to that child shall then show the child's **age at that dose** in the clinic's resolution (weeks under six months, months under two years, then years and months), on the dose screen, in Given today, in All entries and in `doses.csv`. | `time.db.test.ts` — "age, in the clinic resolution"; `collect.db.test.ts`; test-plan step 20 |

### 3.4 Corrections

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-40** | Every entry shall be undoable immediately via an on-screen action. The window is deliberately **short (3.5 s)** so it does not obscure the grid; brevity is acceptable only because FR-42 keeps the same correction available indefinitely. | `snackbar.tsx`; test-plan step 3 |
| **FR-41** | Undo shall be implemented as a **reversing ledger entry**. It shall never delete or edit the original, and both rows shall remain visible. | `ledger.db.test.ts` — "restores stock exactly, and the original row still exists" |
| **FR-42** | The same correction mechanism shall remain available indefinitely from a history screen, not only during the undo window. | `ledger/index.tsx` |
| **FR-43** | A reversal shall restore stock **exactly**, including at the batch level. | `ledger.db.test.ts` |
| **FR-44** | A movement shall be reversible at most once, and a reversal shall not itself be reversible. | `ledger.db.test.ts`; `schema.db.test.ts` |
| **FR-45** | A repeated undo of the same entry shall not over-credit stock. | `ledger.db.test.ts` — "is itself idempotent" |
| **FR-46** | The system shall record wastage with a reason (open-vial timeout, breakage, expiry, cold chain, contamination, other). | `ledger.ts` `recordWastage` |
| **FR-47** | The system shall record a stock adjustment arising from a physical count, preserving the discrepancy as a fact rather than absorbing it. | `ledger.ts` `recordAdjustment` |

### 3.5 Reports

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-50** | *"Vaccine stock, names, unique values"* — the system shall list each vaccine with its present stock, each appearing exactly once. | `reports.db.test.ts` — "lists every catalog vaccine exactly once" |
| **FR-51** | *"Vaccines given today, time, count"* — the system shall list every dose given on a given local date with its time, vaccine, batch, child and the child's age at the dose, plus per-vaccine totals. | `reports.db.test.ts` |
| **FR-52** | Activity counts shall **exclude** undone entries: three doses with one undone shall report two. | `reports.db.test.ts` — "EXCLUDES an undone dose" |
| **FR-53** | *"Vaccines remaining today, time, count"* — the system shall present on-hand stock together with the derivation that produces it: `Opening · +Received · −Given · −Wasted · = Now`. | `reports.db.test.ts` — "the movement strip reconciles" |
| **FR-54** | That derivation shall always sum to the stated current figure, including when an entry from a previous day is corrected today. | `reports.db.test.ts` — 300-case property test |
| **FR-55** | The stated current figure shall equal the figure on the stock screen, so no two screens can disagree. | `reports.db.test.ts` — "strip.now equals v_stock_on_hand" |
| **FR-56** | Every report shall display its own as-of time. | `reports.ts` `asOfLabel` |
| **FR-57** | Reports shall be scoped by **local** date, not UTC date. | `reports.db.test.ts` — "scopes to the local date" |
| **FR-58** | Vaccines at or below their safety limit shall be visibly marked, and the count of such vaccines shall be visible on the home screen. | `stock.db.test.ts`; test-plan step 7 |
| **FR-59** | Negative on-hand stock shall be displayed, never clamped to zero, because it is the signal that a delivery went unlogged. | `ledger.db.test.ts` |
| **FR-60** | The system shall list doses recorded without a child, so they can be completed. | `reports.db.test.ts`; `reports.ts` `missingChildEntries` |
| **FR-61** | The home screen shall order vaccines by 30-day usage, so the vaccines this clinic actually gives need no scrolling. | `reports.db.test.ts` — "orders the Give Dose grid" |

### 3.6 Backup and restore

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-70** | One action shall produce a single backup file containing both the complete database and spreadsheet-readable CSVs, and offer it to the Android share sheet. | `export.ts`; test-plan step 10 |
| **FR-71** | The database image shall be produced with SQLite serialisation, never a raw file copy, because under WAL journalling recent commits are not yet in the `.db` file. | `export.ts` `buildBackupBundle` |
| **FR-72** | `doses.csv` shall be shaped like the notebook page it replaces: date, 12-hour time, vaccine, batch, child, age, doses. | `collect.db.test.ts` |
| **FR-73** | CSV output shall correctly quote commas, quotation marks, newlines and apostrophes. | `csv.db.test.ts` |
| **FR-74** | A candidate backup shall be validated **before** any live data is modified, and the confirmation shall show real counts from both the backup and the phone. | `validate.db.test.ts`; `import.ts` |
| **FR-75** | Restore shall reject, with a **specific** message, a file that is not a zip, contains no database, was written by a newer version, is missing tables, or contradicts its own manifest. | `validate.db.test.ts` — "backup rejection is always specific" |
| **FR-76** | Restore shall snapshot the current live database before overwriting it. | `import.ts` `commitRestore` |
| **FR-77** | A restored backup predating the current schema shall be migrated forward automatically. | `import.ts` |
| **FR-78** | The system shall prompt for a backup when none has been taken for 3 days **or** 25 doses have been recorded since the last one, and escalate at 14 days. | `backup-nag.db.test.ts` |
| **FR-79** | The backup prompt shall never be modal or blocking, and a snooze shall not silence the 14-day escalation. | `backup-nag.db.test.ts`; `backup-banner.tsx` |
| **FR-80** | The time of the last backup shall be permanently visible without any navigation. | `more.tsx`; `backup-nag.ts` `lastBackupLabel` |
| **FR-81** | The system shall snapshot the database automatically once per day and before every schema migration, retaining recent snapshots. | `provider.tsx`; `export.ts` `snapshotDb` |

### 3.7 Data integrity

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **FR-90** | The sign of a movement shall be consistent with its type; the database shall reject any violation. | `schema.db.test.ts` — "enforces that the sign… matches" |
| **FR-91** | A zero-dose movement shall be rejected. | `schema.db.test.ts` |
| **FR-92** | A movement referencing an unknown vaccine shall be rejected. | `schema.db.test.ts` |
| **FR-93** | Attempting to update a movement's arithmetic or delete a movement shall fail at the database level. | `schema.db.test.ts` — "the ledger is append-only, enforced by the database" |
| **FR-94** | The child's name shall be stored on the movement as entered, so renaming a child later never rewrites history. | `ledger.db.test.ts` |
| **FR-95** | The clinical time of an event shall be recorded separately from the time the row was written, so backdated entry does not misreport when a dose was given. | `ledger.db.test.ts` — "keeps occurred_at separate from recorded_at" |
| **FR-96** | Opening a database written by a newer version of the application shall be refused rather than partially written. | `schema.db.test.ts` — "refuses to open data written by a NEWER app" |
| **FR-97** | A migration and its version bump shall commit atomically. | `migrate.ts`; `schema.db.test.ts` |

---

## 4. Non-functional requirements

### 4.1 Usability

The user is a practising pediatrician, likely over 50, working one-handed between patients, often
reading without glasses, in a brightly lit room. These are requirements, not preferences.

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **NFR-1** | Every interactive target shall be at least **56 × 56 dp**; primary actions at least **64 dp** tall and full width, positioned in the lower third of the screen. | `tokens.ts`; test-plan step 14 |
| **NFR-2** | Body text shall be at least **18 pt**, no text below **14 pt**, and figures that matter at **28–32 pt** bold. | `tokens.ts` |
| **NFR-3** | Body text contrast shall be at least **7:1**; all semantic colours at least **4.5:1**. | `tokens.ts` |
| **NFR-4** | No state shall be conveyed by colour alone. Every state shall additionally carry a **word**. | `stock.db.test.ts` — "always pairs a level with a WORD" |
| **NFR-5** | No control outside the tab bar shall be icon-only. Every button shall carry a word. | `components.tsx` |
| **NFR-6** | The interface shall remain fully usable at Android font scale **1.6×** and enlarged display size. | test-plan step 14 |
| **NFR-7** | Quantities up to 20 shall be entered with steppers, not a keyboard, because a stepper cannot produce 100 where 10 was intended. | `components.tsx` `Stepper` |
| **NFR-8** | There shall be **no confirmation dialog on the dose path**. Confirmation on the common path trains users to dismiss confirmations, destroying their value where they matter. Undo replaces it. | `dose/[vaccineId].tsx` |
| **NFR-9** | A successful write shall produce haptic feedback, because the user is often not looking at the screen. | `snackbar.tsx` |
| **NFR-10** | The effect of a write shall be immediately visible on the originating screen, so physical reality is verified continuously rather than at month end. | test-plan step 2 |
| **NFR-11** | The application shall open to the dose-entry screen. It shall not open to a dashboard. | `(tabs)/index.tsx` |
| **NFR-12** | The interface shall be in English, portrait only, light theme only. No dark mode and no theming layer. | `app.json`; `tokens.ts` |
| **NFR-13** | Navigation shall be four tabs at the top of the screen: Give dose, Add stock, Vaccines, More. | `(tabs)/_layout.tsx`; `ui/top-tabs.tsx` |
| **NFR-14** | Give dose and Add stock move stock in opposite directions and are adjacent, so each context shall own a distinct accent colour carried through its tab, heading and primary button. Stock-level colours (amber/red/green) shall never be reused as a context accent. | `tokens.ts` `accentColor`; `ui/top-tabs.tsx` |
| **NFR-15** | The top tab bar shall scroll horizontally rather than clip when enlarged text makes it wider than the screen. | `ui/top-tabs.tsx` |

### 4.2 Reliability and durability

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **NFR-20** | Every function shall work with no network connection at any time. | test-plan step 13 (whole run in airplane mode) |
| **NFR-21** | No schema migration shall lose a pre-existing row. | `schema.db.test.ts`; migration-chain test |
| **NFR-22** | Force-closing the application mid-entry shall not corrupt the database or leave a partial row. | test-plan step 12 |
| **NFR-23** | An in-place reinstall shall preserve all data. | test-plan step 15 |
| **NFR-24** | Backup and restore shall round-trip losslessly. | test-plan step 11 |

### 4.3 Performance

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **NFR-30** | Cold launch to a usable dose-entry screen shall be under **3 seconds**. | test-plan step 1 |
| **NFR-31** | Recording a dose shall feel instantaneous, with no perceptible wait before the confirmation. | test-plan step 2 |
| **NFR-32** | Daily reports shall remain responsive with several years of history, via an indexed local-date column. | `ix_movements_local_date` |

### 4.4 Security and privacy

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **NFR-40** | Clinical data shall reside only in the application's private storage. No data shall be transmitted anywhere except a backup the clinician explicitly shares. | `provider.tsx`; `export.ts` |
| **NFR-41** | The only network access shall be the application-update check, and this shall be disclosed in the interface. | `settings/index.tsx` |
| **NFR-42** | Onboarding shall state that the phone requires a screen lock, which is the actual access control. | `more.tsx`, `children/index.tsx` |
| **NFR-43** | Patient records shall be minimal (name, optional date of birth, optional guardian phone) and structurally separable, so the inventory ledger remains valid if patient data is redacted. | `m001_initial.ts` |
| **NFR-44** | The public source repository shall never contain clinic data, patient data, or a database file. | `.gitignore` |

### 4.5 Maintainability

| Ref | Requirement | Verified by |
| --- | --- | --- |
| **NFR-50** | The entire data and domain layer shall be testable in plain Node with no device and no emulator. | `jest.config.js` project `db`; 113 tests |
| **NFR-51** | Date and number formatting shall not depend on platform locale data, whose output differs between Node and Android. | `time.ts`; `time.db.test.ts` |
| **NFR-52** | Primary keys shall be client-generated UUIDs, with `updated_at` and soft deletes throughout, so multi-device merge or cloud sync is additive rather than a rewrite. | `ids.ts`; `m001_initial.ts` |
| **NFR-53** | JavaScript-only changes, including new migrations, shall be deliverable without reinstalling the application. **Bounded by NFR-53a:** delivery only reaches installs whose `runtimeVersion` fingerprint matches the publishing tree. | `app.json` `runtimeVersion: fingerprint`; `expo-updates` |
| **NFR-53a** | Because a fingerprint mismatch causes an update to be silently ignored rather than reported, any change that rotates the fingerprint — a native dependency, a config plugin, or a build profile `env` entry — shall be treated as requiring a new APK, and the fingerprint shall be compared against the installed build before publishing. | `docs/RELEASE.md` § "The way this fails silently"; `eas fingerprint:generate` |

---

## 5. Primary use cases

### UC-1 — Give a dose *(dominant flow; many times per day)*

**Precondition:** application open.

1. Clinician taps the vaccine's tile on the home grid.
2. System opens the dose screen with the vaccine named, the most-recent batch pre-selected, and the
   quantity defaulted to 1.
3. Clinician taps a recent child, or types two letters and picks a match, or adds a new child inline,
   **or skips the child entirely**.
4. Clinician taps **Give 1 dose**.
5. System writes the movement, closes the screen, decrements the tile, gives haptic feedback, and
   shows an undo action for 8 seconds.

**Result:** stock reduced by one dose. **Two to three taps total.**

**Alternate — undo:** clinician taps UNDO; system appends a reversing entry; stock is restored; both
rows remain visible in the history.

**Alternate — expired batch:** system blocks the action and displays the expiry month.
(FR-29)

**Alternate — would go negative:** system warns but **still records the dose**, because refusing to
record a vaccination to protect an inventory figure is the wrong trade. (FR-28)

### UC-2 — Receive a delivery *(daily to weekly)*

1. Clinician opens **Stock → Receive stock** and selects the vaccine.
2. Enters the batch number (auto-capitalised) and taps the expiry month and year.
3. Selects bought or government.
4. Sets the quantity with a stepper — **in vials** for vial-counted vaccines.
5. System displays the dose equivalent and the resulting balance.
6. Clinician taps **Add to stock**.

**Result:** stock increased. Batch created if new. **Four to five taps plus the batch number.**

### UC-3 — Check what is left *(several times a day)*

Answered **without navigation**: every tile on the home screen shows its own remaining stock, and the
header shows the count of vaccines at or below their safety limit. The Stock tab adds the reconciling
derivation. (FR-50, FR-53, NFR-11)

### UC-4 — Review the day *(daily, at close)*

Clinician opens **Given today** and sees every dose with its time, child and batch, plus totals by
vaccine and the movement derivation — and can fill in any child name that was skipped.

### UC-5 — Back up *(prompted every few days)*

Clinician taps the prompt, then **Back up now**, and sends the file to herself over WhatsApp or saves
it to Drive. (FR-70, FR-78)

### UC-6 — Correct an old entry *(occasionally)*

Clinician opens **All entries**, finds the row, and taps **Correct this entry**. A reversing entry is
appended; nothing is deleted; the original remains visible marked as corrected. (FR-42)

---

## 6. Traceability

| Problem / request | Requirements | Mechanism |
| --- | --- | --- |
| P1 — misspelled vaccine names | FR-1, FR-2, FR-7, FR-8, C3 | Identity is a foreign key into a seeded catalog that entry screens cannot extend. "Unique values" is a property of the schema, not a report. |
| P2 — wrong or double decrement | FR-26, FR-27, FR-40 – FR-45, FR-90 – FR-93, C1, C2 | Append-only ledger with derived stock, idempotent writes, and reversal as the only correction. Every change stays visible, so drift is detectable. |
| "vaccine stock, names, unique values" | FR-50 | Stock tab and home grid |
| "vaccines given today, time, count" | FR-51, FR-52, FR-57 | Given-today report |
| "vaccines remaining today, time, count" | FR-53 – FR-56, FR-59 | Stock tab with reconciling derivation and as-of stamp |
| "trade name" | FR-1 | Catalog keyed by trade name |
| "present stock" | FR-50, C2 | Derived, never stored |
| "min balance / safety limit" | FR-5, FR-58 | Per-vaccine limit driving non-blocking warnings |
| Vial-versus-dose confusion | FR-3, FR-11 | Per-vaccine unit mode; the system does all conversion |

---

## 7. Known risks

| Ref | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **Phone lost, broken or reset with no recent backup — total data loss.** | Critical | FR-70 – FR-81: one-tap backup, time-*and*-count-triggered prompts, daily on-device snapshots, permanently visible last-backup time. Accepted by the clinician as the cost of having no backend. |
| R2 | Reinstalling with a different signing key forces an uninstall, which deletes the database. | Critical | Never rotate the EAS keystore; never change `android.package`; always reinstall in place; prefer over-the-air updates. Archive the keystore on day one. |
| R3 | A wrong doses-per-vial value corrupts all arithmetic for that vaccine. | High | A4; the warning on the catalog screen; onboarding instruction to check against the refrigerator. |
| R4 | The clinician reverts to the notebook because the application is slower. | High | FR-20, NFR-1 – NFR-11, NFR-30, NFR-31. This is the primary product risk, not a technical one. |
| R5 | Storage is unencrypted; a lost unlocked phone exposes children's names. | Medium | NFR-42; minimal patient data (NFR-43). Full encryption at rest requires leaving Expo Go and is deferred. |
| R6 | A single device means no second book of record. | Medium | Accepted. Schema is sync-ready (NFR-52) should this change. |
| R7 | **Give dose and Add stock are adjacent tabs**, so a mis-tap records a delivery as a dose or vice versa — corrupting stock in opposite directions and hard to spot later. | Medium | NFR-14: distinct accent per context, carried through the tab, the heading and the wording of the primary button, so a wrong tab is visibly wrong before anything is written. Any mistake that does land is fully reversible (FR-41, FR-42) and visible in the history. |
