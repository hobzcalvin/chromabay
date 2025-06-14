import { BleClient, numbersToDataView, dataViewToNumbers, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';

/**
 * Check if we're running in a web browser
 */
function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

// Store connected devices and their GATT servers
const connectedDevices = new Map<string, any>();

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

const MAX_BLE_CHUNK_SIZE = 500; // Should match ESP32's definition

// --- OTA Interfaces ---
export interface DeviceInfo {
  fw_ver: string;
  hw_ver: string;
  heap?: number;
  // mac?: string; // Optional
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
        services: [LED_SERVICE_UUID] // Scan for the main service
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
      optionalServices: [LED_SERVICE_UUID] // Ensure all characteristics under this service are accessible
    }).then(device => {
      callback({
        device: {
          deviceId: device.id,
          name: device.name || 'Unknown Device',
          webDevice: device // Store the Web Bluetooth device object
        }
      });
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
      connectedDevices.set(device.deviceId, {
        device: device.webDevice,
        gattServer: gattServer,
        services: null
      });
      console.log('Connected to device via Web Bluetooth');
    } else {
      await BleClient.connect(device.deviceId);
      connectedDevices.set(device.deviceId, { device: device }); // Store native device info
      console.log('Connected to device via Capacitor');
    }
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
  try {
    if (isWeb()) {
      const deviceInfo = connectedDevices.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      const value = await characteristic.readValue();
      return dataViewToText(value);
    } else {
      const result = await BleClient.read(deviceId, serviceUuid, characteristicUuid);
      return dataViewToText(result);
    }
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
        const stringValue = dataViewToText(value);
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
  const jsonString = await readCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_DEVICE_INFO);
  try {
    const info = JSON.parse(jsonString) as DeviceInfo;
    console.log('[OTA] Device Info:', info);
    return info;
  } catch (e) {
    console.error('[OTA] Failed to parse device info JSON:', jsonString, e);
    throw new Error('Invalid device info format');
  }
}

export async function fetchFirmwareRegistry(registryUrl: string = "/firmware/esp32/esp32_firmware_registry.json"): Promise<FirmwareRegistryEntry[]> {
  console.log(`[OTA] Fetching firmware registry from: ${registryUrl}`);
  try {
    // For web, relative path works if served from same origin (gh-pages)
    // For native, ensure this path is accessible or use full URL
    const response = await fetch(registryUrl);
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
  // Use writeCharacteristic for acknowledged write, as signature is critical
  await writeCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_SIGNATURE, dataViewToText(dataView)); // Assuming text for simplicity, adjust if binary
  // Or if ESP32 expects raw bytes:
  // await BleClient.write(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_SIGNATURE, dataView); // for native
  // For web, if characteristic supports writeValueWithResponse:
  // const deviceInfo = connectedDevices.get(deviceId);
  // const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
  // const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_OTA_SIGNATURE);
  // await characteristic.writeValueWithResponse(dataView);
  console.log('[OTA] Firmware signature sent.');
}

async function sendFirmwareChunk(deviceId: string, chunk: ArrayBuffer): Promise<void> {
  const dataView = new DataView(chunk);
  // OTA_DATA uses WriteWithoutResponse for speed, but ESP32 notifies on same char for ACK
  if (isWeb()) {
    const deviceInfo = connectedDevices.get(deviceId);
    if (!deviceInfo?.gattServer) throw new Error('Device not connected');
    const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_OTA_DATA);
    
    return new Promise(async (resolve, reject) => {
      const listener = (event: any) => {
        characteristic.removeEventListener('characteristicvaluechanged', listener);
        // console.log('[OTA] Web ACK received for chunk');
        resolve();
      };
      characteristic.addEventListener('characteristicvaluechanged', listener);
      // Ensure notifications are started for this characteristic on web if not already
      // This might need to be done once before starting the chunk sending loop.
      // For simplicity, assuming notifications are active or start them here if needed.
      // await characteristic.startNotifications(); // Potentially needed
      await characteristic.writeValueWithoutResponse(dataView).catch(reject);
    });

  } else {
    // Native: Write and rely on a separate notification subscription for ACKs
    return new Promise(async (resolve, reject) => {
        // The ACK will come via the global OTA_DATA notification listener
        // We need a way to correlate this specific write to its ACK.
        // For simplicity here, we'll assume the next notification IS the ACK.
        // A more robust system would use a transaction ID or sequence number.
        const tempListener = (ackValue: DataView) => {
            // console.log('[OTA] Native ACK received:', dataViewToText(ackValue));
            BleClient.removeListener('notification|' + deviceId + '|' + LED_SERVICE_UUID + '|' + CHARACTERISTIC_UUID_OTA_DATA, tempListener);
            resolve();
        };
        BleClient.addListener('notification|' + deviceId + '|' + LED_SERVICE_UUID + '|' + CHARACTERISTIC_UUID_OTA_DATA, tempListener);
        await BleClient.writeWithoutResponse(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, dataView).catch(reject);
    });
  }
}

export async function startOTAStatusNotifications(deviceId: string, callback: (status: OTAUpdateStatus) => void): Promise<void> {
  console.log(`[OTA] Starting status notifications for ${deviceId}`);
  await startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_STATUS, (jsonString) => {
    try {
      // Attempt to parse as JSON object first
      const statusObj = JSON.parse(jsonString) as OTAUpdateStatus;
      callback(statusObj);
    } catch (e) {
      // If not JSON, treat as simple status message string
      callback({ statusMessage: jsonString });
    }
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

  let otaDataNotificationsStarted = false;

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

    // 3. Start listening for ACKs on OTA_DATA characteristic (if not already globally handled)
    //    For native, this is tricky as BleClient.startNotifications is global per characteristic.
    //    We'll set up a temporary listener within sendFirmwareChunk for native for now.
    //    For web, the listener is per-characteristic object.
    if (!isWeb()) { // For native, ensure notifications are globally started for OTA_DATA for ACKs
        await BleClient.startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, (ackValue) => {
            // This global listener will capture ACKs. sendFirmwareChunk will handle its own promise resolution.
            // console.log('[OTA] Global ACK Listener (Native):', dataViewToText(ackValue));
        });
        otaDataNotificationsStarted = true;
    }


    // 4. Send signature
    progressCallback({ statusMessage: 'Sending signature...' });
    await sendFirmwareSignature(deviceId, signatureBuffer);
    progressCallback({ statusMessage: 'Signature sent.' });

    // 5. Send firmware in chunks
    let offset = 0;
    const totalSize = firmwareBuffer.byteLength;
    progressCallback({ statusMessage: 'Sending firmware data...', progress: 0 });

    while (offset < totalSize) {
      const chunkEnd = Math.min(offset + MAX_BLE_CHUNK_SIZE, totalSize);
      const chunk = firmwareBuffer.slice(offset, chunkEnd);
      
      // console.log(`[OTA] Sending chunk: offset ${offset}, size ${chunk.byteLength}`);
      await sendFirmwareChunk(deviceId, chunk);
      // console.log(`[OTA] Chunk sent, ACK received for offset ${offset}`);
      
      offset = chunkEnd;
      const progress = Math.round((offset / totalSize) * 100);
      progressCallback({ statusMessage: `Sending firmware: ${progress}%`, progress });
    }
    progressCallback({ statusMessage: 'All firmware chunks sent.', progress: 100 });

    // 6. Send END_OTA command
    progressCallback({ statusMessage: 'Finalizing update...' });
    await sendOTAControlCommand(deviceId, 'END_OTA');
    progressCallback({ statusMessage: 'Update finalized. Waiting for device to reboot with new firmware.', isComplete: true });

  } catch (error: any) {
    console.error('[OTA] OTA Update Failed:', error);
    progressCallback({ statusMessage: `OTA Failed: ${error.message}`, error: error.message, isError: true, isComplete: true });
    // Optionally send ABORT_OTA if appropriate
    // await sendOTAControlCommand(deviceId, 'ABORT_OTA').catch(e => console.warn("Failed to send ABORT_OTA", e));
    throw error;
  } finally {
    // Clean up: Stop listening for ACKs on OTA_DATA if started for native
    if (otaDataNotificationsStarted && !isWeb()) {
        try {
            await BleClient.stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA);
        } catch (e) {
            console.warn("[OTA] Failed to stop OTA_DATA notifications (native):", e);
        }
    }
  }
}
