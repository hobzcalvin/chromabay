#!/usr/bin/env node
// Headless WASM health check — no human, no hardware, no Bluetooth.
//
// Loads the running app in headless Chrome, waits for the FastLED WASM module to
// boot (window.isWasmReady), and asserts the operator registry is non-empty.
// A non-empty operator list == the "Add Node" menu will be populated. An empty
// list (or a module that fails to load) == broken WASM. Exit 0 = healthy.
//
// This is the gate to run BEFORE claiming a WASM change works.
//
// Usage:
//   npm run verify:wasm                       # against APP_URL (default :5173)
//   APP_URL=http://localhost:5174/ npm run verify:wasm
//
// Requires the dev server (or any served build) to be running.

import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const TIMEOUT = Number(process.env.WASM_TIMEOUT || 25000);

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const wasmErrors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/WASM|operator|fastled/i.test(t)) console.log('  [browser]', t);
    if (m.type() === 'error' && /WASM|fastled|operator/i.test(t)) wasmErrors.push(t);
  });
  page.on('pageerror', (e) => wasmErrors.push(e.message));

  console.log(`[verify] loading ${APP_URL} …`);
  await page.goto(APP_URL, { waitUntil: 'load', timeout: TIMEOUT });

  // The module boots on window 'load' (see src/app.html), independent of route.
  await page.waitForFunction(() => window.isWasmReady && window.isWasmReady(), { timeout: TIMEOUT });

  const result = await page.evaluate(() => {
    const m = window.getWasmModule();
    if (!m) return { error: 'getWasmModule() returned null' };
    const count = m.ccall('getOperatorCount', 'number', [], []);
    const names = [];
    for (let i = 0; i < count; i++) {
      names.push(m.ccall('getOperatorName', 'string', ['number'], [i]));
    }
    return { count, names };
  });

  await browser.close();

  if (result.error) {
    console.error(bad(`❌ ${result.error}`));
    process.exit(1);
  }
  console.log(`[verify] operatorCount = ${result.count}`);
  console.log(`[verify] operators: ${result.names.join(', ') || '(none)'}`);
  if (result.count > 0) {
    console.log(ok(`✅ WASM healthy — Add Node menu will list ${result.count} operators.`));
    process.exit(0);
  }
  console.error(bad('❌ WASM loaded but 0 operators — Add Node menu would be EMPTY.'));
  process.exit(1);
} catch (err) {
  console.error(bad(`❌ verify failed: ${err.message}`));
  console.error('   (is the dev server running at APP_URL? is Chrome installed?)');
  await browser?.close().catch(() => {});
  process.exit(1);
}
