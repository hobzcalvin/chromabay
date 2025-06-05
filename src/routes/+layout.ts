import { browser } from '$app/environment';
import { Capacitor } from '@capacitor/core';

// Track if we've already asked about updates this session
let hasAskedForUpdateThisSession = false;
let isCheckingForUpdates = false;

// Initialize live updates when app loads (only for native platforms)
if (browser && Capacitor.isNativePlatform()) {
  import('@capawesome/capacitor-live-update').then(({ LiveUpdate }) => {
    // Import App plugin for foreground detection
    import('@capacitor/app').then(({ App }) => {
      // Check for updates from GitHub Pages using version manifest
      const checkForUpdates = async () => {
        try {
          // Prevent multiple simultaneous update checks
          if (isCheckingForUpdates) {
            console.log('📱 UPDATE: Update check already in progress, skipping...');
            return;
          }

          // Don't ask again if user already declined this session
          if (hasAskedForUpdateThisSession) {
            console.log('📱 UPDATE: Skipping update check - already asked this session');
            return;
          }

          isCheckingForUpdates = true;
          console.log('📱 UPDATE: Starting update check...');
          
          // Get current version info - this gives us the live update version if available
          console.log('📱 UPDATE: Getting current version info...');
          const [versionInfo, readyInfo] = await Promise.all([
            LiveUpdate.getVersionName(),
            LiveUpdate.ready().catch(() => ({ currentBundleId: null }))
          ]);
          
          let currentVersion: string;
          
          // If we have a live update bundle active, extract version from bundle ID
          if (readyInfo.currentBundleId && readyInfo.currentBundleId.startsWith('github-pages-')) {
            currentVersion = readyInfo.currentBundleId.replace('github-pages-', '');
            console.log('📱 UPDATE: Using live update bundle version:', currentVersion);
          } else {
            // Fallback to app version for fresh installs
            currentVersion = versionInfo.versionName;
            console.log('📱 UPDATE: Using base app version:', currentVersion);
          }
          
          console.log('📱 UPDATE: Current version:', currentVersion);
          
          // Fetch version manifest from GitHub Pages
          const manifestUrl = `https://hobzcalvin.github.io/blumon/version.json?t=${Date.now()}`;
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
          
          // Normalize versions for comparison (remove 'v' prefix if present)
          const normalizeVersion = (version: string) => version.replace(/^v/, '');
          const currentVersionNormalized = normalizeVersion(currentVersion);
          const remoteVersionNormalized = normalizeVersion(manifest.version || '');
          
          console.log('📱 UPDATE: Normalized versions - current:', currentVersionNormalized, 'remote:', remoteVersionNormalized);
          
          // Check if there's a newer version available
          if (remoteVersionNormalized && remoteVersionNormalized !== currentVersionNormalized) {
            console.log(`📱 UPDATE: Update available! ${manifest.version} (current: ${currentVersion})`);
            
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
                
                try {
                  await LiveUpdate.downloadBundle({
                    url: downloadUrl,
                    bundleId: bundleId
                  });
                } catch (downloadError: any) {
                  if (downloadError.errorMessage?.includes('bundle already exists')) {
                    console.log('📱 UPDATE: Bundle already exists, deleting and retrying...');
                    try {
                      await LiveUpdate.deleteBundle({ bundleId });
                      console.log('📱 UPDATE: Old bundle deleted, retrying download...');
                      await LiveUpdate.downloadBundle({
                        url: downloadUrl,
                        bundleId: bundleId
                      });
                    } catch (retryError) {
                      console.error('📱 UPDATE: Retry failed:', retryError);
                      throw retryError;
                    }
                  } else {
                    throw downloadError;
                  }
                }
                
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
        } finally {
          isCheckingForUpdates = false;
        }
      };

      // Check for updates on app start
      checkForUpdates();

      // Check for updates when app comes to foreground
      App.addListener('appStateChange', (state: { isActive: boolean }) => {
        if (state.isActive) {
          console.log('📱 UPDATE: App foregrounded, checking for updates...');
          // Reset session flag when app comes to foreground
          hasAskedForUpdateThisSession = false;
          // Check for updates
          checkForUpdates();
        }
      });

    }).catch((error) => {
      console.error('📱 UPDATE: Failed to load App plugin:', error);
    });

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