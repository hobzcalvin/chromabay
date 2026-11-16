/**
 * Vitest setup: load the FastLED WASM module under Node and expose it the way
 * the browser does (`window.getWasmModule` / `window.isWasmReady`) BEFORE any
 * test file imports `flowStore`. flowStore enumerates operators from the WASM
 * module at import time, so the globals must be in place first.
 */
import { beforeAll } from 'vitest';
import { loadWasmModule, type WasmModule } from './loadWasm';

declare global {
	// eslint-disable-next-line no-var
	var __wasmModule: WasmModule | undefined;
}

// Top-level await so the globals exist before the test file's imports evaluate.
const wasm = await loadWasmModule();
globalThis.__wasmModule = wasm;
(window as any).getWasmModule = () => wasm;
(window as any).isWasmReady = () => true;

beforeAll(() => {
	// Re-assert in case a test cleared globals.
	(window as any).getWasmModule = () => wasm;
	(window as any).isWasmReady = () => true;
});

// Node >= 25 defines its own global `localStorage`, which is undefined unless node runs with
// --localstorage-file, and it shadows jsdom's. CI (Node 22) never sees this; a newer local Node
// made every test that touches localStorage fail. Give those tests a plain in-memory Storage.
if (typeof globalThis.localStorage?.getItem !== 'function') {
	class MemoryStorage {
		private m = new Map<string, string>();
		get length() { return this.m.size; }
		key(i: number) { return [...this.m.keys()][i] ?? null; }
		getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
		setItem(k: string, v: string) { this.m.set(k, String(v)); }
		removeItem(k: string) { this.m.delete(k); }
		clear() { this.m.clear(); }
	}
	Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
}
