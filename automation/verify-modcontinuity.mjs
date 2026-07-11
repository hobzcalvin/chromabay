// Prove a LIVE period change doesn't snap the modulated value. Modulate svgfill's hue with a
// sine, render every 100ms tracking mean-R, and halfway through change the period. With the
// phase-continuity fix, mean-R keeps moving smoothly; the old tMs/period phase would jump.
import { chromium } from 'playwright';
const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage();
page.on('pageerror', e => console.error('[browser:error]', e.message));
await page.goto(APP_URL, { waitUntil: 'load', timeout: 25000 });
await page.waitForFunction(() => window.isWasmReady && window.isWasmReady(), { timeout: 25000 });
const res = await page.evaluate(() => {
  const m = window.getWasmModule();
  const w = 24, h = 24, n = w*h*3;
  const out = m._malloc(n);
  const inst = m.ccall('createOperatorInstance','number',['string'],['svgfill']);
  // Modulate param 5 (hue) with SINE (0), range 0..255, period 5s.
  const setMod = (period) => m.ccall('setOperatorModulator', null,
    ['number','number','number','number','number','number'], [inst, 5, 0, 0, 255, period]);
  const meanR = () => { let s=0; for (let i=0;i<n;i+=3) s+=m.HEAPU8[out+i]; return s/(n/3); };
  setMod(5.0);
  const series = [];
  const CHANGE_AT = 30; // frame index where we drop the period 5s -> 3s
  for (let k=0; k<60; k++) {
    if (k === CHANGE_AT) setMod(3.0);
    m.ccall('renderOperator', null, ['number','number','number','number','number','number','number','number'],
      [inst, 0, 0, out, w, h, k*100, 100]);   // t = k*100 ms
    series.push(meanR());
  }
  m._free(out);
  // Frame-to-frame absolute change; the change frame shouldn't be a wild outlier.
  const d = series.slice(1).map((v,i)=>Math.abs(v-series[i]));
  const sorted=[...d].sort((a,b)=>a-b); const median=sorted[Math.floor(sorted.length/2)]||0.001;
  const changeStep = d[CHANGE_AT-1];      // delta straddling the period change
  const maxStep = Math.max(...d);
  return { median, changeStep, maxStep, sample: series.slice(CHANGE_AT-2, CHANGE_AT+3).map(x=>+x.toFixed(1)) };
});
console.log(JSON.stringify(res,null,2));
// Continuous ⇒ the change-frame delta is in-family with normal frame deltas (not a snap).
const ok = res.changeStep <= Math.max(res.median*3, res.maxStep*0.9 + 1) && res.maxStep < 120;
console.log(ok ? '\x1b[32m✅ period change is continuous — no snap\x1b[0m'
              : '\x1b[31m❌ modulated value jumped at the period change\x1b[0m');
await b.close(); process.exit(ok?0:1);
