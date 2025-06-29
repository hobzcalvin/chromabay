import { BleClient, numbersToDataView, dataViewToNumbers, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
// @ts-ignore - MessagePack types issue
import * as msgpack from '@msgpack/msgpack';
const msgpackEncode = msgpack.encode;
const msgpackDecode = msgpack.decode;
import { serializeCurrentPattern } from './flowStore';

/**
 * Check if we're running in a web browser
 */
function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

// Store connected devices and their GATT servers (internal BLE tracking)
const connectedDevices = new Map<string, any>();

// Import device store for UI state management
import { removeConnectedDevice, addConnectedDevice, updateDeviceInfo } from './stores/deviceStore';

// Blumon LED Service UUID - the only service we care about for general commands
const LED_SERVICE_UUID = 'a0be83e4-8dc9-47f0-ab40-b19721d20ed1';
// Original RX/TX Characteristics (still useful for general commands)
const CHARACTERISTIC_UUID_RX = 'a0be83e5-8dc9-47f0-ab40-b19721d20ed1';
const CHARACTERISTIC_UUID_TX = 'a0be83e6-8dc9-47f0-ab40-b19721d20ed1';

// New OTA Characteristics (within the same LED_SERVICE_UUID)
const CHARACTERISTIC_UUID_DEVICE_INFO = "a0be83e7-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_OTA_CONTROL = "a0be83e8-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_OTA_DATA    = "a0be83e9-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_OTA_STATUS  = "a0be83ea-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_OTA_SIGNATURE = "a0be83eb-8dc9-47f0-ab40-b19721d20ed1";

// Pattern Sync Characteristic - for sending messagepack-encoded patterns
const CHARACTERISTIC_UUID_PATTERN_SYNC = "a0be83ec-8dc9-47f0-ab40-b19721d20ed1";

// LED Configuration Characteristics - for getting/setting strip configuration
const CHARACTERISTIC_UUID_LED_CONFIG_GET = "a0be83ed-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_LED_CONFIG_SET = "a0be83ee-8dc9-47f0-ab40-b19721d20ed1";

// Timestamp Sync Characteristic - for synchronizing time across devices
const CHARACTERISTIC_UUID_TIMESTAMP_SYNC = "a0be83ef-8dc9-47f0-ab40-b19721d20ed1";

const MAX_BLE_CHUNK_SIZE = 500; // Should match ESP32's definition

// --- OTA Interfaces ---
export interface DeviceInfo {
  fw_ver: string;
  hw_ver: string;
  heap?: number;
}

export interface FirmwareRegistryEntry {
  version: string;          // e.g., "esp32-v1.0.1"
  hardwareVersion: string;  // e.g., "esp32-hw-v1.0"
  path: string;             // Relative path to firmware.bin on gh-pages
  signaturePath: string;    // Relative path to firmware.sig on gh-pages
  date: string;             // ISO 8601 date string
}

export interface OTAUpdateStatus {
  progress?: number; // 0-100
  statusMessage: string;
  error?: string;
  isComplete?: boolean;
  isError?: boolean;
}

// --- UTF-8 Decoder ---
/**
 * Decodes a DataView object as a UTF-8 string.
 * Uses TextDecoder if available, otherwise falls back to the library's dataViewToText.
 * @param dataView The DataView to decode.
 * @returns The decoded string.
 */
function decodeDataViewAsUtf8(dataView: DataView): string {
  if (typeof TextDecoder !== 'undefined') {
    try {
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(dataView);
    } catch (e) {
      console.warn('[BLE] TextDecoder failed, falling back to dataViewToText:', e);
      return dataViewToText(dataView); // Fallback
    }
  } else {
    // console.warn('[BLE] TextDecoder not available, using library\'s dataViewToText.'); // Less verbose
    return dataViewToText(dataView); // Fallback if TextDecoder is not supported
  }
}


// --- Existing BLE Functions ---

export async function initBle(): Promise<void> {
  try {
    await BleClient.initialize();
    console.log('BLE Client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize BLE client:', error);
    throw error;
  }
}

export async function isBleEnabled(): Promise<boolean> {
  try {
    if (isWeb()) {
      return !!navigator.bluetooth;
    } else {
      return await BleClient.isEnabled();
    }
  } catch (error) {
    console.error('Error checking BLE status:', error);
    return false;
  }
}

export async function enableBle(): Promise<void> {
  try {
    if (isWeb()) {
      console.log('Web Bluetooth will prompt for permissions during device selection');
    } else {
      await BleClient.enable();
    }
  } catch (error) {
    console.error('Error enabling BLE:', error);
    throw error;
  }
}

export async function startScan(
  callback: (result: any) => void
): Promise<void> {
  if (isWeb()) {
    return startWebBluetoothScan(callback);
  } else {
    try {
      await BleClient.requestLEScan({
        services: [LED_SERVICE_UUID] 
      }, callback);
    } catch (error) {
      console.error('Error starting BLE scan:', error);
      throw error;
    }
  }
}

function startWebBluetoothScan(
  callback: (result: any) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    navigator.bluetooth.requestDevice({
      filters: [
        { services: [LED_SERVICE_UUID] }
      ],
      optionalServices: [LED_SERVICE_UUID] 
    }).then(async (device) => {
      const deviceInfo = {
        deviceId: device.id,
        name: device.name || 'Unknown Device',
        webDevice: device 
      };
      
      // For web, automatically connect after selection
      try {
        await connectToDevice(deviceInfo);
        callback({
          device: deviceInfo,
          autoConnected: true
        });
      } catch (error) {
        // If auto-connect fails, still call callback but mark as failed
        callback({
          device: deviceInfo,
          autoConnected: false,
          connectError: error
        });
      }
      
      resolve();
    }).catch(error => {
      console.error('Error selecting BLE device:', error);
      reject(error);
    });
  });
}

export async function stopScan(): Promise<void> {
  try {
    if (isWeb()) {
      console.log('Web Bluetooth device selection completed');
    } else {
      await BleClient.stopLEScan();
    }
  } catch (error) {
    console.error('Error stopping BLE scan:', error);
    throw error;
  }
}

export async function connectToDevice(device: any): Promise<void> {
  try {
    if (isWeb()) {
      const gattServer = await device.webDevice.gatt.connect();
      
      // Listen for disconnection events
      device.webDevice.addEventListener('gattserverdisconnected', () => {
        console.log('Device disconnected via GATT event');
        connectedDevices.delete(device.deviceId);
        removeConnectedDevice(device.deviceId);
      });
      
      connectedDevices.set(device.deviceId, {
        device: device.webDevice,
        gattServer: gattServer,
        services: null
      });
      console.log('Connected to device via Web Bluetooth');
      
      // Start timestamp synchronization for this device
      startTimestampSync(device.deviceId);
    } else {
      await BleClient.connect(device.deviceId);
      connectedDevices.set(device.deviceId, { device: device }); // Store native device info
      console.log('Connected to device via Capacitor');
      
      // Start timestamp synchronization for this device
      startTimestampSync(device.deviceId);
    }
    
    // Add to device store for UI state management
    addConnectedDevice({
      deviceId: device.deviceId,
      name: device.name || 'Unknown Device',
      webDevice: device.webDevice,
      services: [],
      lastConnected: Date.now()
    });
    
  } catch (error) {
    console.error('Error connecting to device:', error);
    throw error;
  }
}

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
    removeConnectedDevice(deviceId);
    
    // Stop timestamp synchronization for this device
    stopTimestampSync(deviceId);
    
    console.log('Disconnected from device');
  } catch (error) {
    console.error('Error disconnecting from device:', error);
    throw error;
  }
}

export function isDeviceConnected(deviceId: string): boolean {
  return connectedDevices.has(deviceId);
}

export async function discoverServices(deviceId: string): Promise<any[]> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) {
        throw new Error('Device not connected');
      }
      if (!deviceInfo.gattServer.connected) {
        console.log('GATT server disconnected, attempting to reconnect...');
        deviceInfo.gattServer = await deviceInfo.device.gatt.connect();
      }
      // For Web Bluetooth, we need to get the specific service we care about
      const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
      const characteristics = await service.getCharacteristics();
      const serviceInfo = {
        uuid: service.uuid,
        characteristics: characteristics.map((char: any) => ({
          uuid: char.uuid,
          properties: char.properties
        }))
      };
      deviceInfo.services = [serviceInfo]; // Store it in a way our UI might expect
      return [serviceInfo];
    } else {
      // Native already provides all services, but we might only care about one
      const allServices = await BleClient.getServices(deviceId);
      // Optionally filter for LED_SERVICE_UUID if needed by UI
      return allServices.filter(s => s.uuid.toLowerCase() === LED_SERVICE_UUID.toLowerCase());
    }
  } catch (error) {
    console.error('Error discovering services:', error);
    throw error;
  }
}

export async function readCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<string> {
  // console.log(`[BLE Read] Attempting to read char: ${characteristicUuid} on service: ${serviceUuid} for device: ${deviceId}`); // Less verbose
  try {
    let valueDataView: DataView;
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      valueDataView = await characteristic.readValue();
    } else {
      valueDataView = await BleClient.read(deviceId, serviceUuid, characteristicUuid);
    }
    
    const decodedString = decodeDataViewAsUtf8(valueDataView);
    // console.log(`[BLE Read - ${characteristicUuid}] Decoded string: "${decodedString}" (length: ${decodedString.length})`); // Less verbose
    return decodedString;

  } catch (error) {
    console.error(`Error reading characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

export async function writeCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string, data: string): Promise<void> {
  try {
    const dataView = textToDataView(data);
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.writeValueWithResponse(dataView);
    } else {
      await BleClient.write(deviceId, serviceUuid, characteristicUuid, dataView);
    }
    console.log(`Successfully wrote to characteristic ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error writing to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

async function writeCharacteristicWithoutResponse(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.writeValueWithoutResponse(dataView);
    } else {
      await BleClient.writeWithoutResponse(deviceId, serviceUuid, characteristicUuid, dataView);
    }
  } catch (error) {
    console.error(`Error writing (NR) to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}


export async function startNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string, callback: (data: string) => void): Promise<void> {
  try {
    const notificationCallback = (value: DataView) => {
        const stringValue = decodeDataViewAsUtf8(value);
        callback(stringValue);
    };

    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        notificationCallback(event.target.value as DataView);
      });
    } else {
      await BleClient.startNotifications(deviceId, serviceUuid, characteristicUuid, notificationCallback);
    }
    console.log(`Started notifications for ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error starting notifications for ${characteristicUuid}:`, error);
    throw error;
  }
}

export async function stopNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.stopNotifications();
      characteristic.removeEventListener('characteristicvaluechanged', () => {}); // Placeholder, actual removal might need specific handler
    } else {
      await BleClient.stopNotifications(deviceId, serviceUuid, characteristicUuid);
    }
    console.log(`Stopped notifications for ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error stopping notifications for ${characteristicUuid}:`, error);
    throw error;
  }
} 

export function getConnectedDevices(): string[] {
  return Array.from(connectedDevices.keys());
}

export function getConnectedDeviceCount(): number {
  return connectedDevices.size;
}

// --- New OTA Functions ---

export async function getDeviceInfo(deviceId: string): Promise<DeviceInfo> {
  console.log(`[OTA] Reading device info from ${deviceId}`);
  try {
    const jsonString = await readCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_DEVICE_INFO);
    try {
      const info = JSON.parse(jsonString) as DeviceInfo;
      console.log('[OTA] Device Info:', info);
      
      // Update device store with the fetched info
      updateDeviceInfo(deviceId, info);
      
      return info;
    } catch (e) {
      console.error('[OTA] Failed to parse device info JSON:', jsonString, e);
      throw new Error('Invalid device info format');
    }
  } catch (error: any) {
    if (error.message.includes('GATT Server is disconnected') || error.message.includes('disconnected')) {
      throw new Error('Device is disconnected. Please reconnect to read device info.');
    }
    throw error;
  }
}

export async function fetchFirmwareRegistry(registryUrl: string = "/firmware/esp32/esp32_firmware_registry.json"): Promise<FirmwareRegistryEntry[]> {
  console.log(`[OTA] Fetching firmware registry from: ${registryUrl}`);
  try {
    // For web, relative path works if served from same origin (gh-pages)
    // For native, ensure this path is accessible or use full URL
    
    // Add cache-busting to ensure we get the latest registry
    const cacheBuster = new Date().getTime();
    const urlWithCacheBuster = `${registryUrl}?t=${cacheBuster}`;
    console.log(`[OTA] Fetching with cache-buster: ${urlWithCacheBuster}`);
    
    const response = await fetch(urlWithCacheBuster, {
      cache: 'no-cache'  // Simple cache-busting without custom headers to avoid CORS preflight
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch registry: ${response.statusText}`);
    }
    const registry = await response.json() as FirmwareRegistryEntry[];
    console.log('[OTA] Firmware registry fetched:', registry);
    return registry;
  } catch (e) {
    console.error('[OTA] Error fetching firmware registry:', e);
    throw e;
  }
}

export function findLatestFirmware(registry: FirmwareRegistryEntry[], currentHwVersion: string): FirmwareRegistryEntry | null {
  const compatibleFirmwares = registry.filter(entry => entry.hardwareVersion === currentHwVersion);
  if (compatibleFirmwares.length === 0) {
    console.log(`[OTA] No compatible firmware found for hardware version: ${currentHwVersion}`);
    return null;
  }
  // Assuming registry is sorted newest first by the GHA
  const latest = compatibleFirmwares[0];
  console.log(`[OTA] Latest compatible firmware found: ${latest.version} for HW ${currentHwVersion}`);
  return latest;
}

export async function sendOTAControlCommand(deviceId: string, command: 'END_OTA' | 'ABORT_OTA'): Promise<void> {
  console.log(`[OTA] Sending control command: ${command} to ${deviceId}`);
  await writeCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_CONTROL, command);
}

export async function sendFirmwareSignature(deviceId: string, signature: ArrayBuffer): Promise<void> {
  console.log(`[OTA] Sending firmware signature (${signature.byteLength} bytes) to ${deviceId}`);
  const dataView = new DataView(signature);

  if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_OTA_SIGNATURE);
      await characteristic.writeValueWithResponse(dataView);
  } else {
      await BleClient.write(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_SIGNATURE, dataView);
  }
}

// Global variable to store the OTA data characteristic for Web Bluetooth
let webOTADataCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;

// Global ACK handler for mobile OTA chunks
let globalMobileAckHandler: ((value: DataView) => void) | null = null;

async function sendFirmwareChunk(deviceId: string, chunk: ArrayBuffer): Promise<void> {
  const dataView = new DataView(chunk);
  
  // OTA_DATA uses WriteWithoutResponse for speed, but ESP32 notifies on same char for ACK
  if (isWeb()) {
    if (!webOTADataCharacteristic) {
      throw new Error('OTA Data characteristic not initialized');
    }
    
    return new Promise(async (resolve, reject) => {
      let listenerAdded = false;
      const timeoutId = setTimeout(() => {
        if (webOTADataCharacteristic && listenerAdded) {
          webOTADataCharacteristic.removeEventListener('characteristicvaluechanged', listener);
        }
        reject(new Error('Timeout waiting for ACK from ESP32'));
      }, 5000); // Increased to 5 second timeout
      
      const listener = (event: any) => {
        clearTimeout(timeoutId);
        if (webOTADataCharacteristic && listenerAdded) {
          webOTADataCharacteristic.removeEventListener('characteristicvaluechanged', listener);
        }
        resolve();
      };
      
      try {
        // Add listener BEFORE writing to avoid race condition
        if (webOTADataCharacteristic) {
          webOTADataCharacteristic.addEventListener('characteristicvaluechanged', listener);
          listenerAdded = true;
        }
        
        if (!webOTADataCharacteristic) {
          throw new Error('OTA Data characteristic is null');
        }
        await webOTADataCharacteristic.writeValueWithoutResponse(dataView);
      } catch (error) {
        clearTimeout(timeoutId);
        if (webOTADataCharacteristic && listenerAdded) {
          webOTADataCharacteristic.removeEventListener('characteristicvaluechanged', listener);
        }
        reject(error);
      }
    });

  } else {
    // Native: Write and wait for ACK notification via global listener
    return new Promise(async (resolve, reject) => {
        let ackReceived = false;
        
        const timeoutId = setTimeout(() => {
            if (!ackReceived) {
                reject(new Error('Timeout waiting for ACK from ESP32 (mobile)'));
            }
        }, 15000); // 5 second timeout
        
        // Set up global ACK handler 
        const originalAckHandler = globalMobileAckHandler;
        globalMobileAckHandler = (value: DataView) => {
            if (!ackReceived) {
                ackReceived = true;
                clearTimeout(timeoutId);
                globalMobileAckHandler = originalAckHandler; // Restore previous handler
                resolve();
            }
        };
        
        try {
            // Write the chunk - ACK will be received via global listener
            await BleClient.writeWithoutResponse(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, dataView);
            
        } catch (err) {
            clearTimeout(timeoutId);
            globalMobileAckHandler = originalAckHandler; // Restore previous handler
            reject(err);
        }
    });
  }
}

export async function startOTAStatusNotifications(deviceId: string, callback: (status: OTAUpdateStatus) => void): Promise<void> {
  console.log(`[OTA] Starting status notifications for ${deviceId}`);
  await startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_STATUS, (stringValue) => {
    callback({ statusMessage: stringValue });
  });
}

export async function stopOTAStatusNotifications(deviceId: string): Promise<void> {
  console.log(`[OTA] Stopping status notifications for ${deviceId}`);
  await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_STATUS);
}

// Main OTA Process Orchestrator
export async function performOTAUpdate(
  deviceId: string,
  firmwareUrl: string,
  signatureUrl: string,
  progressCallback: (status: OTAUpdateStatus) => void
): Promise<void> {
  console.log(`[OTA] Starting OTA update for ${deviceId} from ${firmwareUrl}`);
  progressCallback({ statusMessage: 'Starting OTA...' });

  let otaDataNotificationsStartedForAck = false; 

  try {
    // 1. Fetch firmware and signature
    progressCallback({ statusMessage: 'Downloading firmware...' });
    const firmwareResponse = await fetch(firmwareUrl);
    if (!firmwareResponse.ok) throw new Error(`Failed to download firmware: ${firmwareResponse.statusText}`);
    const firmwareBuffer = await firmwareResponse.arrayBuffer();
    progressCallback({ statusMessage: `Firmware downloaded (${firmwareBuffer.byteLength} bytes).` });

    progressCallback({ statusMessage: 'Downloading signature...' });
    const signatureResponse = await fetch(signatureUrl);
    if (!signatureResponse.ok) throw new Error(`Failed to download signature: ${signatureResponse.statusText}`);
    const signatureBuffer = await signatureResponse.arrayBuffer();
    progressCallback({ statusMessage: `Signature downloaded (${signatureBuffer.byteLength} bytes).` });

    if (signatureBuffer.byteLength !== 64) { // FIRMWARE_SIGNATURE_LENGTH from C++
        throw new Error(`Invalid signature length: ${signatureBuffer.byteLength}. Expected 64.`);
    }

    // 2. (Optional) Send START_OTA or total size via OTA_CONTROL if ESP32 expects it.
    //    Our ESP32 code starts OTA on first data chunk.
    // await sendOTAControlCommand(deviceId, 'START_OTA'); // Or send total size

    // 3. Start listening for ACKs on OTA_DATA characteristic for flow control
    if (isWeb()) {
        // For Web Bluetooth, set up the global characteristic and start notifications
        const deviceInfo = connectedDevices.get(deviceId);
        if (!deviceInfo?.gattServer) throw new Error('Device not connected');
        const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
        webOTADataCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_OTA_DATA);
        if (webOTADataCharacteristic) {
          await webOTADataCharacteristic.startNotifications();
        }
        otaDataNotificationsStartedForAck = true;
    } else { 
        await BleClient.startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, (ackValue) => {
            // Call the global ACK handler if it exists (for chunk-by-chunk flow control)
            if (globalMobileAckHandler) {
                globalMobileAckHandler(ackValue);
            }
        });
        otaDataNotificationsStartedForAck = true;
    }


    // 4. Send firmware in chunks
    let offset = 0;
    const totalSize = firmwareBuffer.byteLength;
    progressCallback({ statusMessage: 'Sending firmware data...', progress: 0 });

    while (offset < totalSize) {
      const chunkEnd = Math.min(offset + MAX_BLE_CHUNK_SIZE, totalSize);
      const chunk = firmwareBuffer.slice(offset, chunkEnd);
      
      await sendFirmwareChunk(deviceId, chunk);
      
      offset = chunkEnd;
      const progress = Math.round((offset / totalSize) * 100);
      progressCallback({ statusMessage: `Sending firmware: ${progress}%`, progress });
    }
    progressCallback({ statusMessage: 'All firmware chunks sent.', progress: 100 });

    // 5. Send signature AFTER firmware data
    progressCallback({ statusMessage: 'Sending signature...' });
    await sendFirmwareSignature(deviceId, signatureBuffer);
    progressCallback({ statusMessage: 'Signature sent.' });

    // 6. Send END_OTA command to trigger signature verification and reboot
    progressCallback({ statusMessage: 'Finalizing update...' });
    try {
      await sendOTAControlCommand(deviceId, 'END_OTA');
      progressCallback({ statusMessage: 'Update finalized. Device should be rebooting...', isComplete: true });
    } catch (error: any) {
      // If END_OTA fails, it's likely because ESP32 rebooted during signature verification
      if (error.message.includes('GATT') || error.message.includes('disconnected') || error.message.includes('timeout')) {
        console.log('[OTA] END_OTA failed due to disconnection/timeout - ESP32 likely rebooted during signature verification');
        progressCallback({ statusMessage: 'Update completed successfully. Device rebooted with new firmware.', isComplete: true });
      } else {
        throw error; // Re-throw if it's a different error
      }
    }

  } catch (error: any) {
    console.error('[OTA] OTA Update Failed:', error);
    progressCallback({ statusMessage: `OTA Failed: ${error.message}`, error: error.message, isError: true, isComplete: true });
    // Optionally send ABORT_OTA if appropriate
    // await sendOTAControlCommand(deviceId, 'ABORT_OTA').catch(e => console.warn("Failed to send ABORT_OTA", e));
    throw error;
  } finally {
    if (otaDataNotificationsStartedForAck) {
        try {
            if (isWeb()) {
                if (webOTADataCharacteristic) {
                    await webOTADataCharacteristic.stopNotifications();
                    webOTADataCharacteristic = null;
                }
            } else {
                await BleClient.stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA);
            }
        } catch (e) {
            // Ignore cleanup errors - device may have already disconnected
            console.warn("[OTA] Failed to stop OTA_DATA ACK notifications (device may have rebooted):", e);
        }
    }
  }
}

// === PATTERN SYNCHRONIZATION ===

/**
 * Sends a messagepack-encoded pattern to all connected devices
 */
export async function syncPatternToAllDevices(): Promise<void> {
  console.log('Syncing current pattern to all connected devices...');
  
  if (connectedDevices.size === 0) {
    console.log('No devices connected, skipping pattern sync');
    return;
  }

  try {
    // Serialize the current pattern
    const serializedPattern = serializeCurrentPattern();
    console.log('Serialized pattern:', serializedPattern);
    
    // Encode as MessagePack
    const msgpackData = msgpackEncode(serializedPattern);
    const dataView = new DataView(msgpackData.buffer, msgpackData.byteOffset, msgpackData.byteLength);
    
    console.log(`Pattern serialized: ${msgpackData.byteLength} bytes`);
    
    // Send to all connected devices
    const syncPromises = Array.from(connectedDevices.keys()).map(async (deviceId) => {
      try {
        console.log(`Sending pattern to device ${deviceId}`);
        await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_PATTERN_SYNC, dataView);
        console.log(`Pattern sent successfully to device ${deviceId}`);
      } catch (error) {
        console.error(`Failed to send pattern to device ${deviceId}:`, error);
      }
    });
    
    // Wait for all devices to complete
    await Promise.allSettled(syncPromises);
    console.log('Pattern sync completed for all devices');
    
  } catch (error) {
    console.error('Error during pattern sync:', error);
    throw error;
  }
}

/**
 * Writes binary data to a BLE characteristic
 */
async function writeCharacteristicBinary(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      await characteristic.writeValueWithResponse(dataView);
    } else {
      await BleClient.write(deviceId, serviceUuid, characteristicUuid, dataView);
    }
    console.log(`Successfully wrote binary data to characteristic ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error writing binary data to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

export interface LedStripConfig {
  chipset: number;
  pin: number;
  numLeds: number;
  colorOrder: number;
  rmtChannel: number;
  width: number;
  height: number;
  orientation: number;
}

export interface LedConfiguration {
  globalBrightness: number;
  strips: LedStripConfig[];
}

// Helper functions for orientation bit manipulation
export function getRotation(orientation: number): number {
  return orientation & 0x03;
}

export function getFlipH(orientation: number): boolean {
  return (orientation & 0x04) !== 0;
}

export function getSerpentine(orientation: number): boolean {
  return (orientation & 0x08) !== 0;
}

export function setRotation(orientation: number, rotation: number): number {
  return (orientation & 0xFC) | (rotation & 0x03);
}

export function setFlipH(orientation: number, flip: boolean): number {
  return flip ? (orientation | 0x04) : (orientation & 0xFB);
}

export function setSerpentine(orientation: number, serpentine: boolean): number {
  return serpentine ? (orientation | 0x08) : (orientation & 0xF7);
}

// LED Chipset enum values (should match ESP32)
export const LedChipsets = {
  NONE: 0,
  WS2812_RGB: 22,
  SK6812_RGBW: 27,
  TM1814_RGBW: 32,
  WS2811_400KHZ: 24,
  TM1829_RGB: 20,
  UCS8903_RGB: 52,
  UCS8904_RGBW: 53,
  APA106_RGB: 47,
  FW1906_RGBCW: 62,
  WS2805_RGBCW: 63,
  TM1914_RGB: 64,
  SM16825_RGBCW: 65
} as const;

// Color Order enum values (should match ESP32)
export const ColorOrders = {
  RGB: 0,
  RBG: 1,
  GRB: 2,
  GBR: 3,
  BRG: 4,
  BGR: 5,
  CO_GRB: 2, // Common alias
} as const;

// LED Configuration Functions

export async function getLedConfiguration(deviceId: string): Promise<LedConfiguration> {
  try {
    console.log(`[LED Config] Getting configuration from ${deviceId}`);
    
    // Read the LED config characteristic (returns binary MessagePack data)
    let rawDataView: DataView;
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_LED_CONFIG_GET);
      rawDataView = await characteristic.readValue();
    } else {
      rawDataView = await BleClient.read(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LED_CONFIG_GET);
    }
    
    // Convert DataView to Uint8Array for MessagePack decoding
    const rawData = new Uint8Array(rawDataView.buffer, rawDataView.byteOffset, rawDataView.byteLength);
    console.log(`[LED Config] Raw MessagePack data: ${rawData.length} bytes`);
    
    // Decode MessagePack data
    const decodedConfig = msgpackDecode(rawData) as any;
    console.log(`[LED Config] Decoded config:`, decodedConfig);
    
    // Convert from ESP32 format to our interface
    const config: LedConfiguration = {
      globalBrightness: decodedConfig.gb || 255,
      strips: (decodedConfig.strips || []).map((strip: any) => ({
        chipset: strip.cs || LedChipsets.WS2812_RGB,
        pin: strip.pin || 13,
        numLeds: strip.num || 100,
        colorOrder: strip.co || ColorOrders.GRB,
        rmtChannel: strip.rmt || 0,
        width: strip.w || 0,
        height: strip.h || 0,
        orientation: strip.ort || 0
      }))
    };
    
    return config;
  } catch (error) {
    console.error('Error getting LED configuration:', error);
    throw error;
  }
}

export async function setLedConfiguration(deviceId: string, config: LedConfiguration): Promise<void> {
  try {
    console.log(`[LED Config] Setting configuration for ${deviceId}:`, config);
    
    // Convert to ESP32 format and encode as MessagePack
    const esp32Config = {
      gb: config.globalBrightness,
      strips: config.strips.map(strip => ({
        cs: strip.chipset,
        pin: strip.pin,
        num: strip.numLeds,
        co: strip.colorOrder,
        rmt: strip.rmtChannel,
        w: strip.width,
        h: strip.height,
        ort: strip.orientation
      }))
    };
    
    // Encode as MessagePack
    const msgpackData = msgpackEncode(esp32Config);
    const dataView = new DataView(msgpackData.buffer, msgpackData.byteOffset, msgpackData.byteLength);
    
    console.log(`[LED Config] Sending MessagePack data: ${msgpackData.byteLength} bytes`);
    
    // Send binary data to characteristic
    await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LED_CONFIG_SET, dataView);
    
    console.log('[LED Config] Configuration sent successfully');
  } catch (error) {
    console.error('Error setting LED configuration:', error);
    throw error;
  }
}

// Timestamp Sync Functions

/**
 * Sends current system timestamp to ESP32 for synchronization
 */
export async function sendTimestampSync(deviceId: string): Promise<void> {
  try {
    // Get current system time in milliseconds
    const currentTimestamp = Date.now();
    
    // Convert to 64-bit little-endian binary format
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    
    // Write timestamp as 64-bit little-endian unsigned integer
    // JavaScript numbers are 64-bit floats, but we need to split into two 32-bit parts
    const timestampLow = currentTimestamp & 0xFFFFFFFF;
    const timestampHigh = Math.floor(currentTimestamp / 0x100000000);
    
    view.setUint32(0, timestampLow, true);  // little-endian
    view.setUint32(4, timestampHigh, true); // little-endian
    
    const dataView = new DataView(buffer);
    
    // Send binary data to timestamp sync characteristic
    await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_TIMESTAMP_SYNC, dataView);
    
    console.log(`[Timestamp Sync] Sent timestamp ${currentTimestamp} to device ${deviceId}`);
  } catch (error) {
    console.error('Error sending timestamp sync:', error);
    throw error;
  }
}

// Timestamp sync interval management
const timestampSyncIntervals = new Map<string, number>();

/**
 * Starts periodic timestamp synchronization for a device (every 10 seconds)
 */
function startTimestampSync(deviceId: string): void {
  // Clear any existing interval
  stopTimestampSync(deviceId);
  
  // Send initial sync
  sendTimestampSync(deviceId).catch(err => {
    console.error(`Failed to send initial timestamp sync to ${deviceId}:`, err);
  });
  
  // Set up periodic sync every 10 seconds
  const intervalId = window.setInterval(() => {
    sendTimestampSync(deviceId).catch(err => {
      console.error(`Failed to send periodic timestamp sync to ${deviceId}:`, err);
      // Don't stop the interval on error - keep trying
    });
  }, 10000);
  
  timestampSyncIntervals.set(deviceId, intervalId);
  console.log(`[Timestamp Sync] Started periodic sync for device ${deviceId}`);
}

/**
 * Stops periodic timestamp synchronization for a device
 */
function stopTimestampSync(deviceId: string): void {
  const intervalId = timestampSyncIntervals.get(deviceId);
  if (intervalId !== undefined) {
    window.clearInterval(intervalId);
    timestampSyncIntervals.delete(deviceId);
    console.log(`[Timestamp Sync] Stopped periodic sync for device ${deviceId}`);
  }
}
