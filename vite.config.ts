import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { spawn } from 'child_process';
import { watch } from 'chokidar';
import path from 'path';
import fs from 'fs';

// Custom plugin to watch native directory and recompile WASM
function fastledWatcher(): Plugin {
	return {
		name: 'fastled-watcher',
		configureServer(server: ViteDevServer) {
			let isCompiling = false;
			
			// Watch native directory, but ignore the output folder
			const watcher = watch('native', {
				ignored: [
					'**/fastled_js/**',  // Ignore output to prevent loops
					'**/node_modules/**'
				],
				ignoreInitial: true,
				persistent: true,
				usePolling: false
			});
			
			console.log('👀 Watching native/ for WASM auto-compilation...');
			
			watcher.on('change', async (filePath) => {
				if (isCompiling) return;
				
				// Only compile for source files
				if (!/\.(h|ino|cpp|c)$/.test(filePath)) return;
				
				console.log(`🔧 ${path.basename(filePath)} changed → compiling WASM...`);
				isCompiling = true;
				
				try {
					const child = spawn('fastled', ['--just-compile', '--force-compile', '--web'], {
						cwd: path.resolve('native'),
						stdio: 'pipe'
					});
					
					let output = '';
					child.stdout?.on('data', (data) => { output += data.toString(); });
					child.stderr?.on('data', (data) => { output += data.toString(); });
					
					child.on('close', (code) => {
						if (code === 0) {
							// Copy essential files to static directory
							try {
								const staticDir = path.join(process.cwd(), 'static', 'native');
								const sourceDir = path.join(process.cwd(), 'native', 'fastled_js');
								
								if (!fs.existsSync(staticDir)) {
									fs.mkdirSync(staticDir, { recursive: true });
								}
								
								const filesToCopy = ['fastled.js', 'fastled.wasm'];
								filesToCopy.forEach(file => {
									const srcPath = path.join(sourceDir, file);
									const destPath = path.join(staticDir, file);
									if (fs.existsSync(srcPath)) {
										fs.copyFileSync(srcPath, destPath);
									}
								});
								
								console.log('✅ WASM compiled → browser reloading...');
								server.ws.send({ type: 'full-reload' });
							} catch (error) {
								console.error('❌ Failed to copy WASM files:', error);
							}
						} else {
							console.error('❌ WASM compilation failed');
							// Only show full output on error
							console.log(output);
						}
						isCompiling = false;
					});
					
				} catch (error) {
					console.error('❌ Failed to start WASM compilation:', error);
					isCompiling = false;
				}
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
