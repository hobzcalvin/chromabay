
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="02d66561-f9f6-5c40-8d89-3d4912ec5248")}catch(e){}}();
import{g as e,w as f}from"./DMuXAWdp.js";import{c as r,s as y,g as p}from"./jVZzSm30.js";const n=f(!1),i=f(30);async function u(){const s=Math.max(1,Math.floor(e(i)||1));i.set(s);const o=e(n);for(const c of p(e(r)))try{await y(c.deviceId,o,s)}catch(t){console.error("[cycle] apply failed for",c.deviceId,t)}}async function w(){e(n)&&(n.set(!1),await u())}let l=new Set;r.subscribe(s=>{const o=new Set(s.keys()),c=[...o].filter(t=>!l.has(t));l=o,c.length!==0&&setTimeout(()=>{const t=e(n),d=Math.max(1,Math.floor(e(i)||1));for(const a of c)e(r).has(a)&&y(a,t,d).catch(h=>console.error("[cycle] apply-on-connect failed",a,h))},1500)});export{u as a,n as b,i as c,w as e};
//# sourceMappingURL=B1an2FX0.js.map

//# debugId=02d66561-f9f6-5c40-8d89-3d4912ec5248
