#!/usr/bin/env bash
# One-command iOS release → TestFlight:
#   build web → cap sync → archive → export → upload to App Store Connect.
#
# Build number = git commit count (monotonically increasing, no manual bumping); the
# marketing version (e.g. 1.0.0) stays as set in Xcode — bump that in the Xcode project
# when you want a new user-facing version.
#
# Requires:
#   - the App Store Connect API key .p8 at ~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8
#   - ASC_KEY_ID / ASC_ISSUER_ID (from ios/.asc.env or the environment)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f ios/.asc.env ] && source ios/.asc.env
: "${ASC_KEY_ID:?set ASC_KEY_ID (or create ios/.asc.env)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (or create ios/.asc.env)}"

BUILD=$(git rev-list --count HEAD)
echo "▶ ChromaBay iOS release — build $BUILD"

npm run build
npx cap sync ios

rm -rf build/ChromaBay.xcarchive build/ipa
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -archivePath build/ChromaBay.xcarchive -destination 'generic/platform=iOS' \
  CURRENT_PROJECT_VERSION="$BUILD" -allowProvisioningUpdates archive

xcodebuild -exportArchive -archivePath build/ChromaBay.xcarchive -exportPath build/ipa \
  -exportOptionsPlist ios/ExportOptions.plist -allowProvisioningUpdates

xcrun altool --upload-app -f build/ipa/App.ipa -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "✅ Uploaded build $BUILD to App Store Connect → TestFlight (processes in ~5–15 min)."
