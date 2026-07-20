#!/usr/bin/env node
// Submit an already-uploaded build to App Store review via the App Store Connect API.
//   node scripts/asc-submit.mjs <buildNumber> <versionString> ["what's new text"]
// e.g. node scripts/asc-submit.mjs 1784567527 1.1.0 "Bug fixes and improvements."
//
// Does the whole dance: find app + build, resolve export compliance (standard crypto only
// → usesNonExemptEncryption=false), create/reuse the App Store version, set "What's New",
// attach the build, and submit for review (reviewSubmissions flow). Reads ASC_KEY_ID /
// ASC_ISSUER_ID from ios/.asc.env (or env) and the .p8 from ~/.appstoreconnect/private_keys.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [buildNumber, versionString, whatsNewArg] = process.argv.slice(2);
if (!buildNumber || !versionString) {
  console.error('usage: node scripts/asc-submit.mjs <buildNumber> <versionString> ["what\'s new"]');
  process.exit(1);
}
const whatsNew = whatsNewArg || 'Bug fixes and improvements.';
const BUNDLE_ID = 'com.revoltlabs.chromabay';
const PLATFORM = 'IOS';

// --- creds ---
function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, 'ios/.asc.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();
const KEY_ID = process.env.ASC_KEY_ID, ISSUER_ID = process.env.ASC_ISSUER_ID;
if (!KEY_ID || !ISSUER_ID) { console.error('✗ ASC_KEY_ID / ASC_ISSUER_ID missing'); process.exit(1); }
const p8 = readFileSync(join(homedir(), '.appstoreconnect/private_keys', `AuthKey_${KEY_ID}.p8`), 'utf8');

// --- JWT (ES256) ---
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = createSign('SHA256').update(signingInput).sign({ key: p8, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64u(sig)}`;
}
const TOKEN = jwt();

const BASE = 'https://api.appstoreconnect.apple.com';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}
const fmtErr = (e) => e.body?.errors ? e.body.errors.map((x) => `${x.title}: ${x.detail}`).join('; ') : e.message;

(async () => {
  // 1. app
  const app = (await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`)).data[0];
  if (!app) throw new Error(`app ${BUNDLE_ID} not found`);
  console.log(`• app: ${app.attributes.name} (${app.id})`);

  // 2. build (must be done processing)
  const builds = (await api('GET',
    `/v1/builds?filter[app]=${app.id}&filter[version]=${buildNumber}&limit=1`)).data;
  const build = builds[0];
  if (!build) throw new Error(`build ${buildNumber} not found (still processing?)`);
  console.log(`• build ${buildNumber}: ${build.id} — processing=${build.attributes.processingState}`);
  if (build.attributes.processingState !== 'VALID')
    throw new Error(`build not VALID yet (${build.attributes.processingState}); wait for processing`);

  // 3. export compliance — standard/exempt crypto only
  if (build.attributes.usesNonExemptEncryption !== false) {
    await api('PATCH', `/v1/builds/${build.id}`, {
      data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
    });
    console.log('• export compliance set (usesNonExemptEncryption=false)');
  } else console.log('• export compliance already set');

  // 4. app store version (create or reuse)
  let version = (await api('GET',
    `/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${versionString}&filter[platform]=${PLATFORM}&limit=1`)).data[0];
  if (!version) {
    version = (await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: PLATFORM, versionString },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    })).data;
    console.log(`• created version ${versionString} (${version.id})`);
  } else {
    console.log(`• version ${versionString} exists (${version.id}) — state=${version.attributes.appStoreState}`);
  }

  // 5. attach build to the version
  await api('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, {
    data: { type: 'builds', id: build.id },
  });
  console.log('• build attached to version');

  // 6. "What's New" on each localization (create en-US if none)
  let locs = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  if (!locs.length) {
    locs = [(await api('POST', '/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale: 'en-US', whatsNew },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
      },
    })).data];
    console.log('• created en-US localization with What\'s New');
  } else {
    for (const loc of locs) {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
        data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew } },
      });
    }
    console.log(`• set What's New on ${locs.length} localization(s): "${whatsNew}"`);
  }

  // 7. submit for review (reviewSubmissions flow). Reuse an open submission if one exists.
  let sub = (await api('GET',
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=1`)).data[0];
  if (!sub) {
    try {
      sub = (await api('POST', '/v1/reviewSubmissions', {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: PLATFORM },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      })).data;
      console.log(`• opened review submission (${sub.id})`);
    } catch (e) {
      // an in-progress one may already exist in a state we didn't filter
      sub = (await api('GET', `/v1/reviewSubmissions?filter[app]=${app.id}&limit=1`)).data[0];
      if (!sub) throw e;
      console.log(`• reusing existing review submission (${sub.id})`);
    }
  } else console.log(`• reusing review submission (${sub.id}, state=${sub.attributes.state})`);

  // add the version as an item (ignore "already added")
  try {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    console.log('• added version to the submission');
  } catch (e) {
    console.log(`• submission item: ${fmtErr(e)} (continuing)`);
  }

  // finalize
  await api('PATCH', `/v1/reviewSubmissions/${sub.id}`, {
    data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } },
  });
  console.log(`\n✅ Submitted ${versionString} (build ${buildNumber}) for App Store review.`);
})().catch((e) => {
  console.error(`\n✗ ${fmtErr(e)}`);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
