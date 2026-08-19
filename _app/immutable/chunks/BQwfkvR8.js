
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="be32a65a-5e43-53b2-b415-8e30aac58473")}catch(e){}}();
import{u as n,r as s,i as k,h as u}from"./CdHCThrA.js";import{l as h}from"./t9P6muLQ.js";function t(e,a,v=a){var c=k();h(e,"input",l=>{var r=l?e.defaultValue:e.value;if(r=f(e)?d(r):r,v(r),c&&r!==(r=a())){var _=e.selectionStart,o=e.selectionEnd;e.value=r??"",o!==null&&(e.selectionStart=_,e.selectionEnd=Math.min(o,e.value.length))}}),(u&&e.defaultValue!==e.value||n(a)==null&&e.value)&&v(f(e)?d(e.value):e.value),s(()=>{var l=a();f(e)&&l===d(e.value)||e.type==="date"&&!l&&!e.value||l!==e.value&&(e.value=l??"")})}function y(e,a,v=a){h(e,"change",c=>{var l=c?e.defaultChecked:e.checked;v(l)}),(u&&e.defaultChecked!==e.checked||n(a)==null)&&v(e.checked),s(()=>{var c=a();e.checked=!!c})}function f(e){var a=e.type;return a==="number"||a==="range"}function d(e){return e===""?null:+e}export{y as a,t as b};
//# sourceMappingURL=BQwfkvR8.js.map

//# debugId=be32a65a-5e43-53b2-b415-8e30aac58473
