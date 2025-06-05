import { browser } from '$app/environment';
import { Capacitor } from '@capacitor/core';

// Initialize live updates when app loads
if (browser && Capacitor.isNativePlatform()) {
  import('@capawesome/capacitor-live-update').then(({ LiveUpdate }) => {
    // Check for updates from GitHub Pages using version manifest
    const checkForUpdates = async () => {
      try {
        console.log('Checking for live updates from GitHub Pages...');
        
        // Get current version info
        const currentVersion = await LiveUpdate.getVersionName();
        console.log('Current version:', currentVersion.versionName);
        
        // Fetch version manifest from GitHub Pages
        const manifestUrl = 'https://hobzcalvin.github.io/blumon/version.json';
        const response = await fetch(manifestUrl);
        
        if (!response.ok) {
          console.log('No version manifest found, skipping update check');
          return;
        }
        
        const manifest = await response.json();
        console.log('Remote version manifest:', manifest);
        
        // Check if there's a newer version available
        if (manifest.version && manifest.version !== currentVersion.versionName) {
          console.log(`Update available: ${manifest.version} (current: ${currentVersion.versionName})`);
          
          // Download the update bundle
          const downloadUrl = `https://hobzcalvin.github.io${manifest.downloadUrl}`;
          const bundleId = `github-pages-${manifest.version}`;
          
          console.log('Downloading update bundle:', downloadUrl);
          
          await LiveUpdate.downloadBundle({
            url: downloadUrl,
            bundleId: bundleId
          });
          
          // Set as next bundle (will be applied on next app restart)
          await LiveUpdate.setNextBundle({
            bundleId: bundleId
          });
          
          console.log('Live update downloaded and queued for next restart:', bundleId);
          
        } else {
          console.log('App is up to date');
        }
        
      } catch (error) {
        console.error('Live update check failed:', error);
      }
    };

    // Check for updates
    checkForUpdates();

    // Mark app as ready to prevent automatic rollback
    LiveUpdate.ready().catch((error) => {
      console.error('Failed to mark app as ready:', error);
    });
  }).catch((error) => {
    console.error('Failed to load LiveUpdate plugin:', error);
  });
}

// Disable prerendering since the app uses browser-specific APIs
export const prerender = false;
export const ssr = false; 