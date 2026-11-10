
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="4dda336a-ea45-5686-bd23-af233a097252")}catch(e){}}();
const o=.45454545454545453,i=new Uint8ClampedArray(256);for(let t=0;t<256;t++)i[t]=Math.round(255*Math.pow(t/255,o));function r(t,n=t){const a=t.data,h=n.data;for(let e=0;e<a.length;e+=4)h[e]=i[a[e]],h[e+1]=i[a[e+1]],h[e+2]=i[a[e+2]],h[e+3]=a[e+3];return n}function l(){let t=null;return n=>((!t||t.width!==n.width||t.height!==n.height)&&(t=new ImageData(n.width,n.height)),r(n,t))}export{r as l,l as s};
//# sourceMappingURL=BWuiKbVV.js.map

//# debugId=4dda336a-ea45-5686-bd23-af233a097252
