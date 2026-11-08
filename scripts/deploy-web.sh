#!/bin/zsh
# Deploy the read-only dashboard.
#
#   ./scripts/deploy-web.sh preview    -> clinic-stock--preview.expo.app  (test)
#   ./scripts/deploy-web.sh prod       -> clinic-stock.expo.app           (live)
#
# The target is REQUIRED, with no default. This script can change what the
# clinic sees from her phone, so the difference between rehearsing and shipping
# must be typed, not inherited from a default. An old argument-less invocation
# now fails with usage rather than silently going live.
#
# Preview and production are separate deployments of the same directory, both
# reading the same Supabase project - so a preview shows REAL clinic data. It is
# a rehearsal of the page, not a sandbox of the data. Nothing here can write.
#
# Invoked DIRECTLY, never through an npm script, and it writes no permanent
# file. Both of those are deliberate: `packageJson:scripts` and `.gitignore`
# are BOTH EAS fingerprint sources, so adding a script alias or a gitignore
# entry rotates the OTA runtimeVersion and cuts every installed phone off from
# updates. That has now happened twice on this project - once for an npm alias,
# once for a `web/config.js` gitignore line - so the credentials are generated
# into place, deployed, and removed again, leaving the fingerprint untouched.
#
# Values come from the EAS environment variables, so there is one source of
# truth shared with the phone app.
set -e
cd "$(dirname "$0")/.."

MODE="${1:-}"
case "$MODE" in
  preview|prod) ;;
  *)
    echo "usage: ./scripts/deploy-web.sh {preview|prod}" >&2
    echo "  preview  deploy to clinic-stock--preview.expo.app for checking" >&2
    echo "  prod     publish to clinic-stock.expo.app, which the clinic uses" >&2
    exit 2
    ;;
esac

# A FUNCTION, not a variable. zsh does not word-split an unquoted variable, so
# `EAS="npx ..."; $EAS env:list` dies with "command not found" - and under
# `set -e`, inside a $( ), it dies silently with exit 127 and no message at all.
# That exact mistake has now been made twice on this project.
eas_cli() { npx --yes eas-cli@23.2.0 "$@"; }

VARS=$(eas_cli env:list --environment production 2>/dev/null) || true

get() { echo "$VARS" | grep "^$1=" | head -1 | cut -d= -f2- ; }
URL=$(get EXPO_PUBLIC_SYNC_URL)
KEY=$(get EXPO_PUBLIC_SYNC_KEY)
EMAIL=$(get EXPO_PUBLIC_SYNC_EMAIL)

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "EXPO_PUBLIC_SYNC_URL / _KEY are not set on EAS. See docs/SETUP-COMMANDS.md." >&2
  exit 1
fi

# No password: the page asks for it and the browser keeps the session.
cat > web/config.js <<EOF
window.CLINIC_CONFIG = {
  url: '$URL',
  key: '$KEY',
  email: '$EMAIL',
};
EOF

# Removed even if the deploy fails, so it can never be committed by accident.
# install-config.js holds the APK link for web/install.html and is treated the
# same way: the repo is public and the build must reach only the clinic.
cleanup() { rm -f web/config.js web/install-config.js; }
trap cleanup EXIT

# The install page's download link: the latest FINISHED Android build. The
# expiry is EAS's own `expirationDate` for that build (about 30 days), written
# into the file and compared with the viewer's clock when the page opens. A
# date typed here would drift from what EAS really does; a runtime check on
# the link itself is blocked by the page's CSP and cross-origin rules.
# Not fatal: without it the page says "This link has expired".
BUILD=$(eas_cli build:list --platform android --status finished --limit 1 --json --non-interactive 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const b = JSON.parse(s.slice(s.indexOf("[")))[0];
      process.stdout.write(JSON.stringify({ url: b.artifacts.buildUrl, version: b.appBuildVersion, date: b.completedAt, expires: b.expirationDate }));
    } catch (e) {}
  });') || true
if [ -n "$BUILD" ]; then
  echo "window.INSTALL_CONFIG = $BUILD;" > web/install-config.js
else
  echo "No finished EAS build found: the install page will say its link has expired." >&2
fi

# ---------------------------------------------------------------------------
# Deploy, then PROVE it.
#
# `eas deploy --prod` printed "Promoted deployment to production" while the
# production alias stayed on the PREVIOUS deployment - the doctor kept seeing
# the old dashboard for a whole release. Success on stdout is not evidence, so
# the alias is now moved by an explicit second command and the result is
# checked against what the URL actually serves.
# ---------------------------------------------------------------------------
if [ "$MODE" = prod ]; then
  TARGET_URL="https://clinic-stock.expo.app"
  echo "Publishing web/ to PRODUCTION ($TARGET_URL) for $URL"
else
  # A named alias rather than the per-deployment hash URL, so the test link is
  # stable and can be bookmarked instead of re-copied every deploy.
  TARGET_URL="https://clinic-stock--preview.expo.app"
  echo "Deploying web/ to PREVIEW ($TARGET_URL) for $URL"
fi

if [ "$MODE" = prod ]; then
  OUT=$(eas_cli deploy --export-dir web --non-interactive --dev-domain clinic-stock --json)
else
  OUT=$(eas_cli deploy --export-dir web --alias preview --non-interactive --dev-domain clinic-stock --json)
fi

# The id is read from the JSON rather than scraped from the pretty output,
# which is decorated and not a contract.
DEPLOY_ID=$(printf '%s' "$OUT" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s.slice(s.indexOf("{")));
    const id = j.identifier ?? j.id ?? j.deploymentIdentifier ?? j.deployment?.identifier;
    if (!id) { console.error("no deployment id in: " + JSON.stringify(j).slice(0, 400)); process.exit(1); }
    process.stdout.write(String(id));
  });')

echo "Deployment $DEPLOY_ID"

if [ "$MODE" = prod ]; then
  # Explicit, separate promotion. This is the step that silently did not happen.
  eas_cli deploy:alias --prod --id "$DEPLOY_ID" --non-interactive
fi

# --- proof ------------------------------------------------------------------
# Every file is served byte-for-byte as it sits in web/, so the checksums must
# match exactly. The cache-buster matters: this alias carries
# `cache-control: max-age=3600`, so an unqualified request can answer from the
# edge and cheerfully confirm the previous release.
#
# EVERY file, not just app.js. Checking one file proves nothing about a deploy
# that did not change that file: a release adding index.html, 404.html and
# favicon.svg left app.js untouched, so its checksum matched the PREVIOUS
# deployment and this script printed "Verified" over an alias that had not
# moved. A proof that passes when the thing is broken is worse than no proof.
#
# RETRIED, because alias routing is eventually consistent. A single immediate
# check raced it and printed "DEPLOY FAILED VERIFICATION" on a deploy that was
# fine - the alias caught up about two minutes later. That false alarm is worse
# than no check at all: it invites a panicked re-promote of the wrong thing.
#
# config.js and install-config.js are skipped: generated per deploy, holding the
# credentials and the build link,
# so it is the one file worth never piping through this script's output.
FILES=$(cd web && find . -type f ! -name 'config.js' ! -name 'install-config.js' | sed 's|^\./||')

MISMATCH=""
for attempt in $(seq 1 12); do
  MISMATCH=""
  for f in ${(f)FILES}; do
    LOCAL_SUM=$(shasum -a 256 "web/$f" | cut -d' ' -f1)
    REMOTE_SUM=$(curl -fsS "$TARGET_URL/$f?deploycheck=$DEPLOY_ID-$attempt" | shasum -a 256 | cut -d' ' -f1) || REMOTE_SUM=""
    if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then
      MISMATCH="$f"
      break
    fi
  done
  [ -z "$MISMATCH" ] && break
  echo "  waiting for $TARGET_URL to pick up the new alias — $MISMATCH still stale ($attempt/12)..."
  sleep 15
done

if [ -n "$MISMATCH" ]; then
  echo "" >&2
  echo "DEPLOY FAILED VERIFICATION after 3 minutes." >&2
  echo "  $TARGET_URL/$MISMATCH does not match web/$MISMATCH." >&2
  echo "  local  $LOCAL_SUM" >&2
  echo "  served $REMOTE_SUM" >&2
  echo "" >&2
  echo "The upload succeeded but the alias is still on an older deployment." >&2
  echo "This build is always reachable at its own URL, which never needs an alias:" >&2
  echo "  https://clinic-stock--$DEPLOY_ID.expo.app" >&2
  echo "" >&2
  echo "Move the alias by hand:" >&2
  # Mode-specific ON PURPOSE. This line used to say --prod in both modes, so
  # following it after a failed PREVIEW deploy would have published straight to
  # the clinic - the exact thing the required {preview|prod} argument exists to
  # prevent.
  if [ "$MODE" = prod ]; then
    echo "  npx --yes eas-cli@23.2.0 deploy:alias --prod --id $DEPLOY_ID" >&2
  else
    echo "  npx --yes eas-cli@23.2.0 deploy:alias --alias preview --id $DEPLOY_ID" >&2
  fi
  exit 1
fi

echo "Verified: $TARGET_URL is serving this build ($LOCAL_SUM)"
