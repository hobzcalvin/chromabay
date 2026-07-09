import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.revoltlabs.chromabay',
  appName: 'ChromaBay',
  webDir: 'build',
  server: {
    androidScheme: 'http',
    iosScheme: 'http'
  },
  plugins: {
    LiveUpdate: {
      // Use GitHub Pages as the live update source
      serverDomain: 'https://chromabay.app',
      autoDeleteBundles: true,
      readyTimeout: 10000,
      httpTimeout: 60000
    }
  }
};

export default config;
