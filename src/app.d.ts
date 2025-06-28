// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
	
	// FastLED WASM Module declarations
	interface Window {
		getWasmModule(): any;
		isWasmReady(): boolean;
	}
	
	// FastLED WASM factory function
	declare function fastled(): Promise<any>;
}

export {};
