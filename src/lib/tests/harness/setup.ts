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
