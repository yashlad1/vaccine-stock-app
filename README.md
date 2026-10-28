# Vialbook

Formerly "Clinic Stock". The Android package id (`in.clinicstock.app`), the EAS slug (`clinic-stock`) and the URL scheme keep the old name on purpose: changing any of them would cut the installed phones off from updates.

An offline Android app that replaces a pediatric clinic's paper vaccine-stock notebook.

Two things happen all day — **a delivery arrives**, and **a dose is given to a child** — and
everything else is derived from those two events: present stock, low-stock warnings, and the day's
activity.

---

## The two ways this design loses all the data

Pinned at the top because everything else is secondary.

1. **The phone is lost, broken or reset with no recent backup.**
   All clinic records live on one device. Mitigated by one-tap backup, prompts triggered by *both*
   elapsed days and unbacked entries, automatic daily on-device snapshots, and a permanently visible
   "last backup" line — but the only real protection is a backup that has left the phone.

2. **Reinstalling with a different signing key.**
   A sideloaded APK can only be upgraded in place if it is signed with the same key. If the EAS
   keystore is lost or rotated, the app must be **uninstalled** to update it — **and uninstalling
   deletes the database.** So, on day one: run `eas credentials`, download the keystore and password,
   and archive them somewhere that will still exist in three years. Never change `android.package`.
   Always `adb install -r`. Prefer over-the-air updates so the APK rarely needs replacing at all.

---

## Why it is built this way

The clinic's notebook fails in two specific ways, and the architecture exists to make both
structurally difficult rather than merely discouraged:

| Paper failure | The fix |
| --- | --- |
| The same vaccine is spelled several ways, so no total can be trusted. | Vaccine names are **picked from a catalog, never typed**. Identity is a foreign key that no data-entry screen can create. "Unique values" becomes a property of the schema, not a report that de-duplicates. |
| The wrong count is reduced, or a reduction is doubled or missed, and stock silently drifts from the fridge. | Stock is **never a number anyone edits**. It is `SUM(delta_doses)` over an append-only ledger, and a mistake is fixed by *appending a reversing entry* — never by editing or deleting. Every change stays visible and attributable, which is what makes drift detectable instead of silent. |

Read [`CLAUDE.md`](./CLAUDE.md) before changing anything. It records the invariants and the reasons
for them.

## Documentation

| Document | Contents |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | Architecture, invariants, UI rules, dependency policy. The spec that governs development. |
| [`docs/SRS.md`](./docs/SRS.md) | 94 numbered requirements, each traced to a test |
| [`docs/ERD.md`](./docs/ERD.md) | Data model, and why the ledger looks like it does |
| [`docs/waterfall.md`](./docs/waterfall.md) | SDLC phases, Gantt timeline, sprint contents |
| [`docs/test-plan.md`](./docs/test-plan.md) | Three test layers and the 20-step on-phone script |
| [`docs/RELEASE.md`](./docs/RELEASE.md) | Building the standalone APK, archiving the keystore, and shipping OTA updates |
| [`docs/schema.sql`](./docs/schema.sql) | Reference DDL, generated from the migrations |

## Stack

Expo SDK 57 · React Native · expo-router · TypeScript · on-device SQLite via `expo-sqlite`, with raw
SQL behind a thin typed driver. No backend, no accounts, no internet needed to use it.

## Development

There is **no local Android toolchain and no emulator, by design** — the build machine has no usable
system image and no JDK 17/21, and the only device whose behaviour matters is the clinician's own
phone.

```sh
npm install

npm start           # scan the QR code with Expo Go on a real Android phone
npm run web         # fast browser loop for layout and contrast
npm test            # Node tests, no device needed
npm run typecheck
npm run schema:dump # regenerate docs/schema.sql from the migrations
```

`expo-sqlite` is included in Expo Go, so no custom development client is needed.

If the QR loop fails (usually router AP isolation), fall back to USB:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
adb reverse tcp:8081 tcp:8081
```

## Release

`npm start` is a *development* loop — it needs the Mac awake and reachable. For the clinic, build a
standalone APK that installs once and then runs fully offline, with no laptop and no QR code:

```sh
npx eas login          # one time, interactive
npm run eas:setup      # eas init && eas update:configure
npm run build:apk      # APK built in Expo's cloud; ends with a download URL
npm run keystore       # DO THIS DAY ONE — archive the keystore, see below
```

Send the URL over WhatsApp; she taps it, allows installs from that source once, and installs.

Afterwards, JavaScript fixes — including new migrations — ship over the air without a reinstall:

```sh
npm run ota -- "what changed"
```

Full detail, including the free-tier limits and what to check with her on first install, is in
[`docs/RELEASE.md`](./docs/RELEASE.md). The production profile builds an **APK, not an AAB**, because
this app is sideloaded and will never go to the Play Store.

## Layout

**Four tabs at the top**, each with its own accent colour: **Give dose** (blue), **Add stock**
(teal), **Vaccines** (violet), **More** (slate). The colours are a safety feature — the first two
move stock in opposite directions and sit next to each other, so hue, heading and button wording all
differ to make a mis-tap obvious before anything is written.

The UI is deliberately minimal: light theme only, no dark mode, no theming layer, no animation beyond
the toast fade. It shares its look with the clinic's other app, clinic-queue: white cards on a soft
grey ground, hairline edges, no shadows, sentence-case buttons. "Modern" never means thin, small or
low-contrast — 56dp targets, 18pt body text and a 14pt floor are hard requirements.

```
src/
  app/              expo-router screens; (tabs)/index.tsx is Give Dose, the launch destination
  db/
    driver.ts       the Db interface - the seam that makes everything testable
    driver.expo.ts  the ONLY file allowed to import expo-sqlite
    driver.node.ts  node:sqlite, for tests
    migrate.ts      forward-only runner over PRAGMA user_version
    migrations/     additive only; never edit a shipped migration
    repo/           catalog, lots, patients, staff, settings
    backup/         export, validate, restore, CSV
  domain/
    ledger.ts       all ledger writes; append-only, idempotent, dose-denominated
    stock.ts        vial<->dose conversion and low-stock state
    reports.ts      the three required reports
    time.ts         local-date stamping and month-end expiry
    seed.ts         the Indian pediatric catalog
  ui/               design tokens, the hand-written top tab bar, and components that
                    enforce the accessibility rules
docs/               SRS, ERD, waterfall, test plan, schema
jira/               CSV backlog for Jira import
```

## A note on the catalog

The app ships with the IAP-schedule vaccines pre-loaded under their Indian trade names, so the clinic
is productive on first launch and never has to type a vaccine name.

**They are editable suggestions, not gospel.** Doses-per-vial varies by manufacturer and pack, and a
wrong value there corrupts every stock figure for that vaccine. Checking those numbers against the
refrigerator is an explicit part of onboarding.

## Privacy

All clinical data stays in the app's private storage on one phone. Nothing is transmitted anywhere
except a backup the clinician explicitly shares. The only network access is the app-update check,
and that is disclosed in Settings. The phone's screen lock is the real access control — onboarding
says so.

**This repository is public.** No clinic data, patient data, or database file may ever be committed;
`.gitignore` covers `*.db`, `backups/` and `*.zip`.
