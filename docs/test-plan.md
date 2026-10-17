# Test Plan
## Clinic Vaccine Stock Logger

Three layers, cheapest first. **Layers A and B need no phone. Layer C is the only one that proves
anything.**

---

## Layer A — the ledger, in plain Node

No device, no emulator, no React. This is where correctness is actually established.

```sh
npm test              # both projects
npm run test:db       # data + domain only
npm run test:watch
```

Runs against Node 25's built-in `node:sqlite` through `src/db/driver.node.ts`. This is only possible
because of the `Db` interface: nothing outside `src/db/driver.*.ts` imports `expo-sqlite`, so the
entire data and domain layer is ordinary Node code.

**Current status: 113 tests across 9 suites, all passing.**

| Suite | Covers |
| --- | --- |
| `db/schema.db.test.ts` | Migration runner, downgrade guard, every `CHECK` constraint, the append-only triggers |
| `domain/ledger.db.test.ts` | Derived stock, idempotency, reversal, optional child, attribution, backdating |
| `domain/reports.db.test.ts` | All three required reports, the movement strip, and the 300-case reconciliation property test |
| `domain/stock.db.test.ts` | Vial↔dose arithmetic, low-stock boundary, display strings |
| `domain/time.db.test.ts` | Local-date stamping, midnight IST, month-end expiry |
| `domain/backup-nag.db.test.ts` | When to prompt for a backup, and what a snooze may and may not silence |
| `db/backup/validate.db.test.ts` | Backup preview, and a specific rejection for every kind of bad file |
| `db/backup/collect.db.test.ts` | CSV contents, including undone doses being omitted |
| `db/backup/csv.db.test.ts` | Quoting of commas, quotes, newlines, apostrophes |

### The tests that earn their keep

These are the ones worth re-reading when changing anything:

1. **On-hand = Σ receipts − Σ administrations − Σ wastage**, over a hand-built sequence.
2. **Vial accounting** — three doses out of a ten-dose vial leaves seven; the eleventh opens a second.
3. **A reversal restores stock exactly, and the original row still exists afterwards.**
4. **A replayed write cannot double-decrement** — the same tap retried three times writes once.
5. **A rapid repeat is flagged but not blocked** — siblings and twins are real, and under-recording
   is worse than double-recording.
6. **`local_date` does not shift at midnight IST**, nor when the phone's timezone changes afterwards.
7. **Low stock fires at `<=`, not `<`** — off-by-one here means a silent stock-out.
8. **Activity counts exclude undone doses** — "three given, one undone" must read two, not three.
9. **The movement strip always equals derived on-hand**, asserted over 300 randomly generated
   two-day histories including reversals across day boundaries. This test found a real reconciliation
   bug during development.
10. **Restore rejects a truncated file, a zip with no database, and a database from a future version**
    — each with its own specific message.
11. **The append-only triggers actually fire** — updating `delta_doses` or deleting a movement is
    rejected by SQLite, while annotation columns remain editable.
12. **No report renders a negative zero** — `-0` would display as "−0 doses" and look broken.

### Whenever a migration is added

Build a database at version *N−1*, seed it with rows, run the chain, and assert **every pre-existing
row survived** and the new columns exist. Row-count preservation is the assertion that matters.

---

## Layer B — browser smoke loop

```sh
npm run web          # expo start --web
```

Sub-second iteration for layout, type scale, contrast and flow. Use browser devtools to check
contrast ratios, and zoom to approximate a large system font scale.

Real database behaviour is already fully covered by Layer A, so this layer is only about the
interface.

Two configuration details were needed to make this work, and both are load-bearing:

- `metro.config.js` adds `wasm` to `resolver.assetExts`. `expo-sqlite`'s web build loads
  `wa-sqlite.wasm`, and Metro does not treat `.wasm` as an asset by default, so the bundle fails
  without it.
- `app.json` sets `web.output` to `"single"` (SPA). With the default `"static"`, the static-render
  pass fails with *"Worker chunk not found for expo-sqlite/web/worker.ts"* — the SQLite web worker
  cannot be bundled during server rendering.

Verified: **985 modules, zero bundling errors**, with every screen and domain module present in the
compiled bundle.

---

## Layer C — the physical Android phone

**This is the only layer that proves the app works.** There is no local emulator by design.

### Setup

```sh
npm start                       # then scan the QR code with Expo Go
```

If the QR loop fails, the cause is almost always router AP isolation. Fall back to USB:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
adb reverse tcp:8081 tcp:8081   # then open http://localhost:8081 in Expo Go
```

To read crashes off the phone:

```sh
adb logcat --pid=$(adb shell pidof -s host.exp.exponent)
```

### The script

Run **every step, in order, with the phone in airplane mode for the entire run.**
**Steps 10, 11 and 14 are the ones people skip and the ones that matter most.**

| # | Step | Pass criterion | Requirement |
| --- | --- | --- | --- |
| 1 | Cold launch. Time it with a stopwatch. | Give Dose grid usable in **under 3 s**. Catalog is pre-loaded. | NFR-30, FR-1 |
| 2 | Give one dose of a single-dose vaccine to a **new child created inline**. | Tile decrements by 1; haptic fires; undo appears; "doses today" increments. **Three taps.** | FR-20, FR-21, FR-30, NFR-9, NFR-10 |
| 3 | **Undo it** within the 3.5 s window. | Stock restored; today's count decrements; **All entries shows BOTH the original and the correction** — nothing vanished. Then confirm the same entry is still correctable from All entries *after* the toast has gone. | FR-40, FR-41, FR-42 |
| 4 | Give one dose of a 10-dose-vial vaccine. | Stock falls by 1 dose; the tile shows both denominations, e.g. `29 doses` / `2 vials + 9 doses`. | FR-3, FR-11 |
| 5 | Give 9 more from that vial. | Arithmetic stays correct across the vial boundary; no rounding drift. | FR-3 |
| 6 | Receive a delivery: 5 vials, batch `ABC123`, expiry 06/2027, bought. | Stock rises by 5 × doses-per-vial; the batch appears as a chip on the dose screen. | FR-10 – FR-14 |
| 7 | Drive a vaccine to its safety limit. | Amber `LOW` **word** on the tile; header LOW count includes it; Stock tab sorts it first. | FR-58, NFR-4 |
| 8 | Give a dose using **Skip, no name**. | It commits in **two taps**, and appears in the missing-names list. | FR-22, FR-23 |
| 9 | Open **Given today**. | Every dose listed with correct time, child and batch; totals correct; the movement strip adds up to the figure on the Stock tab. | FR-51 – FR-56 |
| 10 | **Backup.** Tap Back up now → share to the clinician's own WhatsApp **and** to Drive. Then open `doses.csv` in Google Sheets on the phone. | **The file actually arrives and opens.** Attachment-type filtering by WhatsApp or Gmail is the most likely thing to break silently, and this is the only place you would find out. | FR-70 – FR-73 |
| 11 | **Restore.** On a second device, or after clearing app data, import that zip. | Preview shows counts matching the backup; after restoring, the data is back. **This validates the entire durability story and is the test everyone skips.** | FR-74 – FR-77, NFR-24 |
| 12 | Swipe the app away mid-entry, then relaunch. | No crash, no half-written row, no corruption. | NFR-22 |
| 13 | Confirm the whole run above was in **airplane mode**. | Everything worked. | NFR-20 |
| 14 | Android Settings → Display → font size **Largest** + display size **Large**. Re-run steps 2 and 6. | Nothing clipped, nothing unreachable, no button pushed off screen. **The top tab bar scrolls sideways rather than hiding the last tab.** | NFR-1, NFR-6, NFR-15 |
| 15 | Install the APK over the previous one with `adb install -r`. | **All data preserved.** | NFR-23 |
| 16 | Open **Vaccines**, change a doses-per-vial value, and save. | The change is reflected in stock display immediately; history still resolves. | FR-3, FR-6 |
| 17 | On the **Vaccines** tab, add a new vaccine, then try to add it a second time. | It appears in the Give dose grid immediately. The duplicate is refused with a plain message naming the conflict. | FR-9a, FR-9b |
| 18 | **Remove** a vaccine that has stock and history. | The confirmation states the doses in stock and doses given. After removing: gone from Give dose, Add stock and search — but **All entries still shows its past doses by name**, and it appears under the Removed filter. Add it back and confirm its stock returns. | FR-9c – FR-9g |
| 19 | Tap between **Give dose** and **Add stock** several times. | The two are unmistakable: different accent colour on the tab, the heading and the primary button (`Give n doses` vs `Add to stock`). | NFR-14 |
| 20 | Give a dose to a saved child with no date of birth, and set one on the wheel. Then give that child a second vaccine. | The wheel shows `Age today: …`; Given today and `doses.csv` show the age on **both** doses; the second dose shows the age with no date entry. A partial or impossible date (31 Feb) says so and is not saved, and the dose still records. | FR-31 |

### Then: a two-week soak

Hand over the APK and check back after seven days **with a real backup file in hand**. The questions
that matter are behavioural, not technical:

- Is she using it, or has she gone back to the notebook? *(SRS R4 — the primary risk)*
- Has she taken a backup without being told to? *(SRS R1)*
- Did the doses-per-vial values need correcting? *(SRS R3, assumption A4)*
- What did she try to do that the app would not let her?

---

## Pre-release checklist

- [ ] `npm test` — all green
- [ ] `npm run typecheck` — clean
- [ ] `npx expo export --platform android` — bundles without error
- [ ] Layer C script completed on a real phone, in airplane mode
- [ ] Step 11 (restore) actually performed, not assumed
- [ ] **`eas credentials` run, keystore and password archived off this machine** *(SRS R2 — losing this means uninstalling to update, which deletes the clinic's data)*
- [ ] `git status` clean of any `.db`, `.zip` or backup file *(the repository is public)*
