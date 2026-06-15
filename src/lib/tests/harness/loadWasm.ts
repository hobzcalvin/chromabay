/**
 * Headless loader for the FastLED WASM module under Node.
 *
 * The browser loads `static/native/fastled.js` via a <script> tag (see
 * `src/app.html`), which assigns a global `fastled` factory. That file is an
 * Emscripten MODULARIZE build with Node support baked in, but it is not an
 * importable ES/CJS module — it just assigns `var fastled = (() => {...})()`.
 *
 * To exercise the exact same operator code the editor and the ESP32 share, we
 * evaluate that script inside a `vm` context (so its `require('fs')` etc. work),
 * grab the factory, and instantiate the module. The resulting object is the same
 * shape the browser exposes as `window.getWasmModule()`.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import path from 'node:path';

export type WasmModule = {
	ccall: (name: string, ret: string | null, argTypes: string[], args: any[]) => any;
	cwrap: (name: string, ret: string | null, argTypes: string[]) => (...args: any[]) => any;
	_malloc: (n: number) => number;
	_free: (p: number) => void;
	HEAPU8: Uint8Array;
	[key: string]: any;
};

let cached: Promise<WasmModule> | null = null;

const WASM_JS_PATH = path.resolve(process.cwd(), 'static/native/fastled.js');

export function loadWasmModule(): Promise<WasmModule> {
	if (!cached) {
		cached = (async () => {
			const src = (await readFile(WASM_JS_PATH, 'utf8')) + '\n;globalThis.__fastledFactory = fastled;';
			const sandbox: Record<string, any> = {
				console,
				process,
				require: createRequire(WASM_JS_PATH),
				__dirname: path.dirname(WASM_JS_PATH),
				__filename: WASM_JS_PATH,
				TextDecoder,
				TextEncoder,
				URL,
				fetch,
				performance,
				setTimeout,
				clearTimeout
			};
			sandbox.globalThis = sandbox;
			vm.createContext(sandbox);
			vm.runInContext(src, sandbox, { filename: WASM_JS_PATH });
			const factory = sandbox.__fastledFactory as (arg?: any) => Promise<WasmModule>;
			if (typeof factory !== 'function') {
				throw new Error('Failed to load fastled WASM factory from static/native/fastled.js');
			}
			return factory({});
		})();
	}
	return cached;
}
