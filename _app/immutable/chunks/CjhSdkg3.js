
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="230c3718-cf08-5d0f-bc7b-05d8628f994f")}catch(e){}}();
import{W as t}from"./j6KWyC52.js";class s extends t{constructor(){super(),this.handleVisibilityChange=()=>{const e={isActive:document.hidden!==!0};this.notifyListeners("appStateChange",e),document.hidden?this.notifyListeners("pause",null):this.notifyListeners("resume",null)},document.addEventListener("visibilitychange",this.handleVisibilityChange,!1)}exitApp(){throw this.unimplemented("Not implemented on web.")}async getInfo(){throw this.unimplemented("Not implemented on web.")}async getLaunchUrl(){return{url:""}}async getState(){return{isActive:document.hidden!==!0}}async minimizeApp(){throw this.unimplemented("Not implemented on web.")}}export{s as AppWeb};
//# sourceMappingURL=CjhSdkg3.js.map

//# debugId=230c3718-cf08-5d0f-bc7b-05d8628f994f
