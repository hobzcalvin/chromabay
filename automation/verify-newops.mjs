import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage();
page.on('pageerror', e => console.error('[browser:error]', e.message));
await page.goto(process.env.APP_URL || 'http://localhost:5173/', { waitUntil: 'load', timeout: 25000 });
await page.waitForFunction(() => window.isWasmReady && window.isWasmReady(), { timeout: 25000 });
const res = await page.evaluate(() => {
  const m = window.getWasmModule();
  const w=24,h=24,n=w*h*3;
  const R=(op,i,o,ts,dt)=>m.ccall('renderOperator',null,['number','number','number','number','number','number','number','number'],[op,i,0,o,w,h,ts,dt]);
  const ink=(p)=>{let s=0;for(let i=0;i<n;i++)s+=m.HEAPU8[p+i];return s;};
  const hash=(p)=>{let x=0;for(let i=0;i<n;i++)x=(x*31+m.HEAPU8[p+i])>>>0;return x;};
  const out=m._malloc(n), in1=m._malloc(n);

  // Interference: renders ink + animates (two timestamps differ)
  const intf=m.ccall('createOperatorInstance','number',['string'],['interference']);
  R(intf,0,out,100,16); const iInk=ink(out), iH1=hash(out);
  R(intf,0,out,3000,16); const iH2=hash(out);

  // Feedback: fill input white for frame 0, then black — content must persist (memory).
  const fb=m.ccall('createOperatorInstance','number',['string'],['feedback']);
  for(let i=0;i<n;i++)m.HEAPU8[in1+i]=255;
  R(fb,in1,out,0,100); const f0=ink(out);
  for(let i=0;i<n;i++)m.HEAPU8[in1+i]=0;         // input goes dark
  let f_last=0; for(let k=1;k<=8;k++){ R(fb,in1,out,k*100,100); f_last=ink(out); }

  m._free(out); m._free(in1);
  return { iInk, iAnim: iH1!==iH2, f0, f_last };
});
console.log(JSON.stringify(res,null,2));
const ok = res.iInk>0 && res.iAnim && res.f0>0 && res.f_last > res.f0*0.3 && res.f_last < res.f0;
console.log(ok?'\x1b[32m✅ interference renders+animates; feedback remembers past frames (persists+decays)\x1b[0m'
             :'\x1b[31m❌ unexpected\x1b[0m');
await b.close(); process.exit(ok?0:1);
