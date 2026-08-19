import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { spawn } from 'child_process';
import { watch } from 'chokidar';
import path from 'path';

// Custom plugin to watch native/ and recompile the WASM preview on change via our
// self-hosted build (native/build-wasm.sh, which also deploys to static/native).
function fastledWatcher(): Plugin {
	return {
		name: 'fastled-watcher',
		configureServer(server: ViteDevServer) {
			const buildScript = path.resolve('native', 'build-wasm.sh');
			let isCompiling = false;
			let pending = false;

			function compile() {
				if (isCompiling) { pending = true; return; } // coalesce edits during a build
				isCompiling = true;

				// `bash native/build-wasm.sh` — same command as `npm run wasm:compile`.
				const child = spawn('bash', [buildScript], { cwd: process.cwd(), stdio: 'pipe' });

				let output = '';
				child.stdout?.on('data', (data) => { output += data.toString(); });
				child.stderr?.on('data', (data) => { output += data.toString(); });

				// CRITICAL: handle spawn failure (e.g. ENOENT) here. Without an 'error'
				// listener Node throws an unhandled 'error' event that crashes the whole
				// dev server — which is exactly what used to happen.
				child.on('error', (err) => {
					console.error('❌ Could not run native/build-wasm.sh:', err.message);
					isCompiling = false;
					runPending();
				});

				child.on('close', (code) => {
					if (code === 0) {
						console.log('✅ WASM compiled → browser reloading...');
						server.ws.send({ type: 'full-reload' });
					} else {
						console.error('❌ WASM compilation failed (exit ' + code + ')');
						console.log(output);
					}
					isCompiling = false;
					runPending();
				});
			}

			function runPending() {
				if (pending) { pending = false; compile(); }
			}

			// Watch native/ source files, ignoring build output + the FastLED checkout.
			const watcher = watch('native', {
				ignored: [
					'**/fastled_js/**',     // build output
					'**/.fastled-src/**',   // bootstrapped FastLED source
					'**/node_modules/**'
				],
				ignoreInitial: true,
				persistent: true,
				usePolling: false
			});

			console.log('👀 Watching native/ for WASM auto-compilation...');

			watcher.on('change', (filePath) => {
				if (!/\.(h|ino|cpp|c)$/.test(filePath)) return; // source files only
				console.log(`🔧 ${path.basename(filePath)} changed → compiling WASM...`);
				compile();
			});

			// Cleanup on server close
			server.httpServer?.on('close', () => {
				watcher.close();
			});
		}
	};
}

export default defineConfig({
	plugins: [sveltekit(), fastledWatcher()],
	build: {
		// Emit source maps so Sentry can turn `app.DM-_Jxoa.js:18` back into a file and a
		// line. They are uploaded to Sentry and then DELETED before publishing (deploy.yml)
		// — this repo is private while the site is public, so shipping them would publish
		// the source along with it.
		sourcemap: true
	},
	server: {
		watch: {
			ignored: [
				'**/ios/**',
				'**/android/**',
				'**/node_modules/**',
				'**/native/fastled_js/**'
			]
		}
	}
});
