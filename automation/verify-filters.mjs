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
  const in1 = m._malloc(n), out = m._malloc(n);
  const R = (op, inPtr, outPtr, ts) => m.ccall('renderOperator', null,
    ['number','number','number','number','number','number','number','number'],
    [op, inPtr, 0, outPtr, w, h, ts, 16]);
  // horizontal-neighbor absolute difference summed over the frame (high = lots of detail/edges)
  const variance = (ptr) => { let s=0; for (let y=0;y<h;y++) for (let x=0;x<w-1;x++){ const i=(y*w+x)*3, j=(y*w+x+1)*3;
    s += Math.abs(m.HEAPU8[ptr+i]-m.HEAPU8[ptr+j]) + Math.abs(m.HEAPU8[ptr+i+1]-m.HEAPU8[ptr+j+1]) + Math.abs(m.HEAPU8[ptr+i+2]-m.HEAPU8[ptr+j+2]); } return s; };
  const ink = (ptr) => { let s=0; for (let i=0;i<n;i++) s+=m.HEAPU8[ptr+i]; return s; };
  const diff = (a,bp) => { let s=0; for (let i=0;i<n;i++) s+=Math.abs(m.HEAPU8[a+i]-m.HEAPU8[bp+i]); return s; };

  const rb = m.ccall('createOperatorInstance','number',['string'],['rainbow']);
  R(rb, 0, in1, 123456);                       // generate a rainbow into in1
  const inVar = variance(in1), inInk = ink(in1);

  const blur = m.ccall('createOperatorInstance','number',['string'],['blur']);
  R(blur, in1, out, 123456);
  const blurVar = variance(out), blurInk = ink(out), blurDiff = diff(in1,out);

  const conv = m.ccall('createOperatorInstance','number',['string'],['convolve']); // default preset = Sharpen
  R(conv, in1, out, 123456);
  const convVar = variance(out), convInk = ink(out), convDiff = diff(in1,out);

  m._free(in1); m._free(out);
  return { inVar, inInk, blurVar, blurInk, blurDiff, convVar, convInk, convDiff };
});
console.log(JSON.stringify(res, null, 2));
const ok = res.inInk>0 && res.blurInk>0 && res.blurVar < res.inVar && res.blurDiff>0 && res.convDiff>0 && res.convVar >= res.inVar;
console.log(ok ? '\x1b[32m✅ blur smooths (var down), convolve/sharpen adds edges (var up), both non-black\x1b[0m'
              : '\x1b[31m❌ unexpected filter behavior\x1b[0m');
await b.close();
process.exit(ok?0:1);
