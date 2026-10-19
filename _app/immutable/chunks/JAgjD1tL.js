
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="0f684e44-30c5-5729-8938-afcdf530425a")}catch(e){}}();
import{g as me,D as Pe,l as ie,c as Ve,G as yt,A as qt,B as jt,E as Xt}from"./CFukIalK.js";const et=[];function Zt(e){const t={};return e.forEach(r=>{const{name:n}=r,o=t[n];o&&!o.isDefaultInstance&&r.isDefaultInstance||(t[n]=r)}),Object.values(t)}function fn(e){const t=e.defaultIntegrations||[],r=e.integrations;t.forEach(o=>{o.isDefaultInstance=!0});let n;if(Array.isArray(r))n=[...t,...r];else if(typeof r=="function"){const o=r(t);n=Array.isArray(o)?o:[o]}else n=t;return Zt(n)}function hn(e,t){const r={};return t.forEach(n=>{n!=null&&n.beforeSetup&&n.beforeSetup(e)}),t.forEach(n=>{n&&Yt(e,n,r)}),r}function pn(e,t){for(const r of t)r!=null&&r.afterAllSetup&&r.afterAllSetup(e)}function Yt(e,t,r){if(r[t.name]){Pe&&ie.log(`Integration skipped because it was already installed: ${t.name}`);return}if(r[t.name]=t,!et.includes(t.name)&&typeof t.setupOnce=="function"&&(t.setupOnce(),et.push(t.name)),t.setup&&typeof t.setup=="function"&&t.setup(e),typeof t.preprocessEvent=="function"){const n=t.preprocessEvent.bind(t);e.on("preprocessEvent",(o,a)=>n(o,a,e))}if(typeof t.processEvent=="function"){const n=t.processEvent.bind(t),o=Object.assign((a,c)=>n(a,c,e),{id:t.name});e.addEventProcessor(o)}["processSpan","processSegmentSpan"].forEach(n=>{const o=t[n];typeof o=="function"&&e.on(n,a=>o.call(t,a,e))}),Pe&&ie.log(`Integration installed: ${t.name}`)}function tt(e){const t=me();if(!t){Pe&&ie.warn(`Cannot add integration "${e.name}" because no SDK Client is available.`);return}t.addIntegration(e)}function gn(e){return e}function Kt(e,t={},r=Ve()){const{message:n,name:o,email:a,url:c,source:s,associatedEventId:u,tags:l}=e,d={contexts:{feedback:{contact_email:a,name:o,message:n,url:c,source:s,associated_event_id:u}},type:"feedback",level:"info",tags:l},i=(r==null?void 0:r.getClient())||me();return i&&i.emit("beforeSendFeedback",d,t),r.captureEvent(d,t)}const Et=yt;function Jt(){try{return Et.document.location.href}catch{return""}}function mn(e,t=5){if(!Et.HTMLElement)return null;let r=e;for(let n=0;n<t;n++){if(!r)return null;if(r instanceof HTMLElement){if(r.dataset.sentryComponent)return r.dataset.sentryComponent;if(r.dataset.sentryElement)return r.dataset.sentryElement}r=r.parentNode}return null}const j=yt,w=j.document,pe=j.navigator,Ct="Report a Bug",Qt="Cancel",er="Send Bug Report",tr="Confirm",rr="Report a Bug",nr="your.email@example.org",or="Email",ar="What's the bug? What did you expect?",ir="Description",cr="Your Name",lr="Name",sr="Thank you for your report!",_r="(required)",ur="Add a screenshot",dr="Remove screenshot",fr="Highlight",hr="Hide",pr="Remove",wt="Unable to submit feedback with empty message",xt="No client setup, cannot send feedback.",St="Unable to determine if Feedback was correctly sent.",kt="Unable to send feedback. This could be because this domain is not in your list of allowed domains.",Tt="Unable to send feedback. This could be because of network issues, or because you are using an ad-blocker.",gr="widget",mr="api",br=5e3,vr={ERROR_EMPTY_MESSAGE:wt,ERROR_NO_CLIENT:xt,ERROR_TIMEOUT:St,ERROR_FORBIDDEN:kt,ERROR_GENERIC:Tt};function ke(e,t){return(t==null?void 0:t[e])??vr[e]}function rt(e,t){return new Error(ke(e,t))}const yr=(e,t={includeReplay:!0})=>{const r=t.errorMessages;if(!e.message)throw rt("ERROR_EMPTY_MESSAGE",r);const n=me();if(!n)throw rt("ERROR_NO_CLIENT",r);e.tags&&Object.keys(e.tags).length&&Ve().setTags(e.tags);const o=Kt({source:mr,url:Jt(),...e},t);return new Promise((a,c)=>{const s=setTimeout(()=>{u(),c(ke("ERROR_TIMEOUT",r))},3e4),u=n.on("afterSendEvent",(l,d)=>{if(l.event_id===o)return clearTimeout(s),u(),d!=null&&d.statusCode&&d.statusCode>=200&&d.statusCode<300?a(o):(d==null?void 0:d.statusCode)===403?c(ke("ERROR_FORBIDDEN",r)):c(ke("ERROR_GENERIC",r))})})},Te=typeof __SENTRY_DEBUG__>"u"||__SENTRY_DEBUG__;function Er(){return!(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(pe.userAgent)||/Macintosh/i.test(pe.userAgent)&&pe.maxTouchPoints&&pe.maxTouchPoints>1||!isSecureContext)}function we(e,t){return{...e,...t,tags:{...e.tags,...t.tags},onFormOpen:()=>{var r,n;(r=t.onFormOpen)==null||r.call(t),(n=e.onFormOpen)==null||n.call(e)},onFormClose:()=>{var r,n;(r=t.onFormClose)==null||r.call(t),(n=e.onFormClose)==null||n.call(e)},onSubmitSuccess:(r,n)=>{var o,a;(o=t.onSubmitSuccess)==null||o.call(t,r,n),(a=e.onSubmitSuccess)==null||a.call(e,r,n)},onSubmitError:r=>{var n,o;(n=t.onSubmitError)==null||n.call(t,r),(o=e.onSubmitError)==null||o.call(e,r)},onFormSubmitted:()=>{var r,n;(r=t.onFormSubmitted)==null||r.call(t),(n=e.onFormSubmitted)==null||n.call(e)},themeDark:{...e.themeDark,...t.themeDark},themeLight:{...e.themeLight,...t.themeLight}}}function Cr(e){const t=w.createElement("style");return t.textContent=`
.widget__actor {
  position: fixed;
  z-index: var(--z-index);
  margin: var(--page-margin);
  inset: var(--actor-inset);

  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;

  font-family: inherit;
  font-size: var(--font-size);
  font-weight: 600;
  line-height: 1.14em;
  text-decoration: none;

  background: var(--actor-background, var(--background));
  border-radius: var(--actor-border-radius, 1.7em/50%);
  border: var(--actor-border, var(--border));
  box-shadow: var(--actor-box-shadow, var(--box-shadow));
  color: var(--actor-color, var(--foreground));
  fill: var(--actor-color, var(--foreground));
  cursor: pointer;
  opacity: 1;
  transition: transform 0.2s ease-in-out;
  transform: translate(0, 0) scale(1);
}
.widget__actor[aria-hidden="true"] {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transform: translate(0, 16px) scale(0.98);
}

.widget__actor:hover {
  background: var(--actor-hover-background, var(--background));
  filter: var(--interactive-filter);
}

.widget__actor svg {
  width: 1.14em;
  height: 1.14em;
}

@media (max-width: 600px) {
  .widget__actor span {
    display: none;
  }
}
`,e&&t.setAttribute("nonce",e),t}function G(e,t){return Object.entries(t).forEach(([r,n])=>{e.setAttributeNS(null,r,n)}),e}const _e=20,wr="http://www.w3.org/2000/svg";function xr(){const e=s=>j.document.createElementNS(wr,s),t=G(e("svg"),{width:`${_e}`,height:`${_e}`,viewBox:`0 0 ${_e} ${_e}`,fill:"var(--actor-color, var(--foreground))"}),r=G(e("g"),{clipPath:"url(#clip0_57_80)"}),n=G(e("path"),{"fill-rule":"evenodd","clip-rule":"evenodd",d:"M15.6622 15H12.3997C12.2129 14.9959 12.031 14.9396 11.8747 14.8375L8.04965 12.2H7.49956V19.1C7.4875 19.3348 7.3888 19.5568 7.22256 19.723C7.05632 19.8892 6.83435 19.9879 6.59956 20H2.04956C1.80193 19.9968 1.56535 19.8969 1.39023 19.7218C1.21511 19.5467 1.1153 19.3101 1.11206 19.0625V12.2H0.949652C0.824431 12.2017 0.700142 12.1783 0.584123 12.1311C0.468104 12.084 0.362708 12.014 0.274155 11.9255C0.185602 11.8369 0.115689 11.7315 0.0685419 11.6155C0.0213952 11.4995 -0.00202913 11.3752 -0.00034808 11.25V3.75C-0.00900498 3.62067 0.0092504 3.49095 0.0532651 3.36904C0.0972798 3.24712 0.166097 3.13566 0.255372 3.04168C0.344646 2.94771 0.452437 2.87327 0.571937 2.82307C0.691437 2.77286 0.82005 2.74798 0.949652 2.75H8.04965L11.8747 0.1625C12.031 0.0603649 12.2129 0.00407221 12.3997 0H15.6622C15.9098 0.00323746 16.1464 0.103049 16.3215 0.278167C16.4966 0.453286 16.5964 0.689866 16.5997 0.9375V3.25269C17.3969 3.42959 18.1345 3.83026 18.7211 4.41679C19.5322 5.22788 19.9878 6.32796 19.9878 7.47502C19.9878 8.62209 19.5322 9.72217 18.7211 10.5333C18.1345 11.1198 17.3969 11.5205 16.5997 11.6974V14.0125C16.6047 14.1393 16.5842 14.2659 16.5395 14.3847C16.4948 14.5035 16.4268 14.6121 16.3394 14.7042C16.252 14.7962 16.147 14.8698 16.0307 14.9206C15.9144 14.9714 15.7891 14.9984 15.6622 15ZM1.89695 10.325H1.88715V4.625H8.33715C8.52423 4.62301 8.70666 4.56654 8.86215 4.4625L12.6872 1.875H14.7247V13.125H12.6872L8.86215 10.4875C8.70666 10.3835 8.52423 10.327 8.33715 10.325H2.20217C2.15205 10.3167 2.10102 10.3125 2.04956 10.3125C1.9981 10.3125 1.94708 10.3167 1.89695 10.325ZM2.98706 12.2V18.1625H5.66206V12.2H2.98706ZM16.5997 9.93612V5.01393C16.6536 5.02355 16.7072 5.03495 16.7605 5.04814C17.1202 5.13709 17.4556 5.30487 17.7425 5.53934C18.0293 5.77381 18.2605 6.06912 18.4192 6.40389C18.578 6.73866 18.6603 7.10452 18.6603 7.47502C18.6603 7.84552 18.578 8.21139 18.4192 8.54616C18.2605 8.88093 18.0293 9.17624 17.7425 9.41071C17.4556 9.64518 17.1202 9.81296 16.7605 9.90191C16.7072 9.91509 16.6536 9.9265 16.5997 9.93612Z"});t.appendChild(r).appendChild(n);const o=e("defs"),a=G(e("clipPath"),{id:"clip0_57_80"}),c=G(e("rect"),{width:`${_e}`,height:`${_e}`,fill:"white"});return a.appendChild(c),o.appendChild(a),t.appendChild(o).appendChild(a).appendChild(c),t}function Sr({triggerLabel:e,triggerAriaLabel:t,shadow:r,styleNonce:n}){const o=w.createElement("button");if(o.type="button",o.className="widget__actor",o.ariaHidden="false",o.ariaLabel=t||e||Ct,o.appendChild(xr()),e){const c=w.createElement("span");c.appendChild(w.createTextNode(e)),o.appendChild(c)}const a=Cr(n);return{el:o,appendToDom(){r.appendChild(a),r.appendChild(o)},removeFromDom(){o.remove(),a.remove()},show(){o.ariaHidden="false"},hide(){o.ariaHidden="true"}}}const Rt="rgba(88, 74, 192, 1)",kr={foreground:"#2b2233",background:"#ffffff",accentForeground:"white",accentBackground:Rt,successColor:"#268d75",errorColor:"#df3338",border:"1.5px solid rgba(41, 35, 47, 0.13)",boxShadow:"0px 4px 24px 0px rgba(43, 34, 51, 0.12)",outline:"1px auto var(--accent-background)",interactiveFilter:"brightness(95%)"},nt={foreground:"#ebe6ef",background:"#29232f",accentForeground:"white",accentBackground:Rt,successColor:"#2da98c",errorColor:"#f55459",border:"1.5px solid rgba(235, 230, 239, 0.15)",boxShadow:"0px 4px 24px 0px rgba(43, 34, 51, 0.12)",outline:"1px auto var(--accent-background)",interactiveFilter:"brightness(150%)"};function ot(e){return`
  --foreground: ${e.foreground};
  --background: ${e.background};
  --accent-foreground: ${e.accentForeground};
  --accent-background: ${e.accentBackground};
  --success-color: ${e.successColor};
  --error-color: ${e.errorColor};
  --border: ${e.border};
  --box-shadow: ${e.boxShadow};
  --outline: ${e.outline};
  --interactive-filter: ${e.interactiveFilter};
  `}function at({colorScheme:e,themeDark:t,themeLight:r,styleNonce:n}){const o=w.createElement("style");return o.textContent=`
:host {
  --font-family: system-ui, 'Helvetica Neue', Arial, sans-serif;
  --font-size: 14px;
  --z-index: 100000;

  --page-margin: 16px;
  --inset: auto 0 0 auto;
  --actor-inset: var(--inset);

  font-family: var(--font-family);
  font-size: var(--font-size);

  ${e!=="system"?`color-scheme: only ${e};`:""}

  ${ot(e==="dark"?{...nt,...t}:{...kr,...r})}
}

${e==="system"?`
@media (prefers-color-scheme: dark) {
  :host {
    color-scheme: only dark;

    ${ot({...nt,...t})}
  }
}`:""}
`,n&&o.setAttribute("nonce",n),o}const bn=({lazyLoadIntegration:e,getModalIntegration:t,getScreenshotIntegration:r})=>({id:o="sentry-feedback",autoInject:a=!0,showBranding:c=!0,isEmailRequired:s=!1,isNameRequired:u=!1,showEmail:l=!0,showName:d=!0,enableScreenshot:i=!0,useSentryUser:h={email:"email",name:"username"},tags:_,styleNonce:f,scriptNonce:v,colorScheme:b="system",themeLight:p={},themeDark:y={},addScreenshotButtonLabel:F=ur,cancelButtonLabel:k=Qt,confirmButtonLabel:V=tr,emailLabel:O=or,emailPlaceholder:A=nr,formTitle:z=rr,isRequiredLabel:L=_r,messageLabel:H=ir,messagePlaceholder:K=ar,nameLabel:m=lr,namePlaceholder:C=cr,removeScreenshotButtonLabel:I=dr,submitButtonLabel:$=er,successMessageText:re=sr,triggerLabel:le=Ct,triggerAriaLabel:N="",highlightToolText:B=fr,hideToolText:D=hr,removeHighlightText:W=pr,errorEmptyMessageText:ye=wt,errorNoClientText:J=xt,errorTimeoutText:Q=St,errorForbiddenText:Ee=kt,errorGenericText:Ut=Tt,onFormOpen:Pt,onFormClose:Gt,onSubmitSuccess:Ot,onSubmitError:zt,onFormSubmitted:Wt}={})=>{const ne={id:o,autoInject:a,showBranding:c,isEmailRequired:s,isNameRequired:u,showEmail:l,showName:d,enableScreenshot:i,useSentryUser:h,tags:_,styleNonce:f,scriptNonce:v,colorScheme:b,themeDark:y,themeLight:p,triggerLabel:le,triggerAriaLabel:N,cancelButtonLabel:k,submitButtonLabel:$,confirmButtonLabel:V,formTitle:z,emailLabel:O,emailPlaceholder:A,messageLabel:H,messagePlaceholder:K,nameLabel:m,namePlaceholder:C,successMessageText:re,isRequiredLabel:L,addScreenshotButtonLabel:F,removeScreenshotButtonLabel:I,highlightToolText:B,hideToolText:D,removeHighlightText:W,errorEmptyMessageText:ye,errorNoClientText:J,errorTimeoutText:Q,errorForbiddenText:Ee,errorGenericText:Ut,onFormClose:Gt,onFormOpen:Pt,onSubmitError:zt,onSubmitSuccess:Ot,onFormSubmitted:Wt};let X=null,se=null,he=[];const Ke=E=>{if(!X){const R=w.createElement("div");R.id=String(E.id),w.body.appendChild(R),X=R.attachShadow({mode:"open"}),se=at(E),X.appendChild(se)}return X},Je=async E=>{const R=E.enableScreenshot&&Er();let Z,U;try{Z=(t?t():await e("feedbackModalIntegration",v))(),tt(Z)}catch{throw Te&&ie.error("[Feedback] Error when trying to load feedback integrations. Try using `feedbackSyncIntegration` in your `Sentry.init`."),new Error("[Feedback] Missing feedback modal integration!")}try{const M=R?r?r():await e("feedbackScreenshotIntegration",v):void 0;M&&(U=M(),tt(U))}catch{Te&&ie.error("[Feedback] Missing feedback screenshot integration. Proceeding without screenshots.")}const P={ERROR_EMPTY_MESSAGE:E.errorEmptyMessageText,ERROR_NO_CLIENT:E.errorNoClientText,ERROR_TIMEOUT:E.errorTimeoutText,ERROR_FORBIDDEN:E.errorForbiddenText,ERROR_GENERIC:E.errorGenericText},Ce=(M,Vt)=>yr(M,{includeReplay:!0,...Vt,errorMessages:P}),q=Z.createDialog({options:{...E,onFormClose:()=>{var M;q==null||q.close(),(M=E.onFormClose)==null||M.call(E)},onFormSubmitted:()=>{var M;q==null||q.close(),(M=E.onFormSubmitted)==null||M.call(E)}},screenshotIntegration:U,sendFeedback:Ce,shadow:Ke(E)});return q},Qe=(E,R={})=>{const Z=we(ne,R),U=typeof E=="string"?w.querySelector(E):typeof E.addEventListener=="function"?E:null;if(!U)throw Te&&ie.error("[Feedback] Unable to attach to target element"),new Error("Unable to attach to target element");let P=null;const Ce=async()=>{P||(P=await Je({...Z,onFormSubmitted:()=>{var M;P==null||P.removeFromDom(),(M=Z.onFormSubmitted)==null||M.call(Z)}})),P.appendToDom(),P.open()};U.addEventListener("click",Ce);const q=()=>{he=he.filter(M=>M!==q),P==null||P.removeFromDom(),P=null,U.removeEventListener("click",Ce)};return he.push(q),q},Ae=(E={})=>{const R=we(ne,E),Z=Ke(R),U=Sr({triggerLabel:R.triggerLabel,triggerAriaLabel:R.triggerAriaLabel,shadow:Z,styleNonce:f});return Qe(U.el,{...R,onFormOpen(){U.hide()},onFormClose(){U.show()},onFormSubmitted(){U.show()}}),U};return{name:"Feedback",setupOnce(){!qt()||!ne.autoInject||(w.readyState==="loading"?w.addEventListener("DOMContentLoaded",()=>Ae().appendToDom()):Ae().appendToDom())},attachTo:Qe,createWidget(E={}){const R=Ae(we(ne,E));return R.appendToDom(),R},async createForm(E={}){return Je(we(ne,E))},setTheme(E){if(ne.colorScheme=E,X){const R=at(ne);se?X.replaceChild(R,se):X.prepend(R),se=R}},remove(){var E;X&&((E=X.parentElement)==null||E.remove(),X=null,se=null),he.forEach(R=>R()),he=[]}}};function vn(){const e=me();return e==null?void 0:e.getIntegrationByName("Feedback")}var Me,S,Lt,oe,it,Dt,Ge,ge={},qe=[],Tr=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,je=Array.isArray;function te(e,t){for(var r in t)e[r]=t[r];return e}function Ft(e){var t=e.parentNode;t&&t.removeChild(e)}function g(e,t,r){var n,o,a,c={};for(a in t)a=="key"?n=t[a]:a=="ref"?o=t[a]:c[a]=t[a];if(arguments.length>2&&(c.children=arguments.length>3?Me.call(arguments,2):r),typeof e=="function"&&e.defaultProps!=null)for(a in e.defaultProps)c[a]===void 0&&(c[a]=e.defaultProps[a]);return Re(e,c,n,o,null)}function Re(e,t,r,n,o){var a={type:e,props:t,key:r,ref:n,__k:null,__:null,__b:0,__e:null,__d:void 0,__c:null,constructor:void 0,__v:o??++Lt,__i:-1,__u:0};return o==null&&S.vnode!=null&&S.vnode(a),a}function be(e){return e.children}function Le(e,t){this.props=e,this.context=t}function de(e,t){if(t==null)return e.__?de(e.__,e.__i+1):null;for(var r;t<e.__k.length;t++)if((r=e.__k[t])!=null&&r.__e!=null)return r.__e;return typeof e.type=="function"?de(e):null}function Rr(e,t,r){var n,o=e.__v,a=o.__e,c=e.__P;if(c)return(n=te({},o)).__v=o.__v+1,S.vnode&&S.vnode(n),Xe(c,n,o,e.__n,c.ownerSVGElement!==void 0,32&o.__u?[a]:null,t,a??de(o),!!(32&o.__u),r),n.__.__k[n.__i]=n,n.__d=void 0,n.__e!=a&&It(n),n}function It(e){var t,r;if((e=e.__)!=null&&e.__c!=null){for(e.__e=e.__c.base=null,t=0;t<e.__k.length;t++)if((r=e.__k[t])!=null&&r.__e!=null){e.__e=e.__c.base=r.__e;break}return It(e)}}function ct(e){(!e.__d&&(e.__d=!0)&&oe.push(e)&&!Ie.__r++||it!==S.debounceRendering)&&((it=S.debounceRendering)||Dt)(Ie)}function Ie(){var e,t,r,n=[],o=[];for(oe.sort(Ge);e=oe.shift();)e.__d&&(r=oe.length,t=Rr(e,n,o)||t,r===0||oe.length>r?(Oe(n,t,o),o.length=n.length=0,t=void 0,oe.sort(Ge)):t&&S.__c&&S.__c(t,qe));t&&Oe(n,t,o),Ie.__r=0}function Mt(e,t,r,n,o,a,c,s,u,l,d){var i,h,_,f,v,b=n&&n.__k||qe,p=t.length;for(r.__d=u,Lr(r,t,b),u=r.__d,i=0;i<p;i++)(_=r.__k[i])!=null&&typeof _!="boolean"&&typeof _!="function"&&(h=_.__i===-1?ge:b[_.__i]||ge,_.__i=i,Xe(e,_,h,o,a,c,s,u,l,d),f=_.__e,_.ref&&h.ref!=_.ref&&(h.ref&&Ze(h.ref,null,_),d.push(_.ref,_.__c||f,_)),v==null&&f!=null&&(v=f),65536&_.__u||h.__k===_.__k?u=At(_,u,e):typeof _.type=="function"&&_.__d!==void 0?u=_.__d:f&&(u=f.nextSibling),_.__d=void 0,_.__u&=-196609);r.__d=u,r.__e=v}function Lr(e,t,r){var n,o,a,c,s,u=t.length,l=r.length,d=l,i=0;for(e.__k=[],n=0;n<u;n++)(o=e.__k[n]=(o=t[n])==null||typeof o=="boolean"||typeof o=="function"?null:typeof o=="string"||typeof o=="number"||typeof o=="bigint"||o.constructor==String?Re(null,o,null,null,o):je(o)?Re(be,{children:o},null,null,null):o.constructor===void 0&&o.__b>0?Re(o.type,o.props,o.key,o.ref?o.ref:null,o.__v):o)!=null?(o.__=e,o.__b=e.__b+1,s=Dr(o,r,c=n+i,d),o.__i=s,a=null,s!==-1&&(d--,(a=r[s])&&(a.__u|=131072)),a==null||a.__v===null?(s==-1&&i--,typeof o.type!="function"&&(o.__u|=65536)):s!==c&&(s===c+1?i++:s>c?d>u-c?i+=s-c:i--:i=s<c&&s==c-1?s-c:0,s!==n+i&&(o.__u|=65536))):(a=r[n])&&a.key==null&&a.__e&&(a.__e==e.__d&&(e.__d=de(a)),ze(a,a,!1),r[n]=null,d--);if(d)for(n=0;n<l;n++)(a=r[n])!=null&&(131072&a.__u)==0&&(a.__e==e.__d&&(e.__d=de(a)),ze(a,a))}function At(e,t,r){var n,o;if(typeof e.type=="function"){for(n=e.__k,o=0;n&&o<n.length;o++)n[o]&&(n[o].__=e,t=At(n[o],t,r));return t}e.__e!=t&&(r.insertBefore(e.__e,t||null),t=e.__e);do t=t&&t.nextSibling;while(t!=null&&t.nodeType===8);return t}function Dr(e,t,r,n){var o=e.key,a=e.type,c=r-1,s=r+1,u=t[r];if(u===null||u&&o==u.key&&a===u.type)return r;if(n>(u!=null&&(131072&u.__u)==0?1:0))for(;c>=0||s<t.length;){if(c>=0){if((u=t[c])&&(131072&u.__u)==0&&o==u.key&&a===u.type)return c;c--}if(s<t.length){if((u=t[s])&&(131072&u.__u)==0&&o==u.key&&a===u.type)return s;s++}}return-1}function lt(e,t,r){t[0]==="-"?e.setProperty(t,r??""):e[t]=r==null?"":typeof r!="number"||Tr.test(t)?r:r+"px"}function xe(e,t,r,n,o){var a;e:if(t==="style")if(typeof r=="string")e.style.cssText=r;else{if(typeof n=="string"&&(e.style.cssText=n=""),n)for(t in n)r&&t in r||lt(e.style,t,"");if(r)for(t in r)n&&r[t]===n[t]||lt(e.style,t,r[t])}else if(t[0]==="o"&&t[1]==="n")a=t!==(t=t.replace(/(PointerCapture)$|Capture$/i,"$1")),t=t.toLowerCase()in e?t.toLowerCase().slice(2):t.slice(2),e.l||(e.l={}),e.l[t+a]=r,r?n?r.u=n.u:(r.u=Date.now(),e.addEventListener(t,a?_t:st,a)):e.removeEventListener(t,a?_t:st,a);else{if(o)t=t.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(t!=="width"&&t!=="height"&&t!=="href"&&t!=="list"&&t!=="form"&&t!=="tabIndex"&&t!=="download"&&t!=="rowSpan"&&t!=="colSpan"&&t!=="role"&&t in e)try{e[t]=r??"";break e}catch{}typeof r=="function"||(r==null||r===!1&&t[4]!=="-"?e.removeAttribute(t):e.setAttribute(t,r))}}function st(e){if(this.l){var t=this.l[e.type+!1];if(e.t){if(e.t<=t.u)return}else e.t=Date.now();return t(S.event?S.event(e):e)}}function _t(e){if(this.l)return this.l[e.type+!0](S.event?S.event(e):e)}function Xe(e,t,r,n,o,a,c,s,u,l){var d,i,h,_,f,v,b,p,y,F,k,V,O,A,z,L=t.type;if(t.constructor!==void 0)return null;128&r.__u&&(u=!!(32&r.__u),a=[s=t.__e=r.__e]),(d=S.__b)&&d(t);e:if(typeof L=="function")try{if(p=t.props,y=(d=L.contextType)&&n[d.__c],F=d?y?y.props.value:d.__:n,r.__c?b=(i=t.__c=r.__c).__=i.__E:("prototype"in L&&L.prototype.render?t.__c=i=new L(p,F):(t.__c=i=new Le(p,F),i.constructor=L,i.render=Ir),y&&y.sub(i),i.props=p,i.state||(i.state={}),i.context=F,i.__n=n,h=i.__d=!0,i.__h=[],i._sb=[]),i.__s==null&&(i.__s=i.state),L.getDerivedStateFromProps!=null&&(i.__s==i.state&&(i.__s=te({},i.__s)),te(i.__s,L.getDerivedStateFromProps(p,i.__s))),_=i.props,f=i.state,i.__v=t,h)L.getDerivedStateFromProps==null&&i.componentWillMount!=null&&i.componentWillMount(),i.componentDidMount!=null&&i.__h.push(i.componentDidMount);else{if(L.getDerivedStateFromProps==null&&p!==_&&i.componentWillReceiveProps!=null&&i.componentWillReceiveProps(p,F),!i.__e&&(i.shouldComponentUpdate!=null&&i.shouldComponentUpdate(p,i.__s,F)===!1||t.__v===r.__v)){for(t.__v!==r.__v&&(i.props=p,i.state=i.__s,i.__d=!1),t.__e=r.__e,t.__k=r.__k,t.__k.forEach(function(H){H&&(H.__=t)}),k=0;k<i._sb.length;k++)i.__h.push(i._sb[k]);i._sb=[],i.__h.length&&c.push(i);break e}i.componentWillUpdate!=null&&i.componentWillUpdate(p,i.__s,F),i.componentDidUpdate!=null&&i.__h.push(function(){i.componentDidUpdate(_,f,v)})}if(i.context=F,i.props=p,i.__P=e,i.__e=!1,V=S.__r,O=0,"prototype"in L&&L.prototype.render){for(i.state=i.__s,i.__d=!1,V&&V(t),d=i.render(i.props,i.state,i.context),A=0;A<i._sb.length;A++)i.__h.push(i._sb[A]);i._sb=[]}else do i.__d=!1,V&&V(t),d=i.render(i.props,i.state,i.context),i.state=i.__s;while(i.__d&&++O<25);i.state=i.__s,i.getChildContext!=null&&(n=te(te({},n),i.getChildContext())),h||i.getSnapshotBeforeUpdate==null||(v=i.getSnapshotBeforeUpdate(_,f)),Mt(e,je(z=d!=null&&d.type===be&&d.key==null?d.props.children:d)?z:[z],t,r,n,o,a,c,s,u,l),i.base=t.__e,t.__u&=-161,i.__h.length&&c.push(i),b&&(i.__E=i.__=null)}catch(H){t.__v=null,u||a!=null?(t.__e=s,t.__u|=u?160:32,a[a.indexOf(s)]=null):(t.__e=r.__e,t.__k=r.__k),S.__e(H,t,r)}else a==null&&t.__v===r.__v?(t.__k=r.__k,t.__e=r.__e):t.__e=Fr(r.__e,t,r,n,o,a,c,u,l);(d=S.diffed)&&d(t)}function Oe(e,t,r){for(var n=0;n<r.length;n++)Ze(r[n],r[++n],r[++n]);S.__c&&S.__c(t,e),e.some(function(o){try{e=o.__h,o.__h=[],e.some(function(a){a.call(o)})}catch(a){S.__e(a,o.__v)}})}function Fr(e,t,r,n,o,a,c,s,u){var l,d,i,h,_,f,v,b=r.props,p=t.props,y=t.type;if(y==="svg"&&(o=!0),a!=null){for(l=0;l<a.length;l++)if((_=a[l])&&"setAttribute"in _==!!y&&(y?_.localName===y:_.nodeType===3)){e=_,a[l]=null;break}}if(e==null){if(y===null)return document.createTextNode(p);e=o?document.createElementNS("http://www.w3.org/2000/svg",y):document.createElement(y,p.is&&p),a=null,s=!1}if(y===null)b===p||s&&e.data===p||(e.data=p);else{if(a=a&&Me.call(e.childNodes),b=r.props||ge,!s&&a!=null)for(b={},l=0;l<e.attributes.length;l++)b[(_=e.attributes[l]).name]=_.value;for(l in b)_=b[l],l=="children"||(l=="dangerouslySetInnerHTML"?i=_:l==="key"||l in p||xe(e,l,null,_,o));for(l in p)_=p[l],l=="children"?h=_:l=="dangerouslySetInnerHTML"?d=_:l=="value"?f=_:l=="checked"?v=_:l==="key"||s&&typeof _!="function"||b[l]===_||xe(e,l,_,b[l],o);if(d)s||i&&(d.__html===i.__html||d.__html===e.innerHTML)||(e.innerHTML=d.__html),t.__k=[];else if(i&&(e.innerHTML=""),Mt(e,je(h)?h:[h],t,r,n,o&&y!=="foreignObject",a,c,a?a[0]:r.__k&&de(r,0),s,u),a!=null)for(l=a.length;l--;)a[l]!=null&&Ft(a[l]);s||(l="value",f!==void 0&&(f!==e[l]||y==="progress"&&!f||y==="option"&&f!==b[l])&&xe(e,l,f,b[l],!1),l="checked",v!==void 0&&v!==e[l]&&xe(e,l,v,b[l],!1))}return e}function Ze(e,t,r){try{typeof e=="function"?e(t):e.current=t}catch(n){S.__e(n,r)}}function ze(e,t,r){var n,o;if(S.unmount&&S.unmount(e),(n=e.ref)&&(n.current&&n.current!==e.__e||Ze(n,null,t)),(n=e.__c)!=null){if(n.componentWillUnmount)try{n.componentWillUnmount()}catch(a){S.__e(a,t)}n.base=n.__P=null,e.__c=void 0}if(n=e.__k)for(o=0;o<n.length;o++)n[o]&&ze(n[o],t,r||typeof e.type!="function");r||e.__e==null||Ft(e.__e),e.__=e.__e=e.__d=void 0}function Ir(e,t,r){return this.constructor(e,r)}function Mr(e,t,r){var n,o,a,c;S.__&&S.__(e,t),o=(n=!1)?null:t.__k,a=[],c=[],Xe(t,e=t.__k=g(be,null,[e]),o||ge,ge,t.ownerSVGElement!==void 0,o?null:t.firstChild?Me.call(t.childNodes):null,a,o?o.__e:t.firstChild,n,c),e.__d=void 0,Oe(a,e,c)}Me=qe.slice,S={__e:function(e,t,r,n){for(var o,a,c;t=t.__;)if((o=t.__c)&&!o.__)try{if((a=o.constructor)&&a.getDerivedStateFromError!=null&&(o.setState(a.getDerivedStateFromError(e)),c=o.__d),o.componentDidCatch!=null&&(o.componentDidCatch(e,n||{}),c=o.__d),c)return o.__E=o}catch(s){e=s}throw e}},Lt=0,Le.prototype.setState=function(e,t){var r;r=this.__s!=null&&this.__s!==this.state?this.__s:this.__s=te({},this.state),typeof e=="function"&&(e=e(te({},r),this.props)),e&&te(r,e),e!=null&&this.__v&&(t&&this._sb.push(t),ct(this))},Le.prototype.forceUpdate=function(e){this.__v&&(this.__e=!0,e&&this.__h.push(e),ct(this))},Le.prototype.render=be,oe=[],Dt=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Ge=function(e,t){return e.__v.__b-t.__v.__b},Ie.__r=0;var Y,x,$e,ut,fe=0,$t=[],De=[],T=S,dt=T.__b,ft=T.__r,ht=T.diffed,pt=T.__c,gt=T.unmount,mt=T.__;function ce(e,t){T.__h&&T.__h(x,e,fe||t),fe=0;var r=x.__H||(x.__H={__:[],__h:[]});return e>=r.__.length&&r.__.push({__V:De}),r.__[e]}function ae(e){return fe=1,Ht(Bt,e)}function Ht(e,t,r){var n=ce(Y++,2);if(n.t=e,!n.__c&&(n.__=[r?r(t):Bt(void 0,t),function(s){var u=n.__N?n.__N[0]:n.__[0],l=n.t(u,s);u!==l&&(n.__N=[l,n.__[1]],n.__c.setState({}))}],n.__c=x,!x.u)){var o=function(s,u,l){if(!n.__c.__H)return!0;var d=n.__c.__H.__.filter(function(h){return!!h.__c});if(d.every(function(h){return!h.__N}))return!a||a.call(this,s,u,l);var i=!1;return d.forEach(function(h){if(h.__N){var _=h.__[0];h.__=h.__N,h.__N=void 0,_!==h.__[0]&&(i=!0)}}),!(!i&&n.__c.props===s)&&(!a||a.call(this,s,u,l))};x.u=!0;var a=x.shouldComponentUpdate,c=x.componentWillUpdate;x.componentWillUpdate=function(s,u,l){if(this.__e){var d=a;a=void 0,o(s,u,l),a=d}c&&c.call(this,s,u,l)},x.shouldComponentUpdate=o}return n.__N||n.__}function Ar(e,t){var r=ce(Y++,3);!T.__s&&Ye(r.__H,t)&&(r.__=e,r.i=t,x.__H.__h.push(r))}function Nt(e,t){var r=ce(Y++,4);!T.__s&&Ye(r.__H,t)&&(r.__=e,r.i=t,x.__h.push(r))}function $r(e){return fe=5,ve(function(){return{current:e}},[])}function Hr(e,t,r){fe=6,Nt(function(){return typeof e=="function"?(e(t()),function(){return e(null)}):e?(e.current=t(),function(){return e.current=null}):void 0},r==null?r:r.concat(e))}function ve(e,t){var r=ce(Y++,7);return Ye(r.__H,t)?(r.__V=e(),r.i=t,r.__h=e,r.__V):r.__}function ue(e,t){return fe=8,ve(function(){return e},t)}function Nr(e){var t=x.context[e.__c],r=ce(Y++,9);return r.c=e,t?(r.__==null&&(r.__=!0,t.sub(x)),t.props.value):e.__}function Br(e,t){T.useDebugValue&&T.useDebugValue(t?t(e):e)}function Ur(e){var t=ce(Y++,10),r=ae();return t.__=e,x.componentDidCatch||(x.componentDidCatch=function(n,o){t.__&&t.__(n,o),r[1](n)}),[r[0],function(){r[1](void 0)}]}function Pr(){var e=ce(Y++,11);if(!e.__){for(var t=x.__v;t!==null&&!t.__m&&t.__!==null;)t=t.__;var r=t.__m||(t.__m=[0,0]);e.__="P"+r[0]+"-"+r[1]++}return e.__}function Gr(){for(var e;e=$t.shift();)if(e.__P&&e.__H)try{e.__H.__h.forEach(Fe),e.__H.__h.forEach(We),e.__H.__h=[]}catch(t){e.__H.__h=[],T.__e(t,e.__v)}}T.__b=function(e){x=null,dt&&dt(e)},T.__=function(e,t){t.__k&&t.__k.__m&&(e.__m=t.__k.__m),mt&&mt(e,t)},T.__r=function(e){ft&&ft(e),Y=0;var t=(x=e.__c).__H;t&&($e===x?(t.__h=[],x.__h=[],t.__.forEach(function(r){r.__N&&(r.__=r.__N),r.__V=De,r.__N=r.i=void 0})):(t.__h.forEach(Fe),t.__h.forEach(We),t.__h=[],Y=0)),$e=x},T.diffed=function(e){ht&&ht(e);var t=e.__c;t&&t.__H&&(t.__H.__h.length&&($t.push(t)!==1&&ut===T.requestAnimationFrame||((ut=T.requestAnimationFrame)||Or)(Gr)),t.__H.__.forEach(function(r){r.i&&(r.__H=r.i),r.__V!==De&&(r.__=r.__V),r.i=void 0,r.__V=De})),$e=x=null},T.__c=function(e,t){t.some(function(r){try{r.__h.forEach(Fe),r.__h=r.__h.filter(function(n){return!n.__||We(n)})}catch(n){t.some(function(o){o.__h&&(o.__h=[])}),t=[],T.__e(n,r.__v)}}),pt&&pt(e,t)},T.unmount=function(e){gt&&gt(e);var t,r=e.__c;r&&r.__H&&(r.__H.__.forEach(function(n){try{Fe(n)}catch(o){t=o}}),r.__H=void 0,t&&T.__e(t,r.__v))};var bt=typeof requestAnimationFrame=="function";function Or(e){var t,r=function(){clearTimeout(n),bt&&cancelAnimationFrame(t),setTimeout(e)},n=setTimeout(r,100);bt&&(t=requestAnimationFrame(r))}function Fe(e){var t=x,r=e.__c;typeof r=="function"&&(e.__c=void 0,r()),x=t}function We(e){var t=x;e.__c=e.__(),x=t}function Ye(e,t){return!e||e.length!==t.length||t.some(function(r,n){return r!==e[n]})}function Bt(e,t){return typeof t=="function"?t(e):t}const zr=Object.defineProperty({__proto__:null,useCallback:ue,useContext:Nr,useDebugValue:Br,useEffect:Ar,useErrorBoundary:Ur,useId:Pr,useImperativeHandle:Hr,useLayoutEffect:Nt,useMemo:ve,useReducer:Ht,useRef:$r,useState:ae},Symbol.toStringTag,{value:"Module"}),Wr="http://www.w3.org/2000/svg";function Vr(){const e=n=>w.createElementNS(Wr,n),t=G(e("svg"),{width:"32",height:"30",viewBox:"0 0 72 66",fill:"inherit"}),r=G(e("path"),{transform:"translate(11, 11)",d:"M29,2.26a4.67,4.67,0,0,0-8,0L14.42,13.53A32.21,32.21,0,0,1,32.17,40.19H27.55A27.68,27.68,0,0,0,12.09,17.47L6,28a15.92,15.92,0,0,1,9.23,12.17H4.62A.76.76,0,0,1,4,39.06l2.94-5a10.74,10.74,0,0,0-3.36-1.9l-2.91,5a4.54,4.54,0,0,0,1.69,6.24A4.66,4.66,0,0,0,4.62,44H19.15a19.4,19.4,0,0,0-8-17.31l2.31-4A23.87,23.87,0,0,1,23.76,44H36.07a35.88,35.88,0,0,0-16.41-31.8l4.67-8a.77.77,0,0,1,1.05-.27c.53.29,20.29,34.77,20.66,35.17a.76.76,0,0,1-.68,1.13H40.6q.09,1.91,0,3.81h4.78A4.59,4.59,0,0,0,50,39.43a4.49,4.49,0,0,0-.62-2.28Z"});return t.appendChild(r),t}function qr({options:e}){const t=ve(()=>({__html:Vr().outerHTML}),[]);return g("h2",{class:"dialog__header"},g("span",{class:"dialog__title"},e.formTitle),e.showBranding?g("a",{class:"brand-link",target:"_blank",href:"https://sentry.io/welcome/",title:"Powered by Sentry",rel:"noopener noreferrer",dangerouslySetInnerHTML:t}):null)}function jr(e,t){const r=[];return t.isNameRequired&&!e.name&&r.push(t.nameLabel),t.isEmailRequired&&!e.email&&r.push(t.emailLabel),e.message||r.push(t.messageLabel),r}function He(e,t){const r=e.get(t);return typeof r=="string"?r.trim():""}function Xr({options:e,defaultEmail:t,defaultName:r,onFormClose:n,onSubmit:o,onSubmitSuccess:a,onSubmitError:c,showEmail:s,showName:u,screenshotInput:l}){const{tags:d,addScreenshotButtonLabel:i,removeScreenshotButtonLabel:h,cancelButtonLabel:_,emailLabel:f,emailPlaceholder:v,isEmailRequired:b,isNameRequired:p,messageLabel:y,messagePlaceholder:F,nameLabel:k,namePlaceholder:V,submitButtonLabel:O,isRequiredLabel:A}=e,[z,L]=ae(!1),[H,K]=ae(null),[m,C]=ae(!1),I=l==null?void 0:l.input,[$,re]=ae(null),le=ue(D=>{re(D),C(!1)},[]),N=ue(D=>{const W=jr(D,{emailLabel:f,isEmailRequired:b,isNameRequired:p,messageLabel:y,nameLabel:k});return W.length>0?K(`Please enter in the following required fields: ${W.join(", ")}`):K(null),W.length===0},[f,b,p,y,k]),B=ue(async D=>{L(!0);try{if(D.preventDefault(),!(D.target instanceof HTMLFormElement))return;const W=new FormData(D.target),ye=await(l&&m?l.value():void 0),J={name:He(W,"name"),email:He(W,"email"),message:He(W,"message"),attachments:ye?[ye]:void 0};if(!N(J))return;try{const Q=await o({name:J.name,email:J.email,message:J.message,source:gr,tags:d},{attachments:J.attachments});a(J,Q)}catch(Q){Te&&ie.error(Q);const Ee=Q instanceof Error?Q:new Error(String(Q));K(Ee.message),c(Ee)}}finally{L(!1)}},[l&&m,a,c]);return g("form",{class:"form",onSubmit:B},I&&m?g(I,{onError:le}):null,g("fieldset",{class:"form__right","data-sentry-feedback":!0,disabled:z},g("div",{class:"form__top"},H?g("div",{class:"form__error-container"},H):null,u?g("label",{for:"name",class:"form__label"},g(Ne,{label:k,isRequiredLabel:A,isRequired:p}),g("input",{class:"form__input",defaultValue:r,id:"name",name:"name",placeholder:V,required:p,type:"text"})):g("input",{"aria-hidden":!0,value:r,name:"name",type:"hidden"}),s?g("label",{for:"email",class:"form__label"},g(Ne,{label:f,isRequiredLabel:A,isRequired:b}),g("input",{class:"form__input",defaultValue:t,id:"email",name:"email",placeholder:v,required:b,type:"email"})):g("input",{"aria-hidden":!0,value:t,name:"email",type:"hidden"}),g("label",{for:"message",class:"form__label"},g(Ne,{label:y,isRequiredLabel:A,isRequired:!0}),g("textarea",{autoFocus:!0,class:"form__input form__input--textarea",id:"message",name:"message",placeholder:F,required:!0,rows:5})),I?g("label",{for:"screenshot",class:"form__label"},g("button",{class:"btn btn--default",disabled:z,type:"button",onClick:()=>{re(null),C(D=>!D)}},m?h:i),$?g("div",{class:"form__error-container"},$.message):null):null),g("div",{class:"btn-group"},g("button",{class:"btn btn--primary",disabled:z,type:"submit"},O),g("button",{class:"btn btn--default",disabled:z,type:"button",onClick:n},_))))}function Ne({label:e,isRequired:t,isRequiredLabel:r}){return g("span",{class:"form__label__text"},e,t&&g("span",{class:"form__label__text--required"},r))}const Se=16,vt=17,Zr="http://www.w3.org/2000/svg";function Yr(){const e=u=>j.document.createElementNS(Zr,u),t=G(e("svg"),{width:`${Se}`,height:`${vt}`,viewBox:`0 0 ${Se} ${vt}`,fill:"inherit"}),r=G(e("g"),{clipPath:"url(#clip0_57_156)"}),n=G(e("path"),{"fill-rule":"evenodd","clip-rule":"evenodd",d:"M3.55544 15.1518C4.87103 16.0308 6.41775 16.5 8 16.5C10.1217 16.5 12.1566 15.6571 13.6569 14.1569C15.1571 12.6566 16 10.6217 16 8.5C16 6.91775 15.5308 5.37103 14.6518 4.05544C13.7727 2.73985 12.5233 1.71447 11.0615 1.10897C9.59966 0.503466 7.99113 0.34504 6.43928 0.653721C4.88743 0.962403 3.46197 1.72433 2.34315 2.84315C1.22433 3.96197 0.462403 5.38743 0.153721 6.93928C-0.15496 8.49113 0.00346625 10.0997 0.608967 11.5615C1.21447 13.0233 2.23985 14.2727 3.55544 15.1518ZM4.40546 3.1204C5.46945 2.40946 6.72036 2.03 8 2.03C9.71595 2.03 11.3616 2.71166 12.575 3.92502C13.7883 5.13838 14.47 6.78405 14.47 8.5C14.47 9.77965 14.0905 11.0306 13.3796 12.0945C12.6687 13.1585 11.6582 13.9878 10.476 14.4775C9.29373 14.9672 7.99283 15.0953 6.73777 14.8457C5.48271 14.596 4.32987 13.9798 3.42502 13.075C2.52018 12.1701 1.90397 11.0173 1.65432 9.76224C1.40468 8.50718 1.5328 7.20628 2.0225 6.02404C2.5122 4.8418 3.34148 3.83133 4.40546 3.1204Z"}),o=G(e("path"),{d:"M6.68775 12.4297C6.78586 12.4745 6.89218 12.4984 7 12.5C7.11275 12.4955 7.22315 12.4664 7.32337 12.4145C7.4236 12.3627 7.51121 12.2894 7.58 12.2L12 5.63999C12.0848 5.47724 12.1071 5.28902 12.0625 5.11098C12.0178 4.93294 11.9095 4.77744 11.7579 4.67392C11.6064 4.57041 11.4221 4.52608 11.24 4.54931C11.0579 4.57254 10.8907 4.66173 10.77 4.79999L6.88 10.57L5.13 8.56999C5.06508 8.49566 4.98613 8.43488 4.89768 8.39111C4.80922 8.34735 4.713 8.32148 4.61453 8.31498C4.51605 8.30847 4.41727 8.32147 4.32382 8.35322C4.23038 8.38497 4.14413 8.43484 4.07 8.49999C3.92511 8.63217 3.83692 8.81523 3.82387 9.01092C3.81083 9.2066 3.87393 9.39976 4 9.54999L6.43 12.24C6.50187 12.3204 6.58964 12.385 6.68775 12.4297Z"});t.appendChild(r).append(o,n);const a=e("defs"),c=G(e("clipPath"),{id:"clip0_57_156"}),s=G(e("rect"),{width:`${Se}`,height:`${Se}`,fill:"white",transform:"translate(0 0.5)"});return c.appendChild(s),a.appendChild(c),t.appendChild(a).appendChild(c).appendChild(s),t}function Kr({open:e,onFormSubmitted:t,...r}){const n=r.options,o=ve(()=>({__html:Yr().outerHTML}),[]),[a,c]=ae(null),s=ue(()=>{a&&(clearTimeout(a),c(null)),t()},[a]),u=ue((l,d)=>{r.onSubmitSuccess(l,d),c(setTimeout(()=>{t(),c(null)},br))},[t]);return g(be,null,a?g("div",{class:"success__position",onClick:s},g("div",{class:"success__content"},n.successMessageText,g("span",{class:"success__icon",dangerouslySetInnerHTML:o}))):g("dialog",{class:"dialog",onClick:n.onFormClose,open:e},g("div",{class:"dialog__position"},g("div",{class:"dialog__content",onClick:l=>{l.stopPropagation()}},g(qr,{options:n}),g(Xr,{...r,onSubmitSuccess:u})))))}const Jr=`
.dialog {
  position: fixed;
  z-index: var(--z-index);
  margin: 0;
  inset: 0;

  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  height: 100vh;
  width: 100vw;

  color: var(--dialog-color, var(--foreground));
  fill: var(--dialog-color, var(--foreground));
  line-height: 1.75em;

  background-color: rgba(0, 0, 0, 0.05);
  border: none;
  inset: 0;
  opacity: 1;
  transition: opacity 0.2s ease-in-out;
}

.dialog__position {
  position: fixed;
  z-index: var(--z-index);
  inset: var(--dialog-inset);
  padding: var(--page-margin);
  display: flex;
  max-height: calc(100vh - (2 * var(--page-margin)));
}
@media (max-width: 600px) {
  .dialog__position {
    inset: var(--page-margin);
    padding: 0;
  }
}

.dialog__position:has(.editor) {
  inset: var(--page-margin);
  padding: 0;
}

.dialog:not([open]) {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}
.dialog:not([open]) .dialog__content {
  transform: translate(0, -16px) scale(0.98);
}

.dialog__content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: var(--dialog-padding, 24px);
  max-width: 100%;
  width: 100%;
  max-height: 100%;
  overflow: auto;

  background: var(--dialog-background, var(--background));
  border-radius: var(--dialog-border-radius, 20px);
  border: var(--dialog-border, var(--border));
  box-shadow: var(--dialog-box-shadow, var(--box-shadow));
  transform: translate(0, 0) scale(1);
  transition: transform 0.2s ease-in-out;
}

`,Qr=`
.dialog__header {
  display: flex;
  gap: 4px;
  justify-content: space-between;
  font-weight: var(--dialog-header-weight, 600);
  margin: 0;
}
.dialog__title {
  align-self: center;
  width: var(--form-width, 272px);
}

@media (max-width: 600px) {
  .dialog__title {
    width: auto;
  }
}

.dialog__position:has(.editor) .dialog__title {
  width: auto;
}


.brand-link {
  display: inline-flex;
}
.brand-link:focus-visible {
  outline: var(--outline);
}
`,en=`
.form {
  display: flex;
  overflow: auto;
  flex-direction: row;
  gap: 16px;
  flex: 1 0;
}

.form fieldset {
  border: none;
  margin: 0;
  padding: 0;
}

.form__right {
  flex: 0 0 auto;
  display: flex;
  overflow: auto;
  flex-direction: column;
  justify-content: space-between;
  gap: 20px;
  width: var(--form-width, 100%);
}

.dialog__position:has(.editor) .form__right {
  width: var(--form-width, 272px);
}

.form__top {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form__error-container {
  color: var(--error-color);
  fill: var(--error-color);
}

.form__label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0px;
}

.form__label__text {
  display: flex;
  gap: 4px;
  align-items: center;
}

.form__label__text--required {
  font-size: 0.85em;
}

.form__input {
  font-family: inherit;
  line-height: inherit;
  background: transparent;
  box-sizing: border-box;
  border: var(--input-border, var(--border));
  border-radius: var(--input-border-radius, 6px);
  color: var(--input-color, inherit);
  fill: var(--input-color, inherit);
  font-size: var(--input-font-size, inherit);
  font-weight: var(--input-font-weight, 500);
  padding: 6px 12px;
}

.form__input::placeholder {
  opacity: 0.65;
  color: var(--input-placeholder-color, inherit);
  filter: var(--interactive-filter);
}

.form__input:focus-visible {
  outline: var(--input-focus-outline, var(--outline));
}

.form__input--textarea {
  font-family: inherit;
  resize: vertical;
}

.error {
  color: var(--error-color);
  fill: var(--error-color);
}
`,tn=`
.btn-group {
  display: grid;
  gap: 8px;
}

.btn {
  line-height: inherit;
  border: var(--button-border, var(--border));
  border-radius: var(--button-border-radius, 6px);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--button-font-size, inherit);
  font-weight: var(--button-font-weight, 600);
  padding: var(--button-padding, 6px 16px);
}
.btn[disabled] {
  opacity: 0.6;
  pointer-events: none;
}

.btn--primary {
  color: var(--button-primary-color, var(--accent-foreground));
  fill: var(--button-primary-color, var(--accent-foreground));
  background: var(--button-primary-background, var(--accent-background));
  border: var(--button-primary-border, var(--border));
  border-radius: var(--button-primary-border-radius, 6px);
  font-weight: var(--button-primary-font-weight, 500);
}
.btn--primary:hover {
  color: var(--button-primary-hover-color, var(--accent-foreground));
  fill: var(--button-primary-hover-color, var(--accent-foreground));
  background: var(--button-primary-hover-background, var(--accent-background));
  filter: var(--interactive-filter);
}
.btn--primary:focus-visible {
  background: var(--button-primary-hover-background, var(--accent-background));
  filter: var(--interactive-filter);
  outline: var(--button-primary-focus-outline, var(--outline));
}

.btn--default {
  color: var(--button-color, var(--foreground));
  fill: var(--button-color, var(--foreground));
  background: var(--button-background, var(--background));
  border: var(--button-border, var(--border));
  border-radius: var(--button-border-radius, 6px);
  font-weight: var(--button-font-weight, 500);
}
.btn--default:hover {
  color: var(--button-color, var(--foreground));
  fill: var(--button-color, var(--foreground));
  background: var(--button-hover-background, var(--background));
  filter: var(--interactive-filter);
}
.btn--default:focus-visible {
  background: var(--button-hover-background, var(--background));
  filter: var(--interactive-filter);
  outline: var(--button-focus-outline, var(--outline));
}
`,rn=`
.success__position {
  position: fixed;
  inset: var(--dialog-inset);
  padding: var(--page-margin);
  z-index: var(--z-index);
}
.success__content {
  background: var(--success-background, var(--background));
  border: var(--success-border, var(--border));
  border-radius: var(--success-border-radius, 1.7em/50%);
  box-shadow: var(--success-box-shadow, var(--box-shadow));
  font-weight: var(--success-font-weight, 600);
  color: var(--success-color);
  fill: var(--success-color);
  padding: 12px 24px;
  line-height: 1.75em;

  display: grid;
  align-items: center;
  grid-auto-flow: column;
  gap: 6px;
  cursor: default;
}

.success__icon {
  display: flex;
}
`;function nn(e){const t=w.createElement("style");return t.textContent=`
:host {
  --dialog-inset: var(--inset);
}

${Jr}
${Qr}
${en}
${tn}
${rn}
`,e&&t.setAttribute("nonce",e),t}function on(){const e=Ve().getUser(),t=jt().getUser(),r=Xt().getUser();return e&&Object.keys(e).length?e:t&&Object.keys(t).length?t:r}const yn=()=>({name:"FeedbackModal",setupOnce(){},createDialog:({options:e,screenshotIntegration:t,sendFeedback:r,shadow:n})=>{const o=n,a=e.useSentryUser,c=on(),s=w.createElement("div"),u=nn(e.styleNonce);let l="";const d={get el(){return s},appendToDom(){!o.contains(u)&&!o.contains(s)&&(o.appendChild(u),o.appendChild(s))},removeFromDom(){s.remove(),u.remove(),w.body.style.overflow=l},open(){var _,f;h(!0),(_=e.onFormOpen)==null||_.call(e),(f=me())==null||f.emit("openFeedbackWidget"),l=w.body.style.overflow,w.body.style.overflow="hidden"},close(){h(!1),w.body.style.overflow=l}},i=t==null?void 0:t.createInput({h:g,hooks:zr,dialog:d,options:e}),h=_=>{Mr(g(Kr,{options:e,screenshotInput:i,showName:e.showName||e.isNameRequired,showEmail:e.showEmail||e.isEmailRequired,defaultName:String(a&&(c==null?void 0:c[a.name])||""),defaultEmail:String(a&&(c==null?void 0:c[a.email])||""),onFormClose:()=>{var f;h(!1),(f=e.onFormClose)==null||f.call(e)},onSubmit:r,onSubmitSuccess:(f,v)=>{var b;h(!1),(b=e.onSubmitSuccess)==null||b.call(e,f,v)},onSubmitError:f=>{var v;(v=e.onSubmitError)==null||v.call(e,f)},onFormSubmitted:()=>{var f;(f=e.onFormSubmitted)==null||f.call(e)},open:_}),s)};return d}});function an({h:e}){return function(){return e("svg",{"data-test-id":"icon-close",viewBox:"0 0 16 16",fill:"#2B2233",height:"25px",width:"25px"},e("circle",{r:"7",cx:"8",cy:"8",fill:"white"}),e("path",{strokeWidth:"1.5",d:"M8,16a8,8,0,1,1,8-8A8,8,0,0,1,8,16ZM8,1.53A6.47,6.47,0,1,0,14.47,8,6.47,6.47,0,0,0,8,1.53Z"}),e("path",{strokeWidth:"1.5",d:"M5.34,11.41a.71.71,0,0,1-.53-.22.74.74,0,0,1,0-1.06l5.32-5.32a.75.75,0,0,1,1.06,1.06L5.87,11.19A.74.74,0,0,1,5.34,11.41Z"}),e("path",{strokeWidth:"1.5",d:"M10.66,11.41a.74.74,0,0,1-.53-.22L4.81,5.87A.75.75,0,0,1,5.87,4.81l5.32,5.32a.74.74,0,0,1,0,1.06A.71.71,0,0,1,10.66,11.41Z"}))}}function cn(e){const t=w.createElement("style"),r="#1A141F",n="#302735";return t.textContent=`
.editor {
  display: flex;
  flex-grow: 1;
  flex-direction: column;
}

.editor__image-container {
  justify-items: center;
  padding: 15px;
  position: relative;
  height: 100%;
  border-radius: var(--menu-border-radius, 6px);

  background-color: ${r};
  background-image: repeating-linear-gradient(
      -145deg,
      transparent,
      transparent 8px,
      ${r} 8px,
      ${r} 11px
    ),
    repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 15px,
      ${n} 15px,
      ${n} 16px
    );
}

.editor__canvas-container {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.editor__canvas-container > * {
  object-fit: contain;
  position: absolute;
}

.editor__tool-container {
  padding-top: 8px;
  display: flex;
  justify-content: center;
}

.editor__tool-bar {
  display: flex;
  gap: 8px;
}

.editor__tool {
  display: flex;
  padding: 8px 12px;
  justify-content: center;
  align-items: center;
  border: var(--button-border, var(--border));
  border-radius: var(--button-border-radius, 6px);
  background: var(--button-background, var(--background));
  color: var(--button-color, var(--foreground));
}

.editor__tool--active {
  background: var(--button-primary-background, var(--accent-background));
  color: var(--button-primary-color, var(--accent-foreground));
}

.editor__rect {
  position: absolute;
  z-index: 2;
}

.editor__rect button {
  opacity: 0;
  position: absolute;
  top: -12px;
  right: -12px;
  cursor: pointer;
  padding: 0;
  z-index: 3;
  border: none;
  background: none;
}

.editor__rect:hover button {
  opacity: 1;
}
`,e&&t.setAttribute("nonce",e),t}function ln({h:e}){return function({action:r,setAction:n,options:o}){return e("div",{class:"editor__tool-container"},e("div",{class:"editor__tool-bar"},e("button",{type:"button",class:`editor__tool ${r==="highlight"?"editor__tool--active":""}`,onClick:()=>{n(r==="highlight"?"":"highlight")}},o.highlightToolText),e("button",{type:"button",class:`editor__tool ${r==="hide"?"editor__tool--active":""}`,onClick:()=>{n(r==="hide"?"":"hide")}},o.hideToolText)))}}function sn({hooks:e}){function t(){const[r,n]=e.useState(j.devicePixelRatio??1);return e.useEffect(()=>{const o=()=>{n(j.devicePixelRatio)},a=matchMedia(`(resolution: ${j.devicePixelRatio}dppx)`);return a.addEventListener("change",o),()=>{a.removeEventListener("change",o)}},[]),r}return function({onBeforeScreenshot:n,onScreenshot:o,onAfterScreenshot:a,onError:c}){const s=t();e.useEffect(()=>{(async()=>{n();const l=await pe.mediaDevices.getDisplayMedia({video:{width:j.innerWidth*s,height:j.innerHeight*s},audio:!1,monitorTypeSurfaces:"exclude",preferCurrentTab:!0,selfBrowserSurface:"include",surfaceSwitching:"exclude"}),d=w.createElement("video");await new Promise((i,h)=>{d.srcObject=l,d.onloadedmetadata=()=>{o(d,s),l.getTracks().forEach(_=>_.stop()),i()},d.play().catch(h)}),a()})().catch(c)},[])}}function _n(e,t,r){switch(e.type){case"highlight":{t.shadowColor="rgba(0, 0, 0, 0.7)",t.shadowBlur=50,t.fillStyle=r,t.fillRect(e.x-1,e.y-1,e.w+2,e.h+2),t.clearRect(e.x,e.y,e.w,e.h);break}case"hide":t.fillStyle="rgb(0, 0, 0)",t.fillRect(e.x,e.y,e.w,e.h);break}}function ee(e,t,r){if(!e)return;const n=e.getContext("2d",t);n&&r(e,n)}function Be(e,t){ee(e,{alpha:!0},(r,n)=>{n.drawImage(t,0,0,t.width,t.height,0,0,r.width,r.height)})}function Ue(e,t,r){ee(e,{alpha:!0},(n,o)=>{r.length&&(o.fillStyle="rgba(0, 0, 0, 0.25)",o.fillRect(0,0,n.width,n.height)),r.forEach(a=>{_n(a,o,t)})})}function un({h:e,hooks:t,outputBuffer:r,dialog:n,options:o}){const a=sn({hooks:t}),c=ln({h:e}),s=an({h:e}),u={__html:cn(o.styleNonce).innerText},l=n.el.style,d=({screenshot:i})=>{const[h,_]=t.useState("highlight"),[f,v]=t.useState([]),b=t.useRef(null),p=t.useRef(null),y=t.useRef(null),F=t.useRef(null),[k,V]=t.useState(1),O=t.useMemo(()=>{const m=w.getElementById(o.id);if(!m)return"white";const C=getComputedStyle(m);return C.getPropertyValue("--button-primary-background")||C.getPropertyValue("--accent-background")},[o.id]);t.useLayoutEffect(()=>{const m=()=>{const C=b.current;C&&(ee(i.canvas,{alpha:!1},I=>{const $=Math.min(C.clientWidth/I.width,C.clientHeight/I.height);V($)}),(C.clientHeight===0||C.clientWidth===0)&&setTimeout(m,0))};return m(),j.addEventListener("resize",m),()=>{j.removeEventListener("resize",m)}},[i]);const A=t.useCallback((m,C)=>{ee(m,{alpha:!0},(I,$)=>{$.scale(C,C),I.width=i.canvas.width,I.height=i.canvas.height})},[i]);t.useEffect(()=>{A(p.current,i.dpi),Be(p.current,i.canvas)},[i]),t.useEffect(()=>{A(y.current,i.dpi),ee(y.current,{alpha:!0},(m,C)=>{C.clearRect(0,0,m.width,m.height)}),Ue(y.current,O,f)},[f,O]),t.useEffect(()=>{A(r,i.dpi),Be(r,i.canvas),ee(w.createElement("canvas"),{alpha:!0},(m,C)=>{C.scale(i.dpi,i.dpi),m.width=i.canvas.width,m.height=i.canvas.height,Ue(m,O,f),Be(r,m)})},[f,i,O]);const z=m=>{if(!h||!F.current)return;const C=F.current.getBoundingClientRect(),I={type:h,x:m.offsetX/k,y:m.offsetY/k},$=(N,B)=>{const D=(B.clientX-C.x)/k,W=(B.clientY-C.y)/k;return{type:N.type,x:Math.min(N.x,D),y:Math.min(N.y,W),w:Math.abs(D-N.x),h:Math.abs(W-N.y)}},re=N=>{ee(y.current,{alpha:!0},(B,D)=>{D.clearRect(0,0,B.width,B.height)}),Ue(y.current,O,[...f,$(I,N)])},le=N=>{const B=$(I,N);B.w*k>=1&&B.h*k>=1&&v(D=>[...D,B]),w.removeEventListener("mousemove",re),w.removeEventListener("mouseup",le)};w.addEventListener("mousemove",re),w.addEventListener("mouseup",le)},L=t.useCallback(m=>C=>{C.preventDefault(),C.stopPropagation(),v(I=>{const $=[...I];return $.splice(m,1),$})},[]),H={width:`${i.canvas.width*k}px`,height:`${i.canvas.height*k}px`},K=m=>{m.stopPropagation()};return e("div",{class:"editor"},e("style",{nonce:o.styleNonce,dangerouslySetInnerHTML:u}),e("div",{class:"editor__image-container"},e("div",{class:"editor__canvas-container",ref:b},e("canvas",{ref:p,id:"background",style:H}),e("canvas",{ref:y,id:"foreground",style:H}),e("div",{ref:F,onMouseDown:z,style:H},f.map((m,C)=>e("div",{key:C,class:"editor__rect",style:{top:`${m.y*k}px`,left:`${m.x*k}px`,width:`${m.w*k}px`,height:`${m.h*k}px`}},e("button",{"aria-label":o.removeHighlightText,onClick:L(C),onMouseDown:K,onMouseUp:K,type:"button"},e(s,null))))))),e(c,{options:o,action:h,setAction:_}))};return function({onError:h}){const[_,f]=t.useState();return a({onBeforeScreenshot:t.useCallback(()=>{l.display="none"},[]),onScreenshot:t.useCallback((v,b)=>{ee(w.createElement("canvas"),{alpha:!1},(p,y)=>{y.scale(b,b),p.width=v.videoWidth,p.height=v.videoHeight,y.drawImage(v,0,0,p.width,p.height),f({canvas:p,dpi:b})}),r.width=v.videoWidth,r.height=v.videoHeight},[]),onAfterScreenshot:t.useCallback(()=>{l.display="block"},[]),onError:t.useCallback(v=>{l.display="block",h(v)},[])}),_?e(d,{screenshot:_}):e("div",null)}}const En=()=>({name:"FeedbackScreenshot",setupOnce(){},createInput:({h:e,hooks:t,dialog:r,options:n})=>{const o=w.createElement("canvas");return{input:un({h:e,hooks:t,outputBuffer:o,dialog:r,options:n}),value:async()=>{const a=await new Promise(c=>{o.toBlob(c,"image/png")});if(a)return{data:new Uint8Array(await a.arrayBuffer()),filename:"screenshot.png",contentType:"application/png"}}}}});export{pn as a,hn as b,Jt as c,gn as d,bn as e,En as f,vn as g,yn as h,mn as i,fn as j,Yt as s};
//# sourceMappingURL=JAgjD1tL.js.map

//# debugId=0f684e44-30c5-5729-8938-afcdf530425a
