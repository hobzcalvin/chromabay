
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="acb3107e-e6b5-5027-a3b7-c7e22bb43055")}catch(e){}}();
import{w as o}from"./DhkHA5kK.js";const n=new Map,a=o([]),s=()=>a.set([...n.values()]);function c(r){let e;try{e=JSON.stringify(r)}catch{e="x"+Math.random()}let t=5381;for(let i=0;i<e.length;i++)t=(t<<5)+t^e.charCodeAt(i)|0;return`${(t>>>0).toString(36)}.${e.length}`}function u(r){const e=c(r);let t=n.get(e);return t||(t={key:e,pattern:r,refCount:0,frame:null},n.set(e,t),s()),t.refCount++,e}function l(r){const e=n.get(r);e&&--e.refCount<=0&&(n.delete(r),s())}function g(r,e){const t=n.get(r);t&&(t.frame=e)}function h(r){return n.get(r)}export{u as a,g as b,a as c,h as p,l as r};
//# sourceMappingURL=DxHG_Y5I.js.map

//# debugId=acb3107e-e6b5-5027-a3b7-c7e22bb43055
