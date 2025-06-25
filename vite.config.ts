import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

// Custom plugin to build FastLED WASM
function fastledWasmPlugin() {
	return {
		name: 'fastled-wasm',
		buildStart() {
			const nativeDir = path.resolve('src/native');
			
			// Always rebuild WASM to ensure it's up to date
			console.log('🔧 Building FastLED WASM module...');
			try {
				// Ensure emscripten is set up first
				execSync('npm run setup:emscripten', { stdio: 'inherit' });
				execSync('make wasm', { 
					cwd: nativeDir, 
					stdio: 'inherit'
				});
				console.log('✅ FastLED WASM module built successfully');
			} catch (error) {
				console.error('❌ Failed to build FastLED WASM module:', error);
				throw error; // Fail the build if WASM can't be built
			}
		},
		// Watch native files for changes
		configureServer(server: any) {
			const nativeGlob = 'src/native/**/*.{cpp,h}';
			server.watcher.add(nativeGlob);
			server.watcher.on('change', (file: string) => {
				if (file.includes('src/native/')) {
					console.log('🔧 Native file changed, rebuilding WASM...');
					try {
						execSync('npm run setup:emscripten', { stdio: 'inherit' });
						execSync('make wasm', { 
							cwd: path.resolve('src/native'), 
							stdio: 'inherit'
						});
						console.log('✅ FastLED WASM module rebuilt');
						// Trigger HMR
						server.ws.send({
							type: 'full-reload'
						});
					} catch (error) {
						console.error('❌ WASM rebuild failed:', error);
					}
				}
			});
		}
	};
}

export default defineConfig({
	plugins: [
		sveltekit(),
		fastledWasmPlugin()
	],
	server: {
		watch: {
			ignored: [
				'**/ios/**',
				'**/android/**',
				'**/node_modules/**'
			]
		}
	},
	// Allow WASM files to be served and include them in build
	assetsInclude: ['**/*.wasm'],
	// Ensure WASM files are copied to the output
	publicDir: 'static',
	build: {
		// Ensure WASM files are handled properly
		rollupOptions: {
			external: [],
			output: {
				// Don't inline WASM files
				assetFileNames: (assetInfo) => {
					if (assetInfo.name?.endsWith('.wasm')) {
						return 'wasm/[name].[hash][extname]';
					}
					return 'assets/[name].[hash][extname]';
				}
			}
		}
	},
	// Enable proper WASM loading
	optimizeDeps: {
		exclude: ['./wasm/fastled_operators.js']
	}
});
