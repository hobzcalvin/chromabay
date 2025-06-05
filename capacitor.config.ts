import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.revoltlabs.blumon',
  appName: 'Blumon',
  webDir: 'docs',
  server: {
    androidScheme: 'http',
    iosScheme: 'http'
  }
};

export default config;
