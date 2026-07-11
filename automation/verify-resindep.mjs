// Prove blur is resolution-independent: blur the same normalized pattern at 32px and 64px,
// downsample the 64px result 2x2 back to 32px, and compare to the 32px result. Resolution-
// independent ⇒ the two are close (relative to the blur's magnitude).
import { chromium } from 'playwright';
const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage();
page.on('pageerror', e => console.error('[browser:error]', e.message));
await page.goto(APP_URL, { waitUntil: 'load', timeout: 25000 });
await page.waitForFunction(() => window.isWasmReady && window.isWasmReady(), { timeout: 25000 });
const res = await page.evaluate(() => {
  const m = window.getWasmModule();
  const render = (op, inPtr, outPtr, w, h) => m.ccall('renderOperator', null,
    ['number','number','number','number','number','number','number','number'],
    [op, inPtr, 0, outPtr, w, h, 123456, 16]);
  const gen = (w,h) => { // rainbow → buffer (returns JS array of bytes)
    const n=w*h*3, in1=m._malloc(n);
    const rb=m.ccall('createOperatorInstance','number',['string'],['rainbow']);
    render(rb,0,in1,w,h);
    const a=new Uint8Array(n); for(let i=0;i<n;i++)a[i]=m.HEAPU8[in1+i]; m._free(in1); return a;
  };
  const blur = (w,h) => {
    const n=w*h*3, in1=m._malloc(n), out=m._malloc(n);
    const rb=m.ccall('createOperatorInstance','number',['string'],['rainbow']); render(rb,0,in1,w,h);
    const bl=m.ccall('createOperatorInstance','number',['string'],['blur']); render(bl,in1,out,w,h); // default radius 0.12
    const a=new Uint8Array(n); for(let i=0;i<n;i++)a[i]=m.HEAPU8[out+i]; m._free(in1); m._free(out); return a;
  };
  const down = (a,W,H) => { // box-downsample WxH → (W/2)x(H/2)
    const w=W/2,h=H/2, o=new Uint8Array(w*h*3);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++){
      const s=a[((2*y)*W+2*x)*3+c]+a[((2*y)*W+2*x+1)*3+c]+a[((2*y+1)*W+2*x)*3+c]+a[((2*y+1)*W+2*x+1)*3+c];
      o[(y*w+x)*3+c]=Math.round(s/4);
    } return o;
  };
  const mad = (p,q)=>{let s=0;for(let i=0;i<p.length;i++)s+=Math.abs(p[i]-q[i]);return s/p.length;};

  const g32=gen(32,32), g64d=down(gen(64,64),64,64);
  const baseMatch = mad(g32,g64d);                 // sanity: rainbow itself matches across res
  const bl32=blur(32,32), bl64d=down(blur(64,64),64,64);
  const blurMatch = mad(bl32,bl64d);               // the real test
  const blurMagnitude = mad(bl32,g32);             // how much blur changed the image at 32px
  return { baseMatch, blurMatch, blurMagnitude };
});
console.log(JSON.stringify(res,null,2));
// Resolution-independent if the 32px blur and downsampled-64px blur are close — i.e. the
// cross-resolution difference is small compared to how much the blur actually did.
const ok = res.blurMatch < res.blurMagnitude * 0.6 && res.blurMagnitude > 1;
console.log(ok ? '\x1b[32m✅ blur looks the same across resolutions (cross-res diff ≪ blur magnitude)\x1b[0m'
              : '\x1b[31m❌ blur differs across resolutions\x1b[0m');
await b.close(); process.exit(ok?0:1);
