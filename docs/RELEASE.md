# Release & Distribution

How to get the app onto the doctor's phone in India, from a laptop in the USA, with **no QR code and
no laptop running as a server**.

---

## The short version

`npm start` + Expo Go is a **development** loop: it needs your Mac awake, on the same task, and the
phone talking to your Metro server. That is fine for you and useless for her.

**EAS Build produces a real, standalone APK.** It is built in Expo's cloud, downloaded from a link,
installed once, and then runs entirely offline forever. No laptop, no QR, no server, no internet
needed to use it. That is what she gets.

**EAS Update then lets you fix things from the USA without touching the APK.** You push a JavaScript
update; the next time she opens the app it picks it up. Her data is untouched.

---

## One-time setup

You are signed up at expo.dev already. Log in and initialise:

```sh
npx eas login          # interactive — only you can do this
npm run eas:setup      # eas init && eas update:configure
```

`eas init` writes `extra.eas.projectId` into `app.json`; `eas update:configure` writes `updates.url`.
Commit both.

## Build the APK

```sh
npm run build:apk      # eas build --platform android --profile production
```

Takes roughly 10–20 minutes on the free tier (shared queue). It ends with a URL like
`https://expo.dev/artifacts/eas/….apk`.

The production profile deliberately builds an **APK, not an AAB**, because this app is sideloaded and
will never go through the Play Store.

## Then, immediately — archive the keystore

```sh
npm run keystore       # eas credentials  →  Android → download the keystore
```

**Do this on day one and store the keystore file and its password somewhere you will still have in
three years** (password manager, not just a laptop folder).

**Done — 7 Sep 2026.** Archived to `~/clinic-stock-keystore/` (`keystore.jks` +
`credentials.txt`, both `chmod 600`, outside the repo). `*.jks` / `*.keystore` are in
`.gitignore`. **Still move it into a password manager or encrypted drive — a laptop folder is
one spilled coffee from being the failure this section exists to prevent.**

The one fact to keep even if the file is lost — the fingerprint every future build must match:

```
in.clinicstock.app
SHA-256  f83efd0e7e1f2a626abfa91b25e88c84e8c29c7eb7a3c487d2dbf9fb571d09e7
```

Check any future APK against it before sending it to the clinic:

```sh
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app.apk | grep 'SHA-256'
```

A different value means that APK **cannot** upgrade her installed app in place.

Why this matters more than anything else here: **an APK can only be upgraded in place if the new one
is signed with the same key.** If that keystore is lost or rotated, the only way to install a new
version is to uninstall the old one first — **and uninstalling deletes the clinic's entire database.**

Related, same reason: **never change `android.package`** (`in.clinicstock.app`).

---

## Builds shipped

| Date | versionCode | Version | Size | Notes |
| --- | --- | --- | --- | --- |
| 7 Sep 2026 | 3 | 0.1.0 | 109 MB | First successful build. Universal APK — all four ABIs. **Orphaned from OTA** (see below) |
| 7 Sep 2026 | **4** | 0.1.0 | **62 MB** | **Current.** ARM-only. Same signing key as build 3, so it upgrades in place. `runtimeVersion fa84bf12…` matches the tree, so OTA reaches it |

### Why later builds are ~half the size

Build 3 shipped `arm64-v8a`, `armeabi-v7a`, **`x86` and `x86_64`**. The last two are emulator
architectures; no phone will ever load them. Dropping them measured **109 MB → 62 MB, a 43% cut**.
Since the delivery channel is WhatsApp or Drive to a phone on Indian mobile data, that is a real cost
paid by the person we are trying to help.

It does not go lower by this route: the five `classes*.dex` files are ~44 MB and architecture-
independent, so they are now the floor. Shrinking further means removing unused dependencies (the
`create-expo-app` template left `@expo/ui`, `expo-device`, `expo-glass-effect`, `expo-symbols`,
`expo-web-browser`, `expo-image` and `react-native-worklets` in `package.json`, none of them imported
anywhere in `src/`) — worth doing, but it rotates the fingerprint, so bundle it with the next
deliberate native change rather than spending an orphaning event on it alone.

`eas.json` now pins release builds to the two ARM ABIs:

```json
"env": { "ORG_GRADLE_PROJECT_reactNativeArchitectures": "arm64-v8a,armeabi-v7a" }
```

Gradle maps `ORG_GRADLE_PROJECT_<name>` onto the project property React Native's `build.gradle`
already reads, so this needs no `expo-build-properties` and no `android/` directory. `armeabi-v7a`
stays in — dropping it would exclude older 32-bit phones for ~9 MB, which is the wrong trade for a
clinic that may hand this to a spare handset.

## Send it to her

Send the artifact URL over WhatsApp. Build 4 (62 MB):

```
https://expo.dev/artifacts/eas/voPkm1slDGItnvKLE-cfsI53HG9ZHFihekgP5nZF7Nk.apk
```

On her phone:

1. Tap the link, let Chrome download the `.apk`.
2. Android will ask to allow installs from this source — allow it once.
3. Tap the downloaded file → Install.
4. Open it. The vaccine catalog is already there.

**First thing to do together, before she relies on it:** open the **Vaccines** tab and check
*doses per vial* against what is actually in her fridge. Pack sizes vary by manufacturer, and a wrong
number there multiplies into every stock count for that vaccine.

Second thing: take one backup and confirm the file arrives on her phone, so you both know the
recovery path works before it is ever needed.

## Shipping a fix later (the part that solves the distance)

For anything that is JavaScript — screens, logic, wording, even new database migrations, since those
are just JS and SQL strings:

```sh
npm run ota -- "fixed the low-stock warning"
```

She reopens the app and has it. No reinstall, no new APK, no involvement from her.

You only need a **new APK** when native code changes — adding a native module, or upgrading the Expo
SDK. Those are rare.

### The way this fails silently: the fingerprint must match

`app.json` sets `runtimeVersion: { "policy": "fingerprint" }`. An OTA update is only applied by an
installed app whose **runtimeVersion is byte-identical** to the update's. A mismatch is not an error
on her phone — the update is simply ignored, forever, with no message. You will believe you shipped
a fix that never arrived.

The fingerprint covers native dependencies, config plugins **and the build profile's `env` block**.
That last one is easy to forget. It bit this project immediately:

| | runtimeVersion |
| --- | --- |
| Build 3 (universal APK) | `c47562a16ac2df4314fc5c9a97c1912c042c1b0c` |
| Build 4 (ARM-only, after adding `env` to `eas.json`) | `fa84bf12d3c530121ae0f71a302990527a15188c` |

Adding one environment variable rotated the fingerprint, which means **build 3 can never receive an
OTA update from this tree.** Nothing warns you about that.

It very nearly happened a second time, for an even smaller reason. `packageJson:scripts` is also a
fingerprint source, so adding a single npm alias — `"supabase:schema"` — rotated the hash and would
have orphaned build 5 from the whole server-backup feature and eight bug fixes. The fix was to delete
the alias and invoke the script directly:

```sh
NODE_OPTIONS=--disable-warning=ExperimentalWarning node scripts/supabase-schema.ts > supabase/schema.sql
```

A third time, unnoticed for a month: `expo-observe` (EAS Observe, added 16 Sep 2026 in `90db204`)
is a native module, so it moved the fingerprint to `e2d1f065…`. Every update published from that tree
would have been ignored by her phone. It was removed on 20 Oct 2026 to ship the age feature over
the air, which put the fingerprint back on `fa84bf12…`. Bring Observe back only together with a new
APK.

**The general rule: adding a convenience script to `package.json` costs an APK.** Before touching
that file, check the fingerprint. The full list of non-`node_modules` sources is short and worth
knowing:

```
.gitignore   eas.json   assets/images/*   expoConfig
packageJson:scripts     package:react-native
expoAutolinkingConfig:android    rncoreAutolinkingConfig:android
```

Everything under `src/` is absent from that list, which is exactly why application changes ship OTA.

So before publishing an update, check that the tree you are publishing from matches the APK she is
actually running:

```sh
npx eas-cli fingerprint:generate --platform android --environment production
# must equal the runtimeVersion of her installed build:
npx eas-cli build:list --limit 5
```

If they differ, the fix needs a **new APK**, not an OTA. And whenever you deliberately change the
fingerprint, the old install is cut off from updates — so send her the new APK reasonably promptly
rather than assuming OTA still has her covered.

**Always take a backup before an update, on the Mac, from the server** (owner, 20 Oct 2026: the
doctor should not have to do anything for it):

```sh
npx eas-cli env:exec production \
  'NODE_OPTIONS="--disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON" node scripts/backup-from-server.ts'
```

It writes one owner-only folder, `~/clinic-stock-backups/clinic-server-copy-<date>/`: `doses.csv`
(date, time, vaccine, batch, child, age, doses) and `vaccines.csv` (each vaccine's stock now) to
open in Numbers or Excel, `stock_movements.csv` and `patients.csv`, the bare `clinic.db`, and the
same zip the app's Back up button makes, so a phone can restore it. Then it runs the app's own
restore check on the zip. It holds what has reached the server: compare the "latest entry" line it
prints with her last dose, and if the phone has been offline, ask her to open the app on signal
first.

## Nightly backup on the Mac

`scripts/nightly-backup.sh` takes the same server copy every night at **23:59 IST** into
`~/clinic-stock-backups/` (one dated folder per night, log in `nightly.log`). It runs on the Mac,
never on GitHub: the repo is public, and a workflow artifact there would publish children's names.

launchd starts it every hour at :29 Mac time, which is :59 in IST all year round. The script only
does the work when that night's copy is still owed, so it also catches up when the Mac wakes after
sleeping through 23:59, and retries the next hour after a night with no internet. The Mac has to be
logged in to EAS (`npx eas-cli whoami`).

Install (once, on the Mac): save this as `~/Library/LaunchAgents/in.clinicstock.nightly-backup.plist`,
with your own username in the three paths, then load it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>in.clinicstock.nightly-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>/Users/YOU/Development/clinic-app/scripts/nightly-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Minute</key><integer>29</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>/Users/YOU/clinic-stock-backups/nightly.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/clinic-stock-backups/nightly.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/in.clinicstock.nightly-backup.plist
launchctl kickstart gui/$(id -u)/in.clinicstock.nightly-backup   # one run now, to check
launchctl bootout gui/$(id -u)/in.clinicstock.nightly-backup     # to remove it
```

## What the app talks to

Nothing, except the Expo update check. All clinical data stays in the app's private storage on that
phone. This is stated on the Settings screen, and it is worth telling her plainly, because "does this
send my patients' details somewhere" is a fair question.

## Free-tier limits

The free EAS plan gives a limited number of Android builds per month on a shared queue. Since native
builds are rare and OTA updates are unlimited in practice, this is unlikely to bind. If it does,
`npm run build:preview` uses the same APK output on the `preview` channel for testing.

---

## Quick reference

| Task | Command |
| --- | --- |
| Develop, on your phone | `npm start` (Expo Go, needs your Mac) |
| Build the standalone APK | `npm run build:apk` |
| Archive / inspect the keystore | `npm run keystore` |
| Ship a JS-only fix to India | `npm run ota -- "what changed"` |
| Install over an existing copy by USB | `adb install -r clinic-stock.apk` |
| Run the tests | `npm test` |
