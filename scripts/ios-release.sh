#!/usr/bin/env bash
# One-command iOS release → TestFlight:
#   build web → cap sync → archive → export → upload to App Store Connect.
#
# Build number = epoch seconds (monotonically increasing, no manual bumping, and consistent
# with scripts/bump-ios-build.mjs so it never collides with a dev build's number). The
# marketing version (e.g. 1.0.0) stays as set in the project — bump MARKETING_VERSION when
# you want a new user-facing version.
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
# so locally-built dev installs sit below the 0.1.x hot-update line and keep receiving
# hot updates; the STORE binary must ship as 1.0.0, so we override it here only.
MARKETING="${MARKETING_VERSION:-1.0.0}"
echo "▶ ChromaBay iOS release — marketing $MARKETING, build $BUILD"

npm run build
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
