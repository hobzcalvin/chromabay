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

// Serialize discrete BLE request/response operations across ALL devices. iOS
// CoreBluetooth (via the Capacitor plugin) drops or mis-routes operations that
// overlap — which is what made a 2nd device's LED-config read fail (no brightness
// slider) and pattern writes miss a device. Funneling reads/writes/connects through
// this single chain makes them run strictly one at a time. (OTA's tight write loop
// deliberately does NOT go through here.)
let bleOpChain: Promise<unknown> = Promise.resolve();
const BLE_OP_TIMEOUT_MS = 15000;
function bleSerial<T>(op: () => Promise<T>): Promise<T> {
  // Wrap with a timeout so a single hung BLE op (e.g. a peripheral that vanished
  // mid-operation) can't wedge the whole queue and silently block every later op.
  const guarded = () => Promise.race<T>([
    op(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('BLE op timed out')), BLE_OP_TIMEOUT_MS)
    )
  ]);
  const run = bleOpChain.then(guarded, guarded); // run after the previous op regardless of its outcome
  bleOpChain = run.then(() => {}, () => {}); // never let one failure break the chain
  return run;
}

// Import device store for UI state management
import { removeConnectedDevice, addConnectedDevice, updateDeviceInfo } from './stores/deviceStore';

// ChromaBay LED Service UUID - the only service we care about for general commands
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
const CHARACTERISTIC_UUID_PLAYLIST_SYNC = "a0be83f0-8dc9-47f0-ab40-b19721d20ed1"; // pattern cycling

// LED Configuration Characteristics - for getting/setting strip configuration
const CHARACTERISTIC_UUID_LED_CONFIG_GET = "a0be83ed-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_LED_CONFIG_SET = "a0be83ee-8dc9-47f0-ab40-b19721d20ed1";

// Timestamp Sync Characteristic - for synchronizing time across devices
const CHARACTERISTIC_UUID_TIMESTAMP_SYNC = "a0be83ef-8dc9-47f0-ab40-b19721d20ed1";

// Brightness Characteristic - live global brightness (single byte, applied immediately)
const CHARACTERISTIC_UUID_BRIGHTNESS = "a0be83f1-8dc9-47f0-ab40-b19721d20ed1";

// Device Name Characteristic - read/write the user-facing BLE device name
const CHARACTERISTIC_UUID_DEVICE_NAME = "a0be83f2-8dc9-47f0-ab40-b19721d20ed1";

// Button Pin Characteristic - read/write the control-button GPIO (decimal string; -1 = none)
const CHARACTERISTIC_UUID_BUTTON_PIN = "a0be83f3-8dc9-47f0-ab40-b19721d20ed1";

// Button Event Characteristic - NOTIFY a button gesture the app must act on (e.g. "next")
const CHARACTERISTIC_UUID_BUTTON_EVENT = "a0be83f4-8dc9-47f0-ab40-b19721d20ed1";

const MAX_BLE_CHUNK_SIZE = 500; // Should match ESP32's definition

// --- OTA Interfaces ---
export interface DeviceInfo {
  fw_ver: string;
  hw_ver: string;
  name?: string;
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

let unloadHandlerRegistered = false;

export async function initBle(): Promise<void> {
  try {
    await BleClient.initialize();
    console.log('BLE Client initialized successfully');

    // On web, a full page reload (e.g. Vite's WASM auto-reload) tears the page down
    // WITHOUT closing GATT connections, and Chrome's Web Bluetooth stack then wedges
    // until you restart Chrome. Cleanly disconnect every device on unload so the
    // adapter is released. (Native never reloads, so this is web-only.)
    if (isWeb() && !unloadHandlerRegistered && typeof window !== 'undefined') {
      unloadHandlerRegistered = true;
      window.addEventListener('pagehide', () => {
        for (const info of connectedDevices.values()) {
          try { info?.gattServer?.disconnect?.(); } catch { /* already gone */ }
        }
      });
    }
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

/**
 * React to the system Bluetooth adapter being toggled on/off (native only).
 * Web Bluetooth has no adapter-state event, so this is a no-op there.
 */
export async function startBleStateNotifications(cb: (enabled: boolean) => void): Promise<void> {
  if (isWeb()) return;
  try {
    await BleClient.startEnabledNotifications(cb);
  } catch (error) {
    console.error('Failed to start BLE state notifications:', error);
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
      // Match by service OR by name prefix. The firmware doesn't always advertise the
      // 128-bit service UUID in a way Web Bluetooth's service filter catches (iOS finds
      // it via native scan, but Chrome's chooser came up empty), so a "ChromaBay" name
      // filter ensures our devices are discoverable. optionalServices still grants
      // access to the LED service after connecting.
      filters: [
        { services: [LED_SERVICE_UUID] },
        { namePrefix: 'ChromaBay' }
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

// Shared cleanup for any disconnect path: the native onDisconnect callback, the
// web `gattserverdisconnected` event, or an explicit disconnectFromDevice().
// Idempotent — safe to call more than once for the same device.
function handleDeviceDisconnected(deviceId: string): void {
  console.log(`Device ${deviceId} disconnected — cleaning up`);
  const info = connectedDevices.get(deviceId);
  // Remove the web disconnect listener so it doesn't accumulate across reconnects
  // (the underlying BluetoothDevice object persists).
  if (info?.device && info.onDisconnect && typeof info.device.removeEventListener === 'function') {
    info.device.removeEventListener('gattserverdisconnected', info.onDisconnect);
  }
  connectedDevices.delete(deviceId);
  removeConnectedDevice(deviceId);
  // Critical: stop the timestamp-sync interval, otherwise it keeps writing to a
  // dead handle every 10s (e.g. after an ESP32 OTA reboot).
  stopTimestampSync(deviceId);
}

export async function connectToDevice(device: any): Promise<void> {
  try {
    if (isWeb()) {
      const gattServer = await bleSerial(() => device.webDevice.gatt.connect());

      // Replace any stale listener from a previous connect before adding a new
      // one, and keep a reference so it can be removed on disconnect.
      const prev = connectedDevices.get(device.deviceId);
      if (prev?.onDisconnect) {
        device.webDevice.removeEventListener('gattserverdisconnected', prev.onDisconnect);
      }
      const onDisconnect = () => handleDeviceDisconnected(device.deviceId);
      device.webDevice.addEventListener('gattserverdisconnected', onDisconnect);

      connectedDevices.set(device.deviceId, {
        device: device.webDevice,
        gattServer: gattServer,
        services: null,
        onDisconnect
      });
      console.log('Connected to device via Web Bluetooth');

      // Start timestamp synchronization for this device
      startTimestampSync(device.deviceId);
    } else {
      // Pass an onDisconnect callback so native disconnects (out of range, OTA
      // reboot, power loss) are detected and cleaned up — previously they were
      // never noticed, leaving stale "connected" devices and a leaked sync timer.
      await bleSerial(() => BleClient.connect(device.deviceId, (disconnectedId: string) => {
        handleDeviceDisconnected(disconnectedId);
      }));
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
    
    // Sync current pattern to newly connected device
    console.log('Syncing current pattern to newly connected device...');
    try {
      await syncPatternToAllDevices();
      console.log('Initial pattern sync completed');
    } catch (error) {
      console.error('Failed to sync initial pattern to device:', error);
      // Don't throw here - connection was successful, pattern sync can be retried
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
  } catch (error) {
    // A failing transport disconnect almost always means the device is already
    // gone (stale handle, peer dropped, or — in dev — the injected TEST device
    // that was never a real BLE connection). The user asked to disconnect, so
    // treat this as already-disconnected and fall through to cleanup rather than
    // surfacing a "Failed to disconnect" error and leaving a phantom in the list.
    console.warn('Transport disconnect failed; treating as already disconnected:', error);
  }
  // Centralized cleanup (also runs from the disconnect event/callback; idempotent)
  // — always run it so the device is removed from the UI regardless of the above.
  handleDeviceDisconnected(deviceId);
  console.log('Disconnected from device');
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
  return bleSerial(async () => {
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
      return decodeDataViewAsUtf8(valueDataView);
    } catch (error) {
      console.error(`Error reading characteristic ${characteristicUuid}:`, error);
      throw error;
    }
  });
}

export async function writeCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string, data: string): Promise<void> {
  return bleSerial(async () => {
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
    } catch (error) {
      console.error(`Error writing to characteristic ${characteristicUuid}:`, error);
      throw error;
    }
  });
}

async function writeCharacteristicWithoutResponse(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  return bleSerial(async () => {
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
  });
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

export function findLatestFirmware(registry: FirmwareRegistryEntry[], currentHwVersion?: string): FirmwareRegistryEntry | null {
  if (registry.length === 0) {
    console.log('[OTA] Firmware registry is empty');
    return null;
  }
  // Newest entry by build date (don't rely on registry ordering).
  const byDateDesc = [...registry].sort((a, b) => b.date.localeCompare(a.date));
  // Prefer firmware matching the device's hardware version, but never let a
  // hardware mismatch hide an available update — fall back to newest overall.
  // (All targets are generic ESP32s, so this is belt-and-suspenders.)
  const compatible = currentHwVersion
    ? byDateDesc.filter(e => e.hardwareVersion === currentHwVersion)
    : [];
  const latest = compatible[0] ?? byDateDesc[0];
  if (currentHwVersion && compatible.length === 0) {
    console.log(`[OTA] No firmware tagged for HW ${currentHwVersion}; falling back to newest overall: ${latest.version} (${latest.date})`);
  } else {
    console.log(`[OTA] Latest firmware: ${latest.version} (${latest.date})`);
  }
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

// Write one firmware chunk WITHOUT waiting for its ACK. Flow control is handled by the
// caller's sliding window (see performOTAUpdate), which keeps a bounded number of
// chunks in flight using the per-chunk ACK notifications the ESP32 already sends. This
// is what makes the fast path backwards-compatible: the firmware is unchanged and still
// ACKs every chunk; we just stop idling for a full round-trip between each one.
async function writeChunkNoWait(deviceId: string, chunk: ArrayBuffer): Promise<void> {
  const dataView = new DataView(chunk);
  if (isWeb()) {
    if (!webOTADataCharacteristic) throw new Error('OTA Data characteristic not initialized');
    await webOTADataCharacteristic.writeValueWithoutResponse(dataView);
  } else {
    await BleClient.writeWithoutResponse(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, dataView);
  }
}

// Number of chunks kept in flight before waiting for ACKs. Conservative so we don't
// overrun the controller's write-without-response buffer (which would drop chunks — a
// failed, not bricked, update thanks to signature verification + rollback).
const OTA_WINDOW = 8;

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
  // Declared at function scope so the finally block can detach it. Assigned in step 3.
  let onAck: () => void = () => {};

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

    // 3. Listen for the ESP32's per-chunk ACK notifications on OTA_DATA. A single
    //    persistent handler counts ACKs for the whole transfer; the windowed sender
    //    below uses that count for flow control.
    let ackedChunks = 0;
    let ackWaiter: (() => void) | null = null;
    onAck = () => {
      ackedChunks++;
      if (ackWaiter) { const w = ackWaiter; ackWaiter = null; w(); }
    };
    // Resolves on the next ACK, or rejects after a timeout (a stalled transfer).
    const waitForAck = (timeoutMs: number) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { ackWaiter = null; reject(new Error('Timeout waiting for OTA ACK')); }, timeoutMs);
      ackWaiter = () => { clearTimeout(t); resolve(); };
    });

    if (isWeb()) {
        const deviceInfo = connectedDevices.get(deviceId);
        if (!deviceInfo?.gattServer) throw new Error('Device not connected');
        const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
        webOTADataCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_OTA_DATA);
        if (webOTADataCharacteristic) {
          await webOTADataCharacteristic.startNotifications();
          webOTADataCharacteristic.addEventListener('characteristicvaluechanged', onAck);
        }
        otaDataNotificationsStartedForAck = true;
    } else {
        globalMobileAckHandler = () => onAck();
        await BleClient.startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, () => {
            if (globalMobileAckHandler) globalMobileAckHandler(new DataView(new ArrayBuffer(0)));
        });
        otaDataNotificationsStartedForAck = true;
    }

    // 4. Send firmware as a sliding window: keep up to OTA_WINDOW chunks in flight,
    //    sending the next as each ACK arrives. ~OTA_WINDOW× fewer round-trips than
    //    stop-and-wait, while the ACK-driven window prevents overrunning the device.
    let offset = 0;
    let sentChunks = 0;
    const totalSize = firmwareBuffer.byteLength;
    const totalChunks = Math.ceil(totalSize / MAX_BLE_CHUNK_SIZE);
    progressCallback({ statusMessage: 'Sending firmware data...', progress: 0 });

    while (offset < totalSize) {
      // Wait until the window has room (bounded chunks awaiting ACK).
      while (sentChunks - ackedChunks >= OTA_WINDOW) {
        await waitForAck(15000);
      }
      const chunkEnd = Math.min(offset + MAX_BLE_CHUNK_SIZE, totalSize);
      await writeChunkNoWait(deviceId, firmwareBuffer.slice(offset, chunkEnd));
      offset = chunkEnd;
      sentChunks++;
      const progress = Math.round((offset / totalSize) * 100);
      progressCallback({ statusMessage: `Sending firmware: ${progress}%`, progress });
    }

    // Drain remaining ACKs so we know the device wrote everything. If a tail ACK
    // notification is lost the wait times out — we proceed anyway, since signature
    // verification on END_OTA is the real integrity gate (a true drop fails safely).
    while (ackedChunks < totalChunks) {
      try { await waitForAck(15000); } catch { break; }
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
                    try { webOTADataCharacteristic.removeEventListener('characteristicvaluechanged', onAck); } catch {}
                    await webOTADataCharacteristic.stopNotifications();
                    webOTADataCharacteristic = null;
                }
            } else {
                globalMobileAckHandler = null;
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
 * Turn auto-cycling on/off for ONE device. The device steps through its OWN stored
 * pattern library (sorted by name) on its SYNCHRONIZED clock, so connected devices
 * with the same patterns switch together. Cycling is independent of the stored set —
 * toggling it off just stops advancing. Payload (matches firmware
 * CycleControlCallbacks): [u32 intervalMs][u8 enabled], little-endian.
 */
export async function setCycleOnDevice(deviceId: string, enabled: boolean, intervalSeconds: number): Promise<void> {
  const intervalMs = Math.max(1, Math.round(intervalSeconds * 1000));
  const out = new Uint8Array(5);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, intervalMs, true);
  dv.setUint8(4, enabled ? 1 : 0);
  console.log(`[Cycle] ${enabled ? 'ON' : 'OFF'} @ ${intervalMs}ms -> ${deviceId}`);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_PLAYLIST_SYNC, dv);
}

/**
 * Push a single named pattern to ONE device. The device upserts it into its library
 * by name (meta.name) and shows it. ("Here's your pattern now.")
 */
export async function sendSinglePatternToDevice(deviceId: string, pattern: any): Promise<void> {
  const msgpackData = msgpackEncode(pattern) as Uint8Array;
  const dataView = new DataView(msgpackData.buffer, msgpackData.byteOffset, msgpackData.byteLength);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_PATTERN_SYNC, dataView);
}

/**
 * Set the live global brightness on ONE device. Writes a single byte (0-255) to the
 * dedicated brightness characteristic — the firmware applies it immediately (no strip
 * reallocation) and persists it after the slider settles. Safe to call rapidly while
 * dragging a slider; uses write-without-response so it never blocks the UI.
 */
export async function sendBrightnessToDevice(deviceId: string, brightness: number): Promise<void> {
  const clamped = Math.max(0, Math.min(255, Math.round(brightness)));
  const dataView = new DataView(new Uint8Array([clamped]).buffer);
  return bleSerial(async () => {
    try {
      if (isWeb()) {
        const deviceInfo = connectedDevices.get(deviceId);
        if (!deviceInfo?.gattServer) throw new Error('Device not connected');
        const service = await deviceInfo.gattServer.getPrimaryService(LED_SERVICE_UUID);
        const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_BRIGHTNESS);
        await characteristic.writeValueWithoutResponse(dataView);
      } else {
        await BleClient.writeWithoutResponse(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BRIGHTNESS, dataView);
      }
    } catch (error) {
      console.error(`Error sending brightness to ${deviceId}:`, error);
      throw error;
    }
  });
}

/**
 * Rename a device. Writes the new name to the device-name characteristic; the firmware
 * persists it, updates the GAP + advertised name, and reflects it in device info.
 */
export async function setDeviceName(deviceId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 31) {
    throw new Error('Device name must be 1–31 characters');
  }
  await writeCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_DEVICE_NAME, trimmed);
}

/** Read the device's control-button GPIO. Returns null if no button is configured. */
export async function getButtonPin(deviceId: string): Promise<number | null> {
  const s = await readCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BUTTON_PIN);
  const p = parseInt(s, 10);
  return (isNaN(p) || p < 0) ? null : p;
}

/** Set the control-button GPIO (null/none disables the button). */
export async function setButtonPin(deviceId: string, pin: number | null): Promise<void> {
  const v = (pin == null || pin < 0) ? '-1' : String(pin);
  await writeCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BUTTON_PIN, v);
}

/**
 * Subscribe to button gesture events from a device (e.g. "next" = next pattern). The
 * device can't switch patterns on its own — the app owns the library — so it notifies
 * and the app acts + farms the result out to all devices.
 */
export async function startButtonEventNotifications(deviceId: string, callback: (event: string) => void): Promise<void> {
  await startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BUTTON_EVENT, (value) => {
    const ev = (value || '').trim();
    if (ev) callback(ev);
  });
}

/**
 * Writes binary data to a BLE characteristic
 */
async function writeCharacteristicBinary(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  return bleSerial(async () => {
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
    } catch (error) {
      console.error(`Error writing binary data to characteristic ${characteristicUuid}:`, error);
      throw error;
    }
  });
}

export interface LedStripConfig {
  chipset: number;
  pin: number;
  // numLeds/width/height are null while a new strip is being entered (blank fields);
  // they're filled/derived before saving. Loaded-from-device configs always have numbers.
  numLeds: number | null;
  colorOrder: number;
  rmtChannel: number;
  width: number | null;
  height: number | null;
  orientation: number;
  gamma?: number; // per-strip gamma correction (1.0 = none; ~2.5 default)
  whitePoint?: string; // per-strip white-balance hex '#rrggbb' (the color shown for "white"; '#ffffff' = neutral)
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
  // Logged OUTSIDE the queue so you can see the request was made even if the queue
  // is backed up behind a slow/hung op.
  console.log(`[LED Config] ⏳ queued read for ${deviceId}`);
  return bleSerial(async () => {
   try {
    console.log(`[LED Config] Reading config from ${deviceId}…`);

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

    // Decode MessagePack data
    const decodedConfig = msgpackDecode(rawData) as any;
    const stripCount = Array.isArray(decodedConfig?.strips) ? decodedConfig.strips.length : 0;
    console.log(
      `[LED Config] ✅ ${deviceId}: ${rawData.length} bytes, brightness=${decodedConfig?.gb}, strips=${stripCount}`,
      decodedConfig
    );

    // Convert from ESP32 format to our interface.
    // Use ?? (nullish) not || here: several of these fields have a legitimate
    // value of 0 that || would wrongly replace with the default — e.g. brightness
    // 0 (off) -> 255, colorOrder RGB (0) -> GRB, chipset NONE (0), GPIO pin 0.
    // The set path writes raw values, so || made get/set asymmetric/lossy.
    const config: LedConfiguration = {
      globalBrightness: decodedConfig.gb ?? 255,
      strips: (decodedConfig.strips || []).map((strip: any) => {
        const numLeds = strip.num ?? 100;
        let width = strip.w ?? 0;
        let height = strip.h ?? 0;
        // Migrate old "linear" configs (0x0) to the always-matrix model as a single
        // row, so the UI never shows a meaningless 0.
        if (!(width >= 1) || !(height >= 1)) {
          width = numLeds;
          height = 1;
        }
        return {
          chipset: strip.cs ?? LedChipsets.WS2812_RGB,
          pin: strip.pin ?? 13,
          numLeds,
          colorOrder: strip.co ?? ColorOrders.GRB,
          rmtChannel: strip.rmt ?? 0,
          width,
          height,
          orientation: strip.ort ?? 0,
          // Firmware stores gamma*100 as an int; default 1.0 (off) if absent.
          gamma: (strip.gm ?? 100) / 100,
          // White point packed as 0xRRGGBB; default 0xFFFFFF (neutral) if absent.
          whitePoint: '#' + ((strip.wp ?? 0xffffff) & 0xffffff).toString(16).padStart(6, '0')
        };
      })
    };
    
    return config;
   } catch (error) {
    console.error(`[LED Config] ❌ ${deviceId}: read/decode failed:`, error);
    throw error;
   }
  });
}

export async function setLedConfiguration(deviceId: string, config: LedConfiguration): Promise<void> {
  try {
    console.log(`[LED Config] Setting configuration for ${deviceId}:`, config);
    
    // Convert to ESP32 format and encode as MessagePack. The firmware expects integers
    // for num/w/h; callers normalize blanks before saving, but coerce defensively so a
    // stray null can never serialize to nil and break the firmware decode.
    const esp32Config = {
      gb: config.globalBrightness,
      strips: config.strips.map(strip => ({
        cs: strip.chipset,
        pin: strip.pin,
        num: strip.numLeds ?? 0,
        co: strip.colorOrder,
        rmt: strip.rmtChannel,
        w: strip.width ?? 0,
        h: strip.height ?? 0,
        ort: strip.orientation,
        gm: Math.round((strip.gamma ?? 1.0) * 100),
        wp: strip.whitePoint ? (parseInt(strip.whitePoint.slice(1), 16) & 0xffffff) : 0xffffff
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
    // Canonical clock = integer ms since page load (performance.now), the SAME
    // clock the browser preview feeds its operators (see flowStore). Devices sync
    // to THIS so preview and hardware render the same frame. Monotonic (no NTP
    // jumps); resets on page reload, which the next periodic sync corrects.
    const currentTimestamp = Math.floor(performance.now());

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
// Consecutive periodic-sync failures per device. The sync write doubles as a liveness
// heartbeat: iOS frequently fails to deliver a disconnect callback for silent drops
// (out of range, device reboot, power loss), leaving a "zombie" connection that the UI
// still shows as live. After this many failures in a row we treat the device as gone.
const syncFailureCounts = new Map<string, number>();
const SYNC_FAILURE_LIMIT = 2;

/**
 * Starts periodic timestamp synchronization for a device (every 10 seconds)
 */
function startTimestampSync(deviceId: string): void {
  // Clear any existing interval
  stopTimestampSync(deviceId);
  syncFailureCounts.set(deviceId, 0);

  // Send initial sync
  sendTimestampSync(deviceId).catch(err => {
    console.error(`Failed to send initial timestamp sync to ${deviceId}:`, err);
  });

  // Set up periodic sync every 10 seconds
  const intervalId = window.setInterval(() => {
    sendTimestampSync(deviceId)
      .then(() => {
        syncFailureCounts.set(deviceId, 0); // healthy — reset the failure streak
      })
      .catch(err => {
        const fails = (syncFailureCounts.get(deviceId) ?? 0) + 1;
        syncFailureCounts.set(deviceId, fails);
        console.error(`Failed to send periodic timestamp sync to ${deviceId} (failure ${fails}/${SYNC_FAILURE_LIMIT}):`, err);
        // This heartbeat is also our liveness check. If the device is still in our
        // connected set but won't accept writes for several rounds, it has silently
        // dropped (iOS often never fires the disconnect callback). Run the normal
        // disconnect cleanup so the UI leaves its stale "connected" state instead of
        // sitting in a zombie connection until the user manually reconnects.
        if (fails >= SYNC_FAILURE_LIMIT && connectedDevices.has(deviceId)) {
          console.warn(`Device ${deviceId} unresponsive after ${fails} syncs — treating as disconnected`);
          handleDeviceDisconnected(deviceId);
        }
      });
  }, 10000);

  timestampSyncIntervals.set(deviceId, intervalId);
  console.log(`[Timestamp Sync] Started periodic sync for device ${deviceId}`);
}

/**
 * Stops periodic timestamp synchronization for a device
 */
function stopTimestampSync(deviceId: string): void {
  syncFailureCounts.delete(deviceId);
  const intervalId = timestampSyncIntervals.get(deviceId);
  if (intervalId !== undefined) {
    window.clearInterval(intervalId);
    timestampSyncIntervals.delete(deviceId);
    console.log(`[Timestamp Sync] Stopped periodic sync for device ${deviceId}`);
  }
}
