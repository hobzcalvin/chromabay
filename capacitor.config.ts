import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.revoltlabs.blumon',
  appName: 'Blumon',
  webDir: 'docs',
  server: {
    androidScheme: 'http',
    iosScheme: 'http'
  },
  plugins: {
    LiveUpdate: {
      // Use GitHub Pages as the live update source
      serverDomain: 'https://hobzcalvin.github.io',
      autoDeleteBundles: true,
      readyTimeout: 10000,
      httpTimeout: 60000
    }
  }
};

export default config;
