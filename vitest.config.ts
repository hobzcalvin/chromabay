import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Standalone Vitest config (kept separate from vite.config.ts, which carries the
// SvelteKit + FastLED-watcher plugins that aren't needed — and get in the way —
// for headless unit tests).
export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib'),
			// The real package is a Svelte component library that can't load under
			// Node; the engine code only needs its types + the MarkerType enum.
			'@xyflow/svelte': path.resolve('./src/lib/tests/harness/xyflow-stub.ts')
		}
	},
	test: {
		environment: 'jsdom',
		include: ['src/**/*.test.ts'],
		setupFiles: ['./src/lib/tests/harness/setup.ts'],
		// The WASM module + operator enumeration is shared process state; keep it
		// simple and deterministic by running files serially.
		pool: 'forks',
		fileParallelism: false,
		testTimeout: 20000,
		hookTimeout: 30000
	}
});
