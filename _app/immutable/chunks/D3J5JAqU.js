
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="92afb1ae-74d9-5e43-b4ae-4e6af2329fa9")}catch(e){}}();
import{g as s,w as l}from"./COOuGChC.js";import{c as i,s as d,g as C}from"./C2YcWJui.js";const o=l(!1),y=l(30),h=l(0);function u(){const e=Math.max(1,Math.floor(s(y)||1)),c=Math.min(Math.max(0,s(h)||0),e/2);return{secs:e,fade:c}}async function g(){const{secs:e,fade:c}=u();y.set(e),h.set(c);const n=s(o);for(const t of C(s(i)))try{await d(t.deviceId,n,e,c)}catch(a){console.error("[cycle] apply failed for",t.deviceId,a)}}async function b(){s(o)&&(o.set(!1),await g())}let f=new Set;i.subscribe(e=>{const c=new Set(e.keys()),n=[...c].filter(t=>!f.has(t));f=c,n.length!==0&&setTimeout(()=>{const t=s(o),{secs:a,fade:m}=u();for(const r of n)s(i).has(r)&&d(r,t,a,m).catch(p=>console.error("[cycle] apply-on-connect failed",r,p))},1500)});export{g as a,h as b,y as c,o as d,b as e};
//# sourceMappingURL=D3J5JAqU.js.map

//# debugId=92afb1ae-74d9-5e43-b4ae-4e6af2329fa9
