import { Capacitor } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';

// Register the web implementation of the Bluetooth LE plugin
if (Capacitor.getPlatform() === 'web') {
  // Import and register the web implementation
  import('@capacitor-community/bluetooth-le/dist/esm/web')
    .then(module => {
      const { BluetoothLeWeb } = module;
      // Register the web implementation
      registerPlugin('BluetoothLe', {
        web: () => new BluetoothLeWeb()
      });
      console.log('Bluetooth LE web plugin registered');
    })
    .catch(error => {
      console.error('Failed to load Bluetooth LE web plugin:', error);
    });
} 