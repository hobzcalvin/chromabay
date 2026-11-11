#!/usr/bin/env bash
# One-command iOS release → TestFlight:
#   build web → cap sync → archive → export → upload to App Store Connect.
#
# Usage: MARKETING_VERSION=1.3.0 bash scripts/ios-release.sh
#
# Build number = epoch seconds (monotonically increasing, no manual bumping, and consistent
# with scripts/bump-ios-build.mjs so it never collides with a dev build's number).
# MARKETING_VERSION is REQUIRED and must be above the current hot-update line (package.json
# MAJOR.MINOR), so a fresh store install is never offered an older live update.
#
# Requires:
#   - the App Store Connect API key .p8 at ~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8
#   - ASC_KEY_ID / ASC_ISSUER_ID (from ios/.asc.env or the environment)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f ios/.asc.env ] && source ios/.asc.env
: "${ASC_KEY_ID:?set ASC_KEY_ID (or create ios/.asc.env)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (or create ios/.asc.env)}"

KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
[ -f "$KEY_PATH" ] || { echo "✗ missing App Store Connect key: $KEY_PATH"; exit 1; }

# Hand the App Store Connect API key to xcodebuild too (not just the uploader), so automatic
# signing can CREATE/download the Apple Distribution cert + provisioning profile headlessly on
# the first run — no Xcode, no manually-made distribution certificate.
AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID")

BUILD=$(date +%s)   # epoch seconds: always increasing, matches the dev-build scheme
# App Store marketing version. The project itself carries a LOW MARKETING_VERSION (0.0.1)
# so locally-built dev installs sit below the hot-update line and keep receiving hot
# updates; the STORE binary's version is passed explicitly and overridden here only.
MARKETING="${MARKETING_VERSION:?set MARKETING_VERSION, e.g. MARKETING_VERSION=1.3.0}"
[[ "$MARKETING" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ MARKETING_VERSION must be X.Y.Z (got $MARKETING)"; exit 1; }
HOT_LINE=$(node -p "require('./package.json').version.split('.').slice(0,2).join('.')")
if [ "$(node -e "const [a,b]=[process.argv[1],process.argv[2]].map(v=>v.split('.').map(Number));console.log(a[0]>b[0]||(a[0]===b[0]&&a[1]>b[1])?1:0)" "$MARKETING" "$HOT_LINE")" != 1 ]; then
  echo "✗ MARKETING_VERSION $MARKETING must be above the hot-update line $HOT_LINE.x (package.json)"; exit 1
fi
echo "▶ ChromaBay iOS release — marketing $MARKETING, build $BUILD"

# Bake the version into the web bundle shipped INSIDE the binary. Without these the
# Devices page shows "Version: dev - dev" (1.2.0 shipped that way) and Sentry groups
# store-build errors under release "appdev". Mirrors what deploy.yml sets for hot updates.
export VITE_VERSION="$MARKETING"
export VITE_COMMIT_HASH="$(git rev-parse HEAD)"
export VITE_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export VITE_COMMIT_MESSAGE="$(git log -1 --pretty=%s | tr -d '"`\\$')"
export NODE_ENV=production

npm run build
# Guard: the version must actually be in the built bundle, or don't ship it.
grep -rqF "$VITE_COMMIT_HASH" build/_app || { echo "✗ build is missing the baked-in version/commit — refusing to release"; exit 1; }
npx cap sync ios

rm -rf build/ChromaBay.xcarchive build/ipa
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -archivePath build/ChromaBay.xcarchive -destination 'generic/platform=iOS' \
  CURRENT_PROJECT_VERSION="$BUILD" MARKETING_VERSION="$MARKETING" "${AUTH[@]}" archive

xcodebuild -exportArchive -archivePath build/ChromaBay.xcarchive -exportPath build/ipa \
  -exportOptionsPlist ios/ExportOptions.plist "${AUTH[@]}"

xcrun altool --upload-app -f build/ipa/App.ipa -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "✅ Uploaded build $BUILD to App Store Connect → TestFlight (processes in ~5–15 min)."
