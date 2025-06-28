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
			const nativePath = path.resolve('native');
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
			
			console.log('👀 File watcher setup complete. Watching:', path.resolve('native'));
			
			// Add debug event handlers
			watcher.on('ready', () => {
				console.log('🟢 File watcher is ready and watching for changes');
			});
			
			watcher.on('error', (error) => {
				console.error('❌ File watcher error:', error);
			});
			
			watcher.on('change', async (filePath) => {
				if (isCompiling) return; // Prevent concurrent compilations
				
				console.log(`\n🔧 Native file changed: ${path.relative(process.cwd(), filePath)}`);
				console.log('🚀 Recompiling WASM...');
				
				// Only compile for source files
				if (!/\.(h|ino|cpp|c)$/.test(filePath)) {
					console.log('⏭️  Skipping non-source file');
					return;
				}
				
				isCompiling = true;
				
				try {
					const command = 'fastled';
					const args = ['--just-compile', '--force-compile', '--web'];
					console.log(`🔧 Executing: ${command} ${args.join(' ')}`);
					console.log(`📁 Working directory: ${nativePath}`);
					
					const child = spawn(command, args, {
						cwd: nativePath,
						stdio: 'pipe'
					});
					
					let output = '';
					
					child.stdout?.on('data', (data) => {
						const text = data.toString();
						console.log('📤 STDOUT:', text);
						output += text;
					});
					
					child.stderr?.on('data', (data) => {
						const text = data.toString();
						console.log('📤 STDERR:', text);
						output += text;
					});
					
					child.on('spawn', () => {
						console.log('🚀 FastLED process spawned successfully');
					});
					
					child.on('error', (error) => {
						console.error('❌ Process spawn error:', error);
					});
					
					child.on('close', (code) => {
						console.log(`\n📊 FastLED process exited with code: ${code}`);
						console.log('📋 Full output:');
						console.log(output || '(no output captured)');
						
						if (code === 0) {
							console.log('✅ WASM compilation completed with exit code 0');
							
							// Copy essential files to static directory
							try {
								const staticDir = path.join(process.cwd(), 'static', 'native');
								const sourceDir = path.join(process.cwd(), 'native', 'fastled_js');
								
								// Ensure static/native directory exists
								if (!fs.existsSync(staticDir)) {
									fs.mkdirSync(staticDir, { recursive: true });
								}
								
								// Copy only essential files
								const filesToCopy = ['fastled.js', 'fastled.wasm'];
								filesToCopy.forEach(file => {
									const srcPath = path.join(sourceDir, file);
									const destPath = path.join(staticDir, file);
									if (fs.existsSync(srcPath)) {
										fs.copyFileSync(srcPath, destPath);
										console.log(`📁 Copied ${file} to static/native/`);
									}
								});
								
								console.log('🔄 Triggering browser reload...');
								
								// Trigger full reload to get fresh WASM files
								server.ws.send({
									type: 'full-reload'
								});
							} catch (error) {
								console.error('❌ Failed to copy WASM files:', error);
							}
						} else {
							console.error('❌ WASM compilation failed with non-zero exit code');
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
			
			console.log('👀 Watching native/ directory for WASM recompilation...');
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
				'**/native/fastled_js/**'  // Also ignore in Vite's watcher
			]
		}
	}
});
