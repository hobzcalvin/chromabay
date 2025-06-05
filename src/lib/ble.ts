import { BleClient } from '@capacitor-community/bluetooth-le';

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
    return await BleClient.isEnabled();
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
    await BleClient.enable();
  } catch (error) {
    console.error('Error enabling BLE:', error);
    throw error;
  }
}

/**
 * Start scanning for BLE devices
 */
export async function startScan(
  callback: (result: any) => void,
  options?: any
): Promise<void> {
  try {
    await BleClient.requestLEScan(options || {}, callback);
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
    await BleClient.stopLEScan();
  } catch (error) {
    console.error('Error stopping BLE scan:', error);
    throw error;
  }
} 