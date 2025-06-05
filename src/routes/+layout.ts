import { browser } from '$app/environment';
import { Capacitor } from '@capacitor/core';

// Track if we've already asked about updates this session
let hasAskedForUpdateThisSession = false;

// Initialize live updates when app loads (only for native platforms)
if (browser && Capacitor.isNativePlatform()) {
  import('@capawesome/capacitor-live-update').then(({ LiveUpdate }) => {
    // Check for updates from GitHub Pages using version manifest
    const checkForUpdates = async () => {
      try {
        // Don't ask again if user already declined this session
        if (hasAskedForUpdateThisSession) {
          console.log('📱 UPDATE: Skipping update check - already asked this session');
          return;
        }

        console.log('📱 UPDATE: Starting update check...');
        
        // Get current version info
        console.log('📱 UPDATE: Getting current version...');
        const currentVersion = await LiveUpdate.getVersionName();
        console.log('📱 UPDATE: Current version:', currentVersion.versionName);
        
        // Fetch version manifest from GitHub Pages
        const manifestUrl = 'https://hobzcalvin.github.io/blumon/version.json';
        console.log('📱 UPDATE: Fetching manifest from:', manifestUrl);
        
        const response = await fetch(manifestUrl);
        console.log('📱 UPDATE: Manifest response status:', response.status);
        console.log('📱 UPDATE: Manifest response ok:', response.ok);
        
        if (!response.ok) {
          console.log('📱 UPDATE: No version manifest found, skipping update check');
          return;
        }
        
        const manifest = await response.json();
        console.log('📱 UPDATE: Remote version manifest:', JSON.stringify(manifest, null, 2));
        
        // Check if there's a newer version available
        if (manifest.version && manifest.version !== currentVersion.versionName) {
          console.log(`📱 UPDATE: Update available! ${manifest.version} (current: ${currentVersion.versionName})`);
          
          // Mark that we've asked this session
          hasAskedForUpdateThisSession = true;
          
          // Ask user if they want to update
          console.log('📱 UPDATE: Asking user for confirmation...');
          const userConfirmed = confirm(`A new version (${manifest.version}) is available. Would you like to update and restart the app now?`);
          console.log('📱 UPDATE: User confirmed:', userConfirmed);
          
          if (userConfirmed) {
            // User wants to update
            try {
              // Download the update bundle
              const downloadUrl = manifest.downloadUrl;
              const bundleId = `github-pages-${manifest.version}`;
              
              console.log('📱 UPDATE: Starting download...');
              console.log('📱 UPDATE: Download URL:', downloadUrl);
              console.log('📱 UPDATE: Bundle ID:', bundleId);
              
              await LiveUpdate.downloadBundle({
                url: downloadUrl,
                bundleId: bundleId
              });
              
              console.log('📱 UPDATE: Download completed successfully');
              
              // Set as next bundle and reload
              console.log('📱 UPDATE: Setting next bundle...');
              await LiveUpdate.setNextBundle({
                bundleId: bundleId
              });
              
              console.log('📱 UPDATE: Next bundle set, reloading app...');
              
              // Reload the app to apply the update
              await LiveUpdate.reload();
              
            } catch (error) {
              console.error('📱 UPDATE: Update download/apply failed:', error);
              console.error('📱 UPDATE: Error details:', JSON.stringify(error, null, 2));
              alert('Failed to download or apply the update. Please try again later.');
            }
          } else {
            console.log('📱 UPDATE: User declined update');
          }
          
        } else {
          console.log('📱 UPDATE: App is up to date');
        }
        
      } catch (error) {
        console.error('📱 UPDATE: Live update check failed:', error);
        console.error('📱 UPDATE: Error details:', JSON.stringify(error, null, 2));
      }
    };

    // Check for updates
    checkForUpdates();

    // Mark app as ready to prevent automatic rollback
    LiveUpdate.ready().catch((error) => {
      console.error('📱 UPDATE: Failed to mark app as ready:', error);
    });
  }).catch((error) => {
    console.error('📱 UPDATE: Failed to load LiveUpdate plugin:', error);
  });
}

// Disable prerendering since the app uses browser-specific APIs
export const prerender = false;
export const ssr = false; 