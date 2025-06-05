import { BleClient } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';

/**
 * Check if we're running in a web browser
 */
function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

// Store connected devices and their GATT servers
const connectedDevices = new Map<string, any>();

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
          name: device.name || 'Unknown Device',
          webDevice: device // Store the actual web device for later connection
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

/**
 * Connect to a BLE device
 */
export async function connectToDevice(device: any): Promise<void> {
  try {
    if (isWeb()) {
      // For web, connect to the GATT server
      const gattServer = await device.webDevice.gatt.connect();
      connectedDevices.set(device.deviceId, {
        device: device.webDevice,
        gattServer: gattServer,
        services: null
      });
      console.log('Connected to device via Web Bluetooth');
    } else {
      // For native platforms, use Capacitor BLE client
      await BleClient.connect(device.deviceId);
      connectedDevices.set(device.deviceId, { device: device });
      console.log('Connected to device via Capacitor');
    }
  } catch (error) {
    console.error('Error connecting to device:', error);
    throw error;
  }
}

/**
 * Disconnect from a BLE device
 */
export async function disconnectFromDevice(deviceId: string): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (deviceInfo?.gattServer) {
        deviceInfo.gattServer.disconnect();
      }
    } else {
      await BleClient.disconnect(deviceId);
    }
    connectedDevices.delete(deviceId);
    console.log('Disconnected from device');
  } catch (error) {
    console.error('Error disconnecting from device:', error);
    throw error;
  }
}

/**
 * Check if a device is connected
 */
export function isDeviceConnected(deviceId: string): boolean {
  return connectedDevices.has(deviceId);
}

/**
 * Discover services on a connected device
 */
export async function discoverServices(deviceId: string): Promise<any[]> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      
      const services = await deviceInfo.gattServer.getPrimaryServices();
      const serviceList = await Promise.all(
        services.map(async (service: any) => {
          const characteristics = await service.getCharacteristics();
          return {
            uuid: service.uuid,
            characteristics: characteristics.map((char: any) => ({
              uuid: char.uuid,
              properties: {
                read: char.properties.read,
                write: char.properties.write || char.properties.writeWithoutResponse,
                notify: char.properties.notify,
                indicate: char.properties.indicate
              }
            }))
          };
        })
      );
      
      deviceInfo.services = serviceList;
      return serviceList;
    } else {
      const services = await BleClient.getServices(deviceId);
      return services;
    }
  } catch (error) {
    console.error('Error discovering services:', error);
    throw error;
  }
}

/**
 * Read from a characteristic
 */
export async function readCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<string> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      const value = await characteristic.readValue();
      
      // Convert ArrayBuffer to string
      return new TextDecoder().decode(value);
    } else {
      const result = await BleClient.read(deviceId, serviceUuid, characteristicUuid);
      return new TextDecoder().decode(result);
    }
  } catch (error) {
    console.error('Error reading characteristic:', error);
    throw error;
  }
}

/**
 * Write to a characteristic
 */
export async function writeCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string, data: string): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      const encoder = new TextEncoder();
      await characteristic.writeValue(encoder.encode(data));
    } else {
      const encoder = new TextEncoder();
      const dataView = new DataView(encoder.encode(data).buffer);
      await BleClient.write(deviceId, serviceUuid, characteristicUuid, dataView);
    }
    console.log('Successfully wrote to characteristic');
  } catch (error) {
    console.error('Error writing to characteristic:', error);
    throw error;
  }
}

/**
 * Start notifications on a characteristic
 */
export async function startNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string, callback: (data: string) => void): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      
      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        const value = new TextDecoder().decode(event.target.value);
        callback(value);
      });
    } else {
      await BleClient.startNotifications(deviceId, serviceUuid, characteristicUuid, (value) => {
        const stringValue = new TextDecoder().decode(value);
        callback(stringValue);
      });
    }
    console.log('Started notifications');
  } catch (error) {
    console.error('Error starting notifications:', error);
    throw error;
  }
}

/**
 * Stop notifications on a characteristic
 */
export async function stopNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.stopNotifications();
    } else {
      await BleClient.stopNotifications(deviceId, serviceUuid, characteristicUuid);
    }
    console.log('Stopped notifications');
  } catch (error) {
    console.error('Error stopping notifications:', error);
    throw error;
  }
} 