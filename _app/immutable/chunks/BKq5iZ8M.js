
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="e0a64ca7-7a3a-55c8-bcaa-358fb1d554c8")}catch(e){}}();
import{g as d,i as T,a as l,b as S,c as m,d as y,s as u,h as C,e as f,f as H,j as x,k as D,T as E,l as I,m as b,n as P,o as A}from"./B02LB3Sw.js";function F(a={}){const e=a.client||d();if(!T()||!e)return{};const r=l(),n=S(r);if(n.getTraceData)return n.getTraceData(a);const c=a.scope||m(),t=a.span||y(),s=u(t)&&!C(e.getOptions()),o=t&&!s?f(t):R(c),p=t?H(t):x(e,c),i=D(p);if(!E.test(o))return I.warn("Invalid sentry-trace data. Cannot generate trace data"),{};const g={"sentry-trace":o,baggage:i};return a.propagateTraceparent&&(g.traceparent=t&&!s?b(t):h(c)),g}function R(a){const{traceId:e,sampled:r,propagationSpanId:n}=a.getPropagationContext();return P(e,n,r)}function h(a){const{traceId:e,sampled:r,propagationSpanId:n}=a.getPropagationContext();return A(e,n,r)}export{F as g};
//# sourceMappingURL=BKq5iZ8M.js.map

//# debugId=e0a64ca7-7a3a-55c8-bcaa-358fb1d554c8
