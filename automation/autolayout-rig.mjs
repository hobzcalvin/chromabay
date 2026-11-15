#!/usr/bin/env node
// Hands-free auto-layout bench rig: drive the real app (in the Chrome for Testing started by
// cft-launch.sh, already connected to the device by cft-connect.mjs) through camera auto-mapping,
// N times, and check each result against the layout you know the LEDs have.
//
//   node automation/autolayout-rig.mjs --expect=16x16s [--strip=1] [--runs=3] [--out=rig-out]
//
// --expect=WxH[s]  the true layout: W×H grid, LED 0 at a corner, row-major (s = serpentine).
//                  Compared up to rotation/mirror (orientation isn't recoverable from a camera).
//                  Omit for free-form installs; the rig then just reports found/total.
// Each run saves  <out>/run-<time>.json (result + diagnostics) and .bin (raw frames — replay
// offline with automation/replay-capture.ts, which is how decoder changes get tested on real data).
//
// Setup once (macOS): cft-launch.sh now passes --use-fake-ui-for-media-stream so the page's camera
// prompt auto-accepts; macOS itself still asks once to let "Google Chrome for Testing" use the camera.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const expect = arg('expect'), strip = +arg('strip', '1'), runs = +arg('runs', '1'), out = arg('out', 'rig-out');
mkdirSync(out, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find((p) => /chromabay\.app|localhost/.test(p.url()));
if (!page) { console.error('[rig] no app page in the CfT browser — run cft-launch.sh + cft-connect.mjs first'); process.exit(2); }
const log = (m) => console.log(`[rig] ${m}`);

async function openModal() {
  if (await page.getByRole('button', { name: 'Capture', exact: true }).isVisible().catch(() => false)) return;
  const auto = page.getByRole('button', { name: /Auto-map \(camera\)/ });
  if (!(await auto.nth(strip - 1).isVisible().catch(() => false))) {
    const show = page.getByRole('button', { name: /Show Settings/i }).first();
    if (await show.isVisible().catch(() => false)) await show.click();
  }
  await auto.nth(strip - 1).click({ timeout: 15000 });
  await page.getByRole('button', { name: 'Capture', exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);                 // camera warm-up / auto-exposure settle
}

const results = [];
for (let r = 1; r <= runs; r++) {
  await openModal();
  const before = await page.evaluate(() => window.__chromabayAutoLayout?.at ?? 0);
  log(`run ${r}/${runs}: Capture`);
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  const res = await page.waitForFunction((t) => (window.__chromabayAutoLayout?.at ?? 0) > t && window.__chromabayAutoLayout,
    before, { timeout: 120000, polling: 500 }).then((h) => h.jsonValue());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const b64 = await page.evaluate(() => window.__chromabayAutoLayoutDump?.());
  if (b64) writeFileSync(`${out}/run-${stamp}.bin`, Buffer.from(b64, 'base64'));
  let verdict = '';
  if (expect && res.layout) verdict = matches(res.layout, expect) ? 'MATCH' : 'MISMATCH';
  writeFileSync(`${out}/run-${stamp}.json`, JSON.stringify({ expect, verdict, ...res }, null, 1));
  log(`run ${r}: found ${res.found}/${res.numLeds} at flash ${res.brightness} (${res.kind}), layout ${res.layout?.width}x${res.layout?.height} ${verdict}`);
  results.push({ found: res.found, n: res.numLeds, verdict });
  await page.getByRole('button', { name: 'Reframe' }).click().catch(() => {});
}
const ok = results.filter((x) => x.verdict === 'MATCH').length;
log(`done: ${expect ? `${ok}/${runs} runs matched ${expect}` : `${results.map((x) => `${x.found}/${x.n}`).join(', ')}`} — artifacts in ${out}/`);
process.exit(expect && ok < runs ? 1 : 0);

// Same comparison as autoLayoutSim.scoreLedmap (kept dependency-free so this runs as plain .mjs).
function matches(got, ex) {
  const m = /^(\d+)x(\d+)(s?)$/.exec(ex); if (!m) throw new Error('bad --expect, want e.g. 16x16 or 16x16s');
  const W = +m[1], H = +m[2], map = new Array(W * H);
  for (let r = 0, i = 0; r < H; r++) for (let k = 0; k < W; k++, i++) map[r * W + (m[3] && r % 2 ? W - 1 - k : k)] = i;
  const rot = (l) => { const o = new Array(l.map.length); for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) o[x * l.height + (l.height - 1 - y)] = l.map[y * l.width + x]; return { width: l.height, height: l.width, map: o }; };
  const flip = (l) => { const o = new Array(l.map.length); for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) o[y * l.width + (l.width - 1 - x)] = l.map[y * l.width + x]; return { ...l, map: o }; };
  let cur = got;
  for (let k = 0; k < 4; k++, cur = rot(cur)) for (const g of [cur, flip(cur)])
    if (g.width === W && g.height === H && g.map.every((v, i) => v === map[i])) return true;
  return false;
}
