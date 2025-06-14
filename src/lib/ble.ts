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

// Configuration for ESP32 service UUIDs
let esp32ServiceUUIDs: string[] = [
  // LED Service (Blumon custom service) - ONLY service to look for
  'a0be83e4-8dc9-47f0-ab40-b19721d20ed1'
];

/**
 * Configure ESP32 service UUIDs for Web Bluetooth
 * Call this before scanning to add your custom service UUIDs
 * 
 * IMPORTANT FOR WEB BLUETOOTH:
 * If your ESP32 uses custom service UUIDs, you MUST add them here
 * or they won't be accessible in web browsers.
 * 
 * @param serviceUUIDs Array of service UUID strings
 */
export function configureESP32Services(serviceUUIDs: string[]): void {
  esp32ServiceUUIDs = [...esp32ServiceUUIDs, ...serviceUUIDs];
  console.log('Configured ESP32 services:', esp32ServiceUUIDs);
}

/**
 * Add a single ESP32 service UUID
 * @param serviceUUID Single service UUID string
 */
export function addESP32Service(serviceUUID: string): void {
  if (!esp32ServiceUUIDs.includes(serviceUUID)) {
    esp32ServiceUUIDs.push(serviceUUID);
    console.log('Added ESP32 service:', serviceUUID);
  }
}

/**
 * Get current ESP32 service UUIDs
 */
export function getESP32Services(): string[] {
  return [...esp32ServiceUUIDs];
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
 * IMPORTANT: For web, this MUST be called directly from a user interaction event handler
 */
export async function startScan(
  callback: (result: any) => void,
  options?: any
): Promise<void> {
  if (isWeb()) {
    // For web, we need to call requestDevice synchronously from user gesture
    return startWebBluetoothScan(callback, options);
  } else {
    // Use native scanning for iOS/Android
    try {
      await BleClient.requestLEScan(options || {}, callback);
    } catch (error) {
      console.error('Error starting BLE scan:', error);
      throw error;
    }
  }
}

/**
 * Start Web Bluetooth device selection
 * This function must be called directly from a user interaction event handler
 */
function startWebBluetoothScan(
  callback: (result: any) => void,
  options?: any
): Promise<void> {
  // Only look for the specific LED service UUID
  const commonServiceUUIDs = [
    // LED Service (Blumon custom service) - ONLY service to look for
    'a0be83e4-8dc9-47f0-ab40-b19721d20ed1',
    ...esp32ServiceUUIDs,
    ...((options?.services || []) as string[])
  ];

  // Return a promise that resolves immediately with the device selection
  return new Promise((resolve, reject) => {
    // First try with specific filters
    navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'ESP32' },
        { namePrefix: 'esp32' },
        { namePrefix: 'Arduino' },
        { namePrefix: 'MyESP32' },
        { namePrefix: 'Blumon' },
        { namePrefix: 'blumon' }
      ],
      optionalServices: commonServiceUUIDs
    }).then(device => {
      callback({
        device: {
          deviceId: device.id,
          name: device.name || 'Unknown Device',
          webDevice: device
        }
      });
      resolve();
    }).catch(filterError => {
      console.log('Filtered device selection failed, trying acceptAllDevices...', filterError);
      
      // Fallback to acceptAllDevices if filtering fails
      navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: commonServiceUUIDs
      }).then(device => {
        callback({
          device: {
            deviceId: device.id,
            name: device.name || 'Unknown Device',
            webDevice: device
          }
        });
        resolve();
      }).catch(error => {
        console.error('Error starting BLE scan:', error);
        reject(error);
      });
    });
  });
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
      
      console.log('Starting Web Bluetooth service discovery...');
      
      // Check if GATT server is still connected
      if (!deviceInfo.gattServer.connected) {
        console.log('GATT server disconnected, attempting to reconnect...');
        deviceInfo.gattServer = await deviceInfo.device.gatt.connect();
      }
      
      // Add retry logic with delay for ESP32 service initialization
      let services: any[] = [];
      let retryCount = 0;
      const maxRetries = 5; // Increased retries for ESP32
      const retryDelay = 2000; // Increased delay to 2 seconds
      
      while (retryCount < maxRetries && services.length === 0) {
        try {
          if (retryCount > 0) {
            console.log(`Retrying service discovery (attempt ${retryCount + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
          
          // Try to get all primary services
          const primaryServices = await deviceInfo.gattServer.getPrimaryServices();
          console.log(`Found ${primaryServices.length} primary services:`, 
            primaryServices.map((s: any) => s.uuid));
          
          if (primaryServices.length === 0) {
            console.log('No primary services found, retrying...');
            retryCount++;
            continue;
          }
          
          // Process each service and get its characteristics
          const serviceList = await Promise.allSettled(
            primaryServices.map(async (service: any) => {
              try {
                console.log(`Processing service: ${service.uuid}`);
                const characteristics = await service.getCharacteristics();
                console.log(`Service ${service.uuid} has ${characteristics.length} characteristics:`,
                  characteristics.map((c: any) => c.uuid));
                
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
              } catch (charError: any) {
                console.warn(`Error getting characteristics for service ${service.uuid}:`, charError);
                // Still return the service even if characteristics fail
                return {
                  uuid: service.uuid,
                  characteristics: [],
                  error: charError.message
                };
              }
            })
          );
          
          // Filter successful results and include failed ones with errors
          services = serviceList
            .map(result => result.status === 'fulfilled' ? result.value : null)
            .filter(service => service !== null);
          
          console.log(`Successfully processed ${services.length} services`);
          deviceInfo.services = services;
          break;
          
        } catch (discoveryError) {
          console.warn(`Service discovery attempt ${retryCount + 1} failed:`, discoveryError);
          retryCount++;
          if (retryCount >= maxRetries) {
            console.error('All service discovery attempts failed');
            throw discoveryError;
          }
        }
      }
      
      if (services.length === 0) {
        console.warn('No services found after all retry attempts.');
        console.log('This could mean:');
        console.log('1. The ESP32 is not advertising any services');
        console.log('2. The services need to be explicitly requested during device selection');
        console.log('3. The ESP32 firmware may need time to initialize services');
        console.log('4. The device may require bonding/pairing first');
        
        // Return empty array instead of throwing error to allow manual retry
        return [];
      }
      
      console.log(`Service discovery completed successfully with ${services.length} services`);
      return services;
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
/**
 * Get an array of currently connected device IDs
 */
export function getConnectedDevices(): string[] {
  return Array.from(connectedDevices.keys());
}

/**
 * Get the count of currently connected devices
 */
export function getConnectedDeviceCount(): number {
  return connectedDevices.size;
}
