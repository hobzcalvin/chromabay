#!/usr/bin/env node

/**
 * Simple script to create and deploy live updates for testing
 * Usage: node scripts/deploy-live-update.js [version]
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const version = process.argv[2] || `dev-${Date.now()}`;

console.log(`🚀 Creating live update bundle: ${version}`);

try {
  // Build the app
  console.log('📦 Building app...');
  execSync('npm run build', { stdio: 'inherit' });

  // Create bundles directory if it doesn't exist
  const bundlesDir = './bundles';
  if (!existsSync(bundlesDir)) {
    mkdirSync(bundlesDir);
  }

  // Create zip bundle
  console.log('🗜️ Creating zip bundle...');
  const bundlePath = path.join(bundlesDir, `live-update-${version}.zip`);
  execSync(`cd docs && zip -r "../${bundlePath}" . -x "*.DS_Store"`, { stdio: 'inherit' });

  console.log(`✅ Live update bundle created: ${bundlePath}`);
  console.log(`📱 You can now use this bundle URL in your app for testing live updates`);
  console.log(`\nTo test the live update:`);
  console.log(`1. Host the bundle file on a web server`);
  console.log(`2. Use LiveUpdate.downloadBundle() with the bundle URL`);
  console.log(`3. Call LiveUpdate.setBundle() and LiveUpdate.reload()`);

} catch (error) {
  console.error('❌ Error creating live update bundle:', error.message);
  process.exit(1);
} 