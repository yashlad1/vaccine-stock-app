#!/bin/zsh
# The nightly Mac backup: one copy of the clinic per night, taken at 23:59 IST.
#
# launchd runs this every hour at :29 on the Mac's clock. IST is UTC+5:30 and
# the Mac's zone is a whole number of hours from UTC, so :29 here is always
# :59 in India, before and after the clocks change - one of those hourly runs
# is 23:59 IST exactly. Every other run just checks whether tonight's copy is
# still owed, which also covers a Mac that slept through 23:59 (launchd runs a
# missed job on wake) and a night with no internet (it retries the next hour).
#
# Install or remove: see the "Nightly backup" section of docs/RELEASE.md.
set -eu

out="$HOME/clinic-stock-backups"
stamp="$out/.last-nightly"
mkdir -p -m 700 "$out"

now=$(date +%s)
# The most recent 23:58 IST, a minute early so a run launched at 23:59:00
# sharp is never judged to be ahead of its own deadline.
target=$(TZ=Asia/Kolkata date -j -f "%Y-%m-%d %H:%M:%S" "$(TZ=Asia/Kolkata date +%Y-%m-%d) 23:58:00" +%s)
(( target > now )) && target=$(( target - 86400 ))
(( $(cat "$stamp" 2>/dev/null || echo 0) >= target )) && exit 0

echo "--- $(TZ=Asia/Kolkata date '+%d %b %Y %H:%M IST')"
cd "${0:A:h}/.."
npx --yes eas-cli@23.2.0 env:exec production \
  'NODE_OPTIONS="--disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON" node scripts/backup-from-server.ts' \
  --non-interactive 2>&1 | grep -v -E "eas-cli@|npm install -g|Proceeding with outdated|To upgrade|^Environment variables"
# Only a run that got this far counts; a failed one is retried at the next :29.
[[ ${pipestatus[1]} -eq 0 ]] && echo "$now" > "$stamp"
