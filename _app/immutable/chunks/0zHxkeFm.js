
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="d44c49ea-e345-5a65-915b-431e3c0201fd")}catch(e){}}();
import{W as t}from"./B02LB3Sw.js";class s extends t{constructor(){super(),this.handleVisibilityChange=()=>{const e={isActive:document.hidden!==!0};this.notifyListeners("appStateChange",e),document.hidden?this.notifyListeners("pause",null):this.notifyListeners("resume",null)},document.addEventListener("visibilitychange",this.handleVisibilityChange,!1)}exitApp(){throw this.unimplemented("Not implemented on web.")}async getInfo(){throw this.unimplemented("Not implemented on web.")}async getLaunchUrl(){return{url:""}}async getState(){return{isActive:document.hidden!==!0}}async minimizeApp(){throw this.unimplemented("Not implemented on web.")}}export{s as AppWeb};
//# sourceMappingURL=0zHxkeFm.js.map

//# debugId=d44c49ea-e345-5a65-915b-431e3c0201fd
