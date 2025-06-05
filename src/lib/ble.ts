import { BleClient } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';

/**
 * Check if we're running in a web browser
 */
function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

/**
 * Initialize the Bluetooth Low Energy client
 * This should be called once when the app starts
 */
export async function initBle(): Promise<void> {
  try {
    await BleClient.initialize();
    console.log('BLE Client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize BLE client:', error);
    throw error;
  }
}

/**
 * Check if Bluetooth is enabled and available
 */
export async function isBleEnabled(): Promise<boolean> {
  try {
    if (isWeb()) {
      // For web, check if Web Bluetooth API is available
      return !!navigator.bluetooth;
    } else {
      return await BleClient.isEnabled();
    }
  } catch (error) {
    console.error('Error checking BLE status:', error);
    return false;
  }
}

/**
 * Request Bluetooth permissions and enable if needed
 */
export async function enableBle(): Promise<void> {
  try {
    if (isWeb()) {
      // Web Bluetooth doesn't have a direct "enable" method
      // The user will be prompted when we try to scan
      console.log('Web Bluetooth will prompt for permissions during device selection');
    } else {
      await BleClient.enable();
    }
  } catch (error) {
    console.error('Error enabling BLE:', error);
    throw error;
  }
}

/**
 * Start scanning for BLE devices
 * On web, this uses requestDevice instead of requestLEScan
 */
export async function startScan(
  callback: (result: any) => void,
  options?: any
): Promise<void> {
  try {
    if (isWeb()) {
      // Use Web Bluetooth API's requestDevice for web browsers
      // This shows a device picker dialog instead of continuous scanning
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: options?.services || []
      });
      
      // Simulate the callback format for consistency with native apps
      callback({
        device: {
          deviceId: device.id,
          name: device.name || 'Unknown Device'
        }
      });
    } else {
      // Use native scanning for iOS/Android
      await BleClient.requestLEScan(options || {}, callback);
    }
  } catch (error) {
    console.error('Error starting BLE scan:', error);
    throw error;
  }
}

/**
 * Stop scanning for BLE devices
 */
export async function stopScan(): Promise<void> {
  try {
    if (isWeb()) {
      // Web Bluetooth's requestDevice is a one-time selection, no need to stop
      console.log('Web Bluetooth device selection completed');
    } else {
      await BleClient.stopLEScan();
    }
  } catch (error) {
    console.error('Error stopping BLE scan:', error);
    throw error;
  }
} 