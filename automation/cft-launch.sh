#!/bin/sh
# Launch Chrome for Testing for Web Bluetooth automation (CDP on 9334).
# Why this browser and why `open`: a second *Google Chrome* sees no live BLE adverts while the
# user's own Chrome runs (same app), and a Chrome spawned from a shell/Playwright inherits the
# terminal's missing macOS Bluetooth permission and silently finds nothing. Chrome for Testing
# is a separate app, and `open` makes it its own process for macOS permission purposes.
# First BLE use shows "would like to use Bluetooth" — the browser is frozen until a human
# clicks Allow. Install the browser with: npx playwright install chromium
set -e
APP=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/"Google Chrome for Testing.app" | tail -1)
PROFILE=${CFT_PROFILE:-${TMPDIR:-/tmp}/chromabay-cft-profile}
URL=${1:-https://chromabay.app/devices}
open -na "$APP" --args --remote-debugging-port=9334 --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check "$URL"
