#!/usr/bin/env node
// Headless WASM RENDER check — stronger than verify-wasm.mjs (which only proves
// operators enumerate). This proves operators actually RENDER non-black output
// AND ANIMATE (output changes over time). Catches the "black/frozen preview"
// class of bug, and is unit-agnostic about the timestamp scale (it just checks
// that the frame varies across a spread of timestamps).
//
// Usage:  npm run verify:render   (needs the dev server running + Chrome)
// Exit 0 = every checked operator renders ink and animates.

import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const TIMEOUT = Number(process.env.WASM_TIMEOUT || 25000);
const OPS = (process.env.OPS || 'chase,rainbow').split(',');

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(bad('[browser:error]'), e.message));

  await page.goto(APP_URL, { waitUntil: 'load', timeout: TIMEOUT });
  await page.waitForFunction(() => window.isWasmReady && window.isWasmReady(), { timeout: TIMEOUT });

  const results = await page.evaluate((ops) => {
    const m = window.getWasmModule();
    if (!m) return { error: 'getWasmModule() null' };
    const w = 16, h = 16, n = w * h * 3;
    // A spread of timestamps; odd values avoid accidentally landing on the same
    // phase regardless of the operator's internal time-unit scaling.
    const TS = [0, 123456, 333333, 654321, 999983, 1500007];
    const out = m._malloc(n);
    const report = {};
    try {
      for (const type of ops) {
        const inst = m.ccall('createOperatorInstance', 'number', ['string'], [type]);
        if (inst === -1 || inst === undefined) { report[type] = { error: 'no instance' }; continue; }
        const frames = [];
        for (const ts of TS) {
          m.ccall('renderOperator', null,
            ['number','number','number','number','number','number','number','number'],
            [inst, 0, 0, out, w, h, ts, 16]);
          let ink = 0, hash = 0;
          for (let i = 0; i < n; i++) { const b = m.HEAPU8[out + i]; ink += b; hash = (hash * 31 + b) >>> 0; }
          frames.push({ ts, ink, hash });
        }
        m.ccall('destroyOperatorInstance', null, ['number'], [inst]);
        const maxInk = Math.max(...frames.map(f => f.ink));
        const distinct = new Set(frames.map(f => f.hash)).size;
        report[type] = { maxInk, distinctFrames: distinct, totalFrames: frames.length };
      }
    } finally {
      m._free(out);
    }
    return report;
  }, OPS);

  await browser.close();

  if (results.error) { console.error(bad('❌ ' + results.error)); process.exit(1); }
  let allGood = true;
  for (const type of OPS) {
    const r = results[type] || { error: 'missing' };
    if (r.error) { console.error(bad(`❌ ${type}: ${r.error}`)); allGood = false; continue; }
    const renders = r.maxInk > 0;
    const animates = r.distinctFrames > 1;
    const tag = renders && animates ? ok('✓') : bad('✗');
    console.log(`${tag} ${type}: ink=${r.maxInk} distinctFrames=${r.distinctFrames}/${r.totalFrames} ` +
      `(${renders ? 'renders' : 'BLACK'}, ${animates ? 'animates' : 'FROZEN'})`);
    if (!renders || !animates) allGood = false;
  }
  if (allGood) { console.log(ok('✅ all operators render non-black and animate')); process.exit(0); }
  console.error(bad('❌ at least one operator is black or frozen')); process.exit(1);
} catch (err) {
  console.error(bad(`❌ verify-render failed: ${err.message}`));
  await browser?.close().catch(() => {});
  process.exit(1);
}
