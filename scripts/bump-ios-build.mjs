// Bump the iOS native build number (CURRENT_PROJECT_VERSION) to a fresh, monotonic value on
// each `npm run ios:live`. Two things depend on it:
//   1. The App Store / TestFlight require a unique, increasing build number per upload.
//   2. The app's live-update reconcile (see +layout.ts) resets a stale downloaded bundle when
//      the native build code changes — so a native reinstall always wins over an old bundle.
import { readFileSync, writeFileSync } from 'node:fs';

const PBX = 'ios/App/App.xcodeproj/project.pbxproj';
const build = Math.floor(Date.now() / 1000); // seconds since epoch: unique + always increasing

let src = readFileSync(PBX, 'utf8');
const before = src;
src = src.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

if (src === before) {
  console.warn('bump-ios-build: no CURRENT_PROJECT_VERSION lines found — pbxproj unchanged');
} else {
  writeFileSync(PBX, src);
  console.log(`bump-ios-build: CURRENT_PROJECT_VERSION → ${build}`);
}
