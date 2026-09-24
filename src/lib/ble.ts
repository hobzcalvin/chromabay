import { BleClient, numbersToDataView, dataViewToNumbers, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
// @ts-ignore - MessagePack types issue
import * as msgpack from '@msgpack/msgpack';
import { get } from 'svelte/store';
const msgpackEncode = msgpack.encode;
const msgpackDecode = msgpack.decode;
import { serializeCurrentPattern } from './flowStore';
import { getFirmware, putFirmware } from './firmwareCache';
import {
  getTransport, setBleTransportFactory, unregisterTransport, isWifiId, hostFromWifiId,
  type Transport,
} from './transport';

/**
 * Check if we're running in a web browser
 */
function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

// BLE-only GATT state. This is deliberately NOT the app's connected-device list: Wi-Fi
// devices have no GATT server, but are still ordinary connected devices at the protocol layer.
const bleConnections = new Map<string, any>();

// Serialize discrete BLE request/response operations across ALL devices. iOS
// CoreBluetooth (via the Capacitor plugin) drops or mis-routes operations that
// overlap — which is what made a 2nd device's LED-config read fail (no brightness
// slider) and pattern writes miss a device. Funneling reads/writes/connects through
// this single chain makes them run strictly one at a time. (OTA's tight write loop
// deliberately does NOT go through here.)
let bleOpChain: Promise<unknown> = Promise.resolve();
const BLE_OP_TIMEOUT_MS = 15000;
function bleSerial<T>(op: () => Promise<T>): Promise<T> {
  // Only the transport primitives below (read/write/connect) take this lock, and none of them
  // calls another, so nothing re-enters it. (An earlier "already inside the queue?" flag was
  // global, not per call chain: any op that arrived while another was in flight — a second
  // device's sync, the timestamp timer — saw it set and ran concurrently, defeating the queue.)
  //
  // Wrap with a timeout so a single hung BLE op (e.g. a peripheral that vanished
  // mid-operation) can't wedge the whole queue and silently block every later op.
  const guarded = () =>
    Promise.race<T>([
      op(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('BLE op timed out')), BLE_OP_TIMEOUT_MS)
      )
    ]);
  const run = bleOpChain.then(guarded, guarded); // run after the previous op regardless of its outcome
  bleOpChain = run.then(() => {}, () => {}); // never let one failure break the chain
  return run;
}

// Reassembly protocols (patterns/layouts) span several characteristic writes. Serialize the
// whole sequence per device so two UI actions cannot interleave chunks on a fast WebSocket.
const bulkWriteChains = new Map<string, Promise<unknown>>();
function serializeDeviceBulk<T>(deviceId: string, op: () => Promise<T>): Promise<T> {
  const previous = bulkWriteChains.get(deviceId) ?? Promise.resolve();
  const run = previous.then(op, op);
  bulkWriteChains.set(deviceId, run.then(() => {}, () => {}));
  return run;
}

// Import device store for UI state management
import {
  removeConnectedDevice, addConnectedDevice, updateDeviceInfo,
  connectedDevices as connectedDeviceStore,
} from './stores/deviceStore';

// ChromaBay LED Service UUID - the only service we care about for general commands
export const LED_SERVICE_UUID = 'a0be83e4-8dc9-47f0-ab40-b19721d20ed1';
// Original RX/TX Characteristics (still useful for general commands)
const CHARACTERISTIC_UUID_RX = 'a0be83e5-8dc9-47f0-ab40-b19721d20ed1';
const CHARACTERISTIC_UUID_TX = 'a0be83e6-8dc9-47f0-ab40-b19721d20ed1';

// New OTA Characteristics (within the same LED_SERVICE_UUID)
const CHARACTERISTIC_UUID_DEVICE_INFO = "a0be83e7-8dc9-47f0-ab40-b19721d20ed1";
const CHARACTERISTIC_UUID_COMM_CONFIG = "a0be83fa-8dc9-47f0-ab40-b19721d20ed1"; // device settings (feat>=2)
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
const CHARACTERISTIC_UUID_LAYOUT_SET = "a0be83f5-8dc9-47f0-ab40-b19721d20ed1"; // arbitrary pixel layout (WLED ledmap), per strip
const CHARACTERISTIC_UUID_LAYOUT_GET = "a0be83f6-8dc9-47f0-ab40-b19721d20ed1"; // read back a strip's layout (notify-chunked)
const CHARACTERISTIC_UUID_LIBRARY_DUMP = "a0be83f9-8dc9-47f0-ab40-b19721d20ed1"; // read the device's stored library (notify-chunked)
const CHARACTERISTIC_UUID_CALIBRATION = "a0be83f7-8dc9-47f0-ab40-b19721d20ed1"; // auto-layout structured-light flash control
const CHARACTERISTIC_UUID_LIBRARY_CMD = "a0be83f8-8dc9-47f0-ab40-b19721d20ed1"; // on-device pattern library ops (clear / delete-by-name)

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
  feat?: number;            // firmware capability level (absent = 1/legacy). Gate features on this.
  wifi?: number;            // 1 = the running image has the WiFi transport (feat>=2)
  slot?: number;            // OTA app-slot size in bytes (feat>=2) — which fw variant fits
  chip?: string;            // esp32 | esp32s3 | esp32c3 (absent on pre-multi-chip firmware)
  name?: string;
  mode?: 'ble' | 'wifi';    // active transport (feat>=2)
  ip?: string;              // device IP when on WiFi
  sleep?: number;           // sleep-timer minutes (0 = off)
  rgbtest?: number;         // 1 = boot RGB test on
  heap?: number;
}

// Realtime pixel-streaming protocols. A bitmask, so a device can listen for several at once:
// Art-Net and sACN carry DMX universes, DDP (UDP 4048 — xLights, WLED, Falcon) addresses one
// flat pixel array by byte offset and ignores the universe setting.
export const RT_PROTO = { OFF: 0, ARTNET: 1, SACN: 2, DDP: 4 } as const;
// What firmware without an `rtcaps` field (feat<3) supports.
export const RT_CAPS_LEGACY = RT_PROTO.ARTNET | RT_PROTO.SACN;

// Device settings (comm mode / WiFi creds / sleep timer / rgb-test), read as JSON from the
// COMM_CONFIG characteristic; password is never returned (hasPass indicates whether one is set).
export interface DeviceSettings {
  mode: 'ble' | 'wifi';
  ssid: string;
  hasPass: boolean;
  fallback: number;         // 0 = revert to BLE if WiFi fails, 1 = SoftAP
  sleep: number;            // minutes, 0 = off
  rgbtest: number;          // 1 = on
  rtproto: number;          // realtime stream protocols, bitmask: 1 Art-Net, 2 sACN, 4 DDP (0 = off)
  rtcaps?: number;          // protocols this firmware supports (same bits); absent = Art-Net|sACN only
  rtuni: number;            // first DMX universe consumed (Art-Net/sACN only; DDP carries its own byte offset)
  rtto: number;             // realtime revert timeout (seconds)
  rtlayout: number;         // 1 = stream into custom layout, 0 = physical order
  // Daily on/off schedule (firmware feat>=2; may be absent on older builds)
  sen?: number;             // 1 = schedule enabled
  son?: number;             // turn-on minute-of-day (local), 0..1439
  sof?: number;             // turn-off minute-of-day (local)
  tz?: number;              // device's stored UTC offset in minutes (local = UTC + tz)
  sdw?: number;             // day-of-week bitmask, bit0=Sun..bit6=Sat
  clk?: number;             // 1 = device currently knows the wall-clock time
  mode_active?: 'ble' | 'wifi';
  ip?: string;
}
// A patch written to COMM_CONFIG (msgpack). All fields optional; changing mode/ssid/pass reboots the device.
export interface DeviceSettingsPatch {
  mode?: 'ble' | 'wifi';
  ssid?: string;
  pass?: string;
  fallback?: number;
  sleep?: number;
  rgbtest?: boolean;
  rtproto?: number;         // bitmask, see RT_PROTO
  rtuni?: number;
  rtto?: number;
  rtlayout?: boolean;
  sen?: boolean;            // enable daily on/off schedule
  son?: number;             // turn-on minute-of-day (local), 0..1439
  sof?: number;             // turn-off minute-of-day (local)
  tz?: number;              // UTC offset in minutes (local = UTC + tz); app sends its own
  sdw?: number;             // day-of-week bitmask, bit0=Sun..bit6=Sat
}

export interface FirmwareRegistryEntry {
  version: string;          // e.g., "esp32-v1.0.1"
  chip?: string;            // esp32 | esp32s3 | esp32c3 (absent on entries predating multi-chip)
  wifi?: boolean;           // variant: true = WiFi build (needs the larger partition), false = no-WiFi.
                            //          absent on entries predating the split (treat as the only variant).
  size?: number;            // app image size in bytes — compared against the device's OTA slot to pick a variant.
  hardwareVersion: string;  // e.g., "esp32-hw-v1.0"
  path: string;             // Relative path to firmware.bin on gh-pages
  signaturePath: string;    // Relative path to firmware.sig on gh-pages
  date: string;             // ISO 8601 date string
}

// Legacy OTA slot size assumed for devices that don't report one (pre-feat-2 firmware on the
// old 1.375MB-slot partition). The WiFi image doesn't fit here → the app offers no-WiFi.
export const LEGACY_OTA_SLOT_BYTES = 0x150000; // 1,376,256

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
        for (const [id, info] of bleConnections.entries()) {
          noReconnect.add(id); // page is dying — don't let the disconnect event schedule a reconnect
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
        services: [LED_SERVICE_UUID],
        // Report every advertisement, not just the first sighting, so the UI can tell a
        // device is still present (refreshing a "last seen" time) and prune ones that have
        // gone quiet. Auto-reconnect is idempotent, so the repeated callbacks are harmless.
        allowDuplicates: true
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

// Auto-reconnect. The device itself is rock-solid (survives heavy traffic, malformed
// frames, rapid reconnects — never crashes or drops the link on its own), so a
// disconnect is almost always transient/external: RF/range (an LED curtain across the
// room sits at a weak RSSI), iOS backgrounding the app, or a brief power blip. Previously
// any drop just removed the device and left the user to manually re-scan + reconnect —
// which is the felt "disconnect issue". Now we transparently retry (backoff) unless the
// user asked to disconnect.
const reconnectDevices = new Map<string, any>();   // original device arg, for re-connect
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const noReconnect = new Set<string>();             // user-initiated disconnect / page unload
// Backoff schedule (ms); index past the end repeats the last value.
const RECONNECT_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000, 15000];
const RECONNECT_MAX_ATTEMPTS = 12;                 // ~2 min of trying, then stop (device likely off)

function scheduleReconnect(deviceId: string, attempt: number): void {
  if (noReconnect.has(deviceId)) return;            // user asked to disconnect
  if (bleConnections.has(deviceId)) return;         // already back
  if (reconnectTimers.has(deviceId)) return;        // one already in flight
  if (!reconnectDevices.has(deviceId)) return;      // nothing to reconnect to
  if (attempt >= RECONNECT_MAX_ATTEMPTS) {
    console.warn(`[reconnect] giving up on ${deviceId} after ${attempt} attempts`);
    reconnectDevices.delete(deviceId);
    return;
  }
  const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
  console.log(`[reconnect] ${deviceId} attempt ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms`);
  const timer = setTimeout(async () => {
    reconnectTimers.delete(deviceId);
    if (noReconnect.has(deviceId) || bleConnections.has(deviceId)) return;
    const device = reconnectDevices.get(deviceId);
    if (!device) return;
    try {
      await connectToDevice(device);               // re-registers sync + disconnect handling
      console.log(`[reconnect] ${deviceId} reconnected`);
    } catch (err) {
      console.warn(`[reconnect] ${deviceId} attempt ${attempt + 1} failed:`, err);
      scheduleReconnect(deviceId, attempt + 1);
    }
  }, delay);
  reconnectTimers.set(deviceId, timer);
}

/** Cancel any pending/further reconnection for a device (user-initiated disconnect, unload). */
function cancelReconnect(deviceId: string): void {
  const t = reconnectTimers.get(deviceId);
  if (t) { clearTimeout(t); reconnectTimers.delete(deviceId); }
  reconnectDevices.delete(deviceId);
}

// Shared cleanup for any disconnect path: the native onDisconnect callback, the
// web `gattserverdisconnected` event, or an explicit disconnectFromDevice().
// Idempotent — safe to call more than once for the same device. `intentional` (user
// disconnect / unload) suppresses auto-reconnect; any other drop schedules one.
export function handleDeviceDisconnected(deviceId: string, intentional = false): void {
  console.log(`Device ${deviceId} disconnected — cleaning up${intentional ? ' (intentional)' : ''}`);
  const info = bleConnections.get(deviceId);
  // Remove the web disconnect listener so it doesn't accumulate across reconnects
  // (the underlying BluetoothDevice object persists).
  if (info?.device && info.onDisconnect && typeof info.device.removeEventListener === 'function') {
    info.device.removeEventListener('gattserverdisconnected', info.onDisconnect);
  }
  bleConnections.delete(deviceId);
  clearWebCharCache(deviceId); // stale GATT objects after a reconnect would write into nothing
  removeConnectedDevice(deviceId);
  // Critical: stop the timestamp-sync interval, otherwise it keeps writing to a
  // dead handle every 10s (e.g. after an ESP32 OTA reboot).
  stopTimestampSync(deviceId);

  if (intentional) {
    cancelReconnect(deviceId);
  } else {
    // Unexpected drop — try to get it back automatically.
    scheduleReconnect(deviceId, 0);
  }
}

export async function connectToDevice(device: any): Promise<void> {
  // Remember this device so a later unexpected drop can auto-reconnect, and clear any
  // leftover "don't reconnect" suppression / pending timer from a prior session.
  if (device?.deviceId) {
    reconnectDevices.set(device.deviceId, device);
    noReconnect.delete(device.deviceId);
    const t = reconnectTimers.get(device.deviceId);
    if (t) { clearTimeout(t); reconnectTimers.delete(device.deviceId); }
  }
  try {
    if (isWeb()) {
      const gattServer = await bleSerial(() => device.webDevice.gatt.connect());

      // Replace any stale listener from a previous connect before adding a new
      // one, and keep a reference so it can be removed on disconnect.
      const prev = bleConnections.get(device.deviceId);
      if (prev?.onDisconnect) {
        device.webDevice.removeEventListener('gattserverdisconnected', prev.onDisconnect);
      }
      const onDisconnect = () => handleDeviceDisconnected(device.deviceId);
      device.webDevice.addEventListener('gattserverdisconnected', onDisconnect);

      bleConnections.set(device.deviceId, {
        device: device.webDevice,
        gattServer: gattServer,
        services: null,
        onDisconnect
      });
      console.log('Connected to device via Web Bluetooth');

    } else {
      // Pass an onDisconnect callback so native disconnects (out of range, OTA
      // reboot, power loss) are detected and cleaned up — previously they were
      // never noticed, leaving stale "connected" devices and a leaked sync timer.
      await bleSerial(() => BleClient.connect(device.deviceId, (disconnectedId: string) => {
        handleDeviceDisconnected(disconnectedId);
      }));
      bleConnections.set(device.deviceId, { device: device }); // Store native device info
      console.log('Connected to device via Capacitor');

    }
    
    // Add to device store for UI state management
    addConnectedDevice({
      deviceId: device.deviceId,
      name: device.name || 'Unknown Device',
      webDevice: device.webDevice,
      services: [],
      lastConnected: Date.now()
    });
    
    await initializeConnectedDevice(device.deviceId);
  } catch (error) {
    console.error('Error connecting to device:', error);
    throw error;
  }
}

export async function disconnectFromDevice(deviceId: string): Promise<void> {
  // A Wi-Fi device is disconnected by closing its socket; everything after that (store
  // cleanup, stopping timers) is the same work, so it shares the tail of this function.
  if (isWifiId(deviceId)) {
    noReconnect.add(deviceId);
    try { await getTransport(deviceId).disconnect(); }
    catch (error) { console.warn('Wi-Fi disconnect failed; treating as already disconnected:', error); }
    unregisterTransport(deviceId);
    handleDeviceDisconnected(deviceId, true);
    console.log(`Disconnected from ${hostFromWifiId(deviceId)}`);
    return;
  }
  // User asked to disconnect — suppress auto-reconnect and drop any pending retry.
  noReconnect.add(deviceId);
  cancelReconnect(deviceId);
  try {
    if (isWeb()) {
      const deviceInfo = bleConnections.get(deviceId);
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
  handleDeviceDisconnected(deviceId, true);
  console.log('Disconnected from device');
}

export function isDeviceConnected(deviceId: string): boolean {
  return get(connectedDeviceStore).has(deviceId);
}

export async function discoverServices(deviceId: string): Promise<any[]> {
  try {
    if (isWeb()) {
      const deviceInfo = bleConnections.get(deviceId);
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

// --- The Bluetooth transport -----------------------------------------------------------
// Everything BLE-specific about moving bytes lives here: the Web Bluetooth vs Capacitor
// split, and the serialization queue. Above this point nothing knows which link it is on.

// Web Bluetooth has no "stop listening" that takes the characteristic — you must hand back
// the same function object you added. Keeping them here makes stopNotifications actually
// stop (removeEventListener with a fresh closure silently does nothing).
const webNotifyListeners = new Map<string, EventListener>();
const notifyKey = (deviceId: string, characteristicUuid: string) => `${deviceId}|${characteristicUuid}`;

// Memoized: OTA writes thousands of chunks, and re-walking the GATT tree per write is the
// kind of overhead that used to justify a hand-cached characteristic in the OTA path.
const webCharCache = new Map<string, Promise<any>>();
async function webCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string) {
  const key = `${deviceId}|${serviceUuid}|${characteristicUuid}`;
  let pending = webCharCache.get(key);
  if (!pending) {
    pending = (async () => {
      const deviceInfo = bleConnections.get(deviceId);
      if (!deviceInfo?.gattServer) throw new Error('Device not connected');
      const service = await deviceInfo.gattServer.getPrimaryService(serviceUuid);
      return service.getCharacteristic(characteristicUuid);
    })();
    // A failed lookup must not be cached, or a reconnect keeps serving the rejection.
    pending.catch(() => webCharCache.delete(key));
    webCharCache.set(key, pending);
  }
  return pending;
}
function clearWebCharCache(deviceId: string) {
  for (const k of [...webCharCache.keys()]) if (k.startsWith(`${deviceId}|`)) webCharCache.delete(k);
}

const bleTransports = new Map<string, Transport>();

function bleTransportFor(deviceId: string): Transport {
  let t = bleTransports.get(deviceId);
  if (t) return t;
  t = {
    id: deviceId,
    kind: 'ble',
    get connected() { return bleConnections.has(deviceId); },
    // An ATT write has to fit the negotiated MTU; callers chunk to their own (smaller)
    // constants and this is the ceiling they must never exceed.
    // Ordinary acknowledged writes near 500 B proved unreliable on real devices. 184 B
    // (180 B body + a 4 B chunk header) fits comfortably across negotiated MTUs.
    maxWriteLen: 184,
    // OTA uses write-without-response plus characteristic ACKs, so it can use the full size.
    maxStreamWriteLen: MAX_BLE_CHUNK_SIZE,

    read: (serviceUuid, characteristicUuid) => bleSerial(async () => {
      if (isWeb()) return (await webCharacteristic(deviceId, serviceUuid, characteristicUuid)).readValue();
      return BleClient.read(deviceId, serviceUuid, characteristicUuid);
    }),

    write: (serviceUuid, characteristicUuid, value) => bleSerial(async () => {
      if (isWeb()) await (await webCharacteristic(deviceId, serviceUuid, characteristicUuid)).writeValueWithResponse(value);
      else await BleClient.write(deviceId, serviceUuid, characteristicUuid, value);
    }),

    writeWithoutResponse: (serviceUuid, characteristicUuid, value) => bleSerial(async () => {
      if (isWeb()) await (await webCharacteristic(deviceId, serviceUuid, characteristicUuid)).writeValueWithoutResponse(value);
      else await BleClient.writeWithoutResponse(deviceId, serviceUuid, characteristicUuid, value);
    }),

    // Deliberately NOT through bleSerial — see Transport.writeStream.
    writeStream: async (serviceUuid, characteristicUuid, value) => {
      if (isWeb()) await (await webCharacteristic(deviceId, serviceUuid, characteristicUuid)).writeValueWithoutResponse(value);
      else await BleClient.writeWithoutResponse(deviceId, serviceUuid, characteristicUuid, value);
    },

    startNotifications: async (serviceUuid, characteristicUuid, cb) => {
      if (isWeb()) {
        const characteristic = await webCharacteristic(deviceId, serviceUuid, characteristicUuid);
        await characteristic.startNotifications();
        const key = notifyKey(deviceId, characteristicUuid);
        const prev = webNotifyListeners.get(key);
        if (prev) characteristic.removeEventListener('characteristicvaluechanged', prev);
        const listener = ((event: any) => cb(event.target.value as DataView)) as EventListener;
        characteristic.addEventListener('characteristicvaluechanged', listener);
        webNotifyListeners.set(key, listener);
      } else {
        await BleClient.startNotifications(deviceId, serviceUuid, characteristicUuid, (v: DataView) => cb(v));
      }
    },

    stopNotifications: async (serviceUuid, characteristicUuid) => {
      if (isWeb()) {
        const characteristic = await webCharacteristic(deviceId, serviceUuid, characteristicUuid);
        await characteristic.stopNotifications();
        const key = notifyKey(deviceId, characteristicUuid);
        const listener = webNotifyListeners.get(key);
        if (listener) {
          characteristic.removeEventListener('characteristicvaluechanged', listener);
          webNotifyListeners.delete(key);
        }
      } else {
        await BleClient.stopNotifications(deviceId, serviceUuid, characteristicUuid);
      }
    },

    disconnect: async () => { await disconnectFromDevice(deviceId); },
  };
  bleTransports.set(deviceId, t);
  return t;
}

// Any deviceId that is not a registered Wi-Fi device resolves to Bluetooth.
setBleTransportFactory(bleTransportFor);

// --- Characteristic primitives (transport-agnostic) -------------------------------------
// The six operations everything else is built from. They take a deviceId and dispatch to
// whichever link is carrying it, so a caller cannot accidentally be BLE-only.

export async function readCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<string> {
  try {
    return decodeDataViewAsUtf8(await getTransport(deviceId).read(serviceUuid, characteristicUuid));
  } catch (error) {
    console.error(`Error reading characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

export async function readCharacteristicBinary(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<DataView> {
  return getTransport(deviceId).read(serviceUuid, characteristicUuid);
}

export async function writeCharacteristic(deviceId: string, serviceUuid: string, characteristicUuid: string, data: string): Promise<void> {
  try {
    await getTransport(deviceId).write(serviceUuid, characteristicUuid, textToDataView(data));
  } catch (error) {
    console.error(`Error writing to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

async function writeCharacteristicWithoutResponse(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  try {
    await getTransport(deviceId).writeWithoutResponse(serviceUuid, characteristicUuid, dataView);
  } catch (error) {
    console.error(`Error writing (NR) to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

export async function startNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string, callback: (data: string) => void): Promise<void> {
  try {
    await getTransport(deviceId).startNotifications(serviceUuid, characteristicUuid, (v) => callback(decodeDataViewAsUtf8(v)));
    console.log(`Started notifications for ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error starting notifications for ${characteristicUuid}:`, error);
    throw error;
  }
}

// Like startNotifications but hands the callback the raw DataView (for binary chars such as
// brightness, a single byte). Kept separate so the string path above is unchanged.
export async function startBinaryNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string, callback: (data: DataView) => void): Promise<void> {
  await getTransport(deviceId).startNotifications(serviceUuid, characteristicUuid, callback);
  console.log(`Started binary notifications for ${characteristicUuid}`);
}

// Subscribe to device-initiated brightness changes (button press, on/off schedule → 0 or
// restore, boot floor). feat>=2 firmware notifies the BRIGHTNESS characteristic; older
// firmware never notifies, so this is simply inert there.
export async function startBrightnessNotifications(deviceId: string, callback: (brightness: number) => void): Promise<void> {
  await startBinaryNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BRIGHTNESS, (dv) => {
    if (dv.byteLength >= 1) callback(dv.getUint8(0));
  });
}

export async function stopNotifications(deviceId: string, serviceUuid: string, characteristicUuid: string): Promise<void> {
  try {
    await getTransport(deviceId).stopNotifications(serviceUuid, characteristicUuid);
    console.log(`Stopped notifications for ${characteristicUuid}`);
  } catch (error) {
    console.error(`Error stopping notifications for ${characteristicUuid}:`, error);
    throw error;
  }
}

export function getConnectedDevices(): string[] {
  return Array.from(get(connectedDeviceStore).keys());
}

export function getConnectedDeviceCount(): number {
  return get(connectedDeviceStore).size;
}

/** Start the link-independent session work after either BLE or Wi-Fi joins deviceStore. */
export async function initializeConnectedDevice(deviceId: string): Promise<void> {
  startTimestampSync(deviceId);
  console.log(`Syncing current pattern after ${deviceId} connected...`);
  try {
    await syncPatternToAllDevices();
    console.log('Initial pattern sync completed');
  } catch (error) {
    console.error('Failed to sync initial pattern to device:', error);
    // The link is still valid; a later edit/tap retries the live sync.
  }
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

// Read device settings (comm mode / WiFi / sleep / rgb-test) from the COMM_CONFIG
// characteristic. Requires firmware feat>=2; returns null on older firmware (char absent).
export async function readDeviceSettings(deviceId: string): Promise<DeviceSettings | null> {
  try {
    const json = await readCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_COMM_CONFIG);
    const s = JSON.parse(json);
    return { ...s, hasPass: !!s.hasPass } as DeviceSettings;
  } catch (e) {
    console.warn('[settings] COMM_CONFIG unavailable (older firmware?):', e);
    return null;
  }
}

// Write a settings patch (msgpack) to COMM_CONFIG. Changing mode/ssid/pass reboots the
// device into the new transport — the caller should expect the BLE link to drop after this.
export async function writeDeviceSettings(deviceId: string, patch: DeviceSettingsPatch): Promise<void> {
  const bytes = msgpackEncode(patch) as Uint8Array;
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_COMM_CONFIG,
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  console.log('[settings] wrote patch', patch);
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

// Result of resolving the newest firmware for a device: the recommended entry (the WiFi
// variant if it fits the device's OTA slot, else the no-WiFi one), plus both variants and a
// flag so the UI can let the user switch and can say "USB-flash to unlock WiFi" when the
// WiFi build is too big for the current partition.
export interface FirmwareChoice {
  recommended: FirmwareRegistryEntry | null;
  wifi: FirmwareRegistryEntry | null;
  nowifi: FirmwareRegistryEntry | null;
  wifiFits: boolean;        // does the WiFi variant fit the device's OTA slot?
  slotBytes: number;        // slot used for the decision (device-reported or legacy assumption)
}

// Resolve the newest firmware for a device, variant-aware. `slot` = the device's OTA slot
// size (DeviceInfo.slot); when absent we assume the legacy 1.375MB slot so we never offer a
// WiFi image that would fail the OTA on an un-repartitioned device.
export function resolveFirmware(
  registry: FirmwareRegistryEntry[],
  chip?: string,
  currentHwVersion?: string,
  slot?: number
): FirmwareChoice {
  const empty: FirmwareChoice = { recommended: null, wifi: null, nowifi: null, wifiFits: false, slotBytes: slot || LEGACY_OTA_SLOT_BYTES };
  if (!registry.length) return empty;
  const wantChip = chip && chip !== 'unknown' ? chip : 'esp32';
  const forChip = registry.filter(e => (e.chip ?? 'esp32') === wantChip);
  if (!forChip.length) return empty;
  const byDateDesc = [...forChip].sort((a, b) => b.date.localeCompare(a.date));
  const compatible = currentHwVersion ? byDateDesc.filter(e => e.hardwareVersion === currentHwVersion) : [];
  const pool = compatible.length ? compatible : byDateDesc;
  const newestVersion = pool[0].version;
  const sameVersion = pool.filter(e => e.version === newestVersion);
  const wifi = sameVersion.find(e => e.wifi === true) ?? null;
  const nowifi = sameVersion.find(e => e.wifi === false) ?? null;
  const slotBytes = slot && slot > 0 ? slot : LEGACY_OTA_SLOT_BYTES;
  // Legacy single-variant version (no wifi field): just return it.
  if (!wifi && !nowifi) return { recommended: sameVersion[0], wifi: null, nowifi: null, wifiFits: false, slotBytes };
  // WiFi fits if we have it and either its size is known-and-fits, or size is unknown but the
  // slot is clearly the new large partition (> legacy).
  const wifiFits = !!wifi && (wifi.size != null ? wifi.size <= slotBytes : slotBytes > LEGACY_OTA_SLOT_BYTES);
  const recommended = wifiFits ? wifi : (nowifi ?? wifi);
  return { recommended, wifi, nowifi, wifiFits, slotBytes };
}

export function findLatestFirmware(
  registry: FirmwareRegistryEntry[],
  chip?: string,
  currentHwVersion?: string,
  slot?: number
): FirmwareRegistryEntry | null {
  // Variant-aware since the WiFi/no-WiFi split; keeps the old signature working (slot optional).
  if (arguments.length >= 4 || registry.some(e => e.wifi !== undefined)) {
    return resolveFirmware(registry, chip, currentHwVersion, slot).recommended;
  }
  if (registry.length === 0) {
    console.log('[OTA] Firmware registry is empty');
    return null;
  }
  // Chip must match: cross-flashing architectures (e.g. an ESP32-S3 image onto a classic
  // ESP32) bricks the device. Pre-multi-chip firmware doesn't report a chip and every
  // device in the field then was a classic ESP32, so treat missing/unknown as 'esp32';
  // registry entries predating the chip field are likewise classic ESP32.
  const wantChip = chip && chip !== 'unknown' ? chip : 'esp32';
  const forChip = registry.filter(e => (e.chip ?? 'esp32') === wantChip);
  if (forChip.length === 0) {
    console.warn(`[OTA] No firmware in registry for chip "${wantChip}" — not offering an update (won't cross-flash architectures).`);
    return null;
  }
  // Newest entry by build date (don't rely on registry ordering).
  const byDateDesc = [...forChip].sort((a, b) => b.date.localeCompare(a.date));
  // Prefer firmware matching the device's hardware version, but never let a hardware
  // mismatch hide an available update — fall back to newest for the same chip.
  const compatible = currentHwVersion
    ? byDateDesc.filter(e => e.hardwareVersion === currentHwVersion)
    : [];
  const latest = compatible[0] ?? byDateDesc[0];
  if (currentHwVersion && compatible.length === 0) {
    console.log(`[OTA] No firmware tagged for HW ${currentHwVersion} (chip ${wantChip}); falling back to newest for that chip: ${latest.version} (${latest.date})`);
  } else {
    console.log(`[OTA] Latest firmware for chip ${wantChip}: ${latest.version} (${latest.date})`);
  }
  return latest;
}

export async function sendOTAControlCommand(deviceId: string, command: 'END_OTA' | 'END_OTA_UNSIGNED' | 'ABORT_OTA'): Promise<void> {
  console.log(`[OTA] Sending control command: ${command} to ${deviceId}`);
  await writeCharacteristic(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_CONTROL, command);
}

export async function sendFirmwareSignature(deviceId: string, signature: ArrayBuffer): Promise<void> {
  console.log(`[OTA] Sending firmware signature (${signature.byteLength} bytes) to ${deviceId}`);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_SIGNATURE,
                                  new DataView(signature));
}

// Write one firmware chunk WITHOUT waiting for its ACK. Flow control is handled by the
// caller's sliding window (see performOTAUpdate), which keeps a bounded number of
// chunks in flight using the per-chunk ACK notifications the ESP32 already sends. This
// is what makes the fast path backwards-compatible: the firmware is unchanged and still
// ACKs every chunk; we just stop idling for a full round-trip between each one.
async function writeChunkNoWait(deviceId: string, chunk: ArrayBuffer): Promise<void> {
  await getTransport(deviceId).writeStream(LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA,
                                           new DataView(chunk));
}

// Number of chunks kept in flight before waiting for ACKs. Conservative so we don't
// overrun the controller's write-without-response buffer (which would drop chunks — a
// failed, not bricked, update thanks to signature verification + rollback).
const OTA_WINDOW = 8;

// Size of a single OTA app slot (app0/app1) in the device's partition table — the hard
// ceiling for any image we stream. Conservative floor = the 4MB layout's 1.75 MB slot
// (esp32/partitions-4mb.csv); 8MB chips actually have 2 MB slots, so this only ever
// under-refuses, never over-accepts. Used to reject an over-large image (e.g. a big WLED
// build) up front instead of failing ~90% through a slow BLE transfer. TODO: have the
// device report update_partition->size in device-info so this isn't hard-coded.
const OTA_APP_SLOT_BYTES = 0x1c0000; // 1,835,008 (1.75 MB)

/**
 * The last OTA_ERR_* the device reported, or null.
 *
 * The device refusing an update and the device going quiet look identical to a sender that
 * only watches ACKs: it keeps waiting for chunk acknowledgements that are never coming, and
 * fails 15 s later with "Timeout waiting for OTA ACK" — which names the symptom and hides
 * the cause. A real device refused an update with OTA_ERR_MEMORY on its very first chunk and
 * this is what the user saw. The device says why; read it.
 */
let otaDeviceFault: string | null = null;

export async function startOTAStatusNotifications(deviceId: string, callback: (status: OTAUpdateStatus) => void): Promise<void> {
  console.log(`[OTA] Starting status notifications for ${deviceId}`);
  await startNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_STATUS, (stringValue) => {
    if (stringValue.startsWith('OTA_ERR')) otaDeviceFault = stringValue;
    callback({ statusMessage: stringValue });
  });
}

export async function stopOTAStatusNotifications(deviceId: string): Promise<void> {
  console.log(`[OTA] Stopping status notifications for ${deviceId}`);
  await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_STATUS);
}

// Main OTA Process Orchestrator
/**
 * Download firmware + signature, caching by version so a later OTA can run offline.
 * Best-effort: returns silently if the fetch fails or IndexedDB is unavailable.
 * Call this while online (e.g. when the Devices page loads the registry).
 */
export function firmwareCacheKey(version: string, firmwareUrl: string): string {
  // The URL contains /<version>/<chip>/<filename>; retaining it makes every chip and
  // Wi-Fi/no-Wi-Fi variant distinct while remaining deterministic across launches.
  return `${version}:${firmwareUrl}`;
}

export async function prefetchFirmware(
  version: string,
  date: string,
  firmwareUrl: string,
  signatureUrl: string
): Promise<boolean> {
  try {
    const key = firmwareCacheKey(version, firmwareUrl);
    if (await getFirmware(version, key)) return true; // already cached
    const [binResp, sigResp] = await Promise.all([fetch(firmwareUrl), fetch(signatureUrl)]);
    if (!binResp.ok || !sigResp.ok) return false;
    const bin = await binResp.arrayBuffer();
    const sig = await sigResp.arrayBuffer();
    if (sig.byteLength !== 64) return false; // not a valid signature; don't poison the cache
    await putFirmware({ key, version, date, bin, sig, cachedAt: Date.now() });
    console.log(`[OTA] Prefetched firmware ${key} into offline cache.`);
    return true;
  } catch (e) {
    console.warn('[OTA] Firmware prefetch skipped:', e);
    return false;
  }
}

/** Cache every current chip/partition variant as soon as the app opens. */
export async function prefetchLatestFirmwareSet(
  registryUrl = 'https://chromabay.app/firmware/esp32/esp32_firmware_registry.json'
): Promise<{ cached: number; total: number }> {
  const registry = await fetchFirmwareRegistry(registryUrl);
  if (!registry.length) return { cached: 0, total: 0 };
  const newestDate = [...registry].sort((a, b) => b.date.localeCompare(a.date))[0].date;
  const newestVersion = [...registry].sort((a, b) => b.date.localeCompare(a.date))[0].version;
  // Registry entries of a release share version/date. Cache all six supported variants.
  const entries = registry.filter((e) => e.version === newestVersion && e.date === newestDate);
  const base = 'https://chromabay.app';
  const results = await Promise.all(entries.map((e) => prefetchFirmware(
    e.version, e.date, `${base}/${e.path}`, `${base}/${e.signaturePath}`
  )));
  const cached = results.filter(Boolean).length;
  console.log(`[OTA] Offline firmware set ready: ${cached}/${entries.length} images for ${newestVersion}`);
  return { cached, total: entries.length };
}

export async function performOTAUpdate(
  deviceId: string,
  firmwareUrl: string,
  signatureUrl: string,
  progressCallback: (status: OTAUpdateStatus) => void,
  version?: string,
  date?: string
): Promise<void> {
  console.log(`[OTA] Starting OTA update for ${deviceId} from ${firmwareUrl}`);
  progressCallback({ statusMessage: 'Starting OTA...' });

  // 1. Resolve firmware + signature — cache-first, so an OTA can run with NO internet
  //    if the image was prefetched earlier (see prefetchFirmware). On a cache miss we
  //    fetch from the registry and store the result for next time.
  let firmwareBuffer: ArrayBuffer;
  let signatureBuffer: ArrayBuffer;
  try {
    const cached = version ? await getFirmware(version, firmwareCacheKey(version, firmwareUrl)) : null;
    if (cached) {
      firmwareBuffer = cached.bin;
      signatureBuffer = cached.sig;
      progressCallback({ statusMessage: `Using cached firmware ${version} (${firmwareBuffer.byteLength} bytes).` });
    } else {
      progressCallback({ statusMessage: 'Downloading firmware...' });
      const firmwareResponse = await fetch(firmwareUrl);
      if (!firmwareResponse.ok) throw new Error(`Failed to download firmware: ${firmwareResponse.statusText}`);
      firmwareBuffer = await firmwareResponse.arrayBuffer();
      progressCallback({ statusMessage: `Firmware downloaded (${firmwareBuffer.byteLength} bytes).` });

      progressCallback({ statusMessage: 'Downloading signature...' });
      const signatureResponse = await fetch(signatureUrl);
      if (!signatureResponse.ok) throw new Error(`Failed to download signature: ${signatureResponse.statusText}`);
      signatureBuffer = await signatureResponse.arrayBuffer();
      progressCallback({ statusMessage: `Signature downloaded (${signatureBuffer.byteLength} bytes).` });

      if (signatureBuffer.byteLength !== 64) { // FIRMWARE_SIGNATURE_LENGTH from C++
          throw new Error(`Invalid signature length: ${signatureBuffer.byteLength}. Expected 64.`);
      }
      // Store for offline reuse (best-effort; keyed by version).
      if (version) {
        try { await putFirmware({ key: firmwareCacheKey(version, firmwareUrl), version, date: date ?? '', bin: firmwareBuffer, sig: signatureBuffer, cachedAt: Date.now() }); }
        catch (e) { console.warn('[OTA] cache store failed:', e); }
      }
    }

    if (signatureBuffer.byteLength !== 64) { // FIRMWARE_SIGNATURE_LENGTH from C++
        throw new Error(`Invalid signature length: ${signatureBuffer.byteLength}. Expected 64.`);
    }
  } catch (error: any) {
    console.error('[OTA] OTA Update Failed (resolving firmware):', error);
    progressCallback({ statusMessage: `OTA Failed: ${error.message}`, error: error.message, isError: true, isComplete: true });
    throw error;
  }

  // 2. Stream the resolved (always-signed) image over BLE and finalize.
  await streamFirmwareOverBle(deviceId, firmwareBuffer, signatureBuffer, progressCallback);
}

/**
 * Flash a firmware image the caller already holds in memory (e.g. a user-picked file),
 * rather than one resolved from the registry/cache. When `signatureBuffer` is provided it
 * takes the signed path (device verifies it); when null the device is asked to finalize
 * WITHOUT verification (END_OTA_UNSIGNED) — the escape hatch for flashing arbitrary images
 * such as reverting a device to stock WLED. Unsigned flashing can brick a device that then
 * needs USB recovery, so callers must gate it behind an explicit user confirmation.
 */
export async function performManualOTAUpdate(
  deviceId: string,
  firmwareBuffer: ArrayBuffer,
  signatureBuffer: ArrayBuffer | null,
  progressCallback: (status: OTAUpdateStatus) => void
): Promise<void> {
  console.log(`[OTA] Starting manual OTA for ${deviceId} (${firmwareBuffer.byteLength} bytes, ${signatureBuffer ? 'signed' : 'UNSIGNED'})`);
  progressCallback({ statusMessage: signatureBuffer ? 'Starting signed update…' : 'Starting unsigned update…' });
  if (firmwareBuffer.byteLength === 0) throw new Error('Firmware file is empty.');
  if (signatureBuffer && signatureBuffer.byteLength !== 64) {
    throw new Error(`Invalid signature length: ${signatureBuffer.byteLength}. Expected 64 bytes.`);
  }
  // Refuse up front if the image can't fit the OTA slot. Without this the device would
  // erase the target partition, accept chunks, and only fail near the end when esp_ota_write
  // runs past the partition bound — wasting a multi-minute BLE transfer. Common trigger: a
  // large WLED build (audioreactive/usermods) when reverting to stock. Tell the user to use
  // USB instead (esptool writes a fresh partition table + app; over-the-air can't).
  if (firmwareBuffer.byteLength > OTA_APP_SLOT_BYTES) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(2);
    throw new Error(
      `This firmware is ${mb(firmwareBuffer.byteLength)} MB, larger than the device's ` +
      `${mb(OTA_APP_SLOT_BYTES)} MB over-the-air slot, so it can't be flashed wirelessly. ` +
      `Use a USB cable to flash it instead (e.g. install.wled.me or esptool).`
    );
  }
  await streamFirmwareOverBle(deviceId, firmwareBuffer, signatureBuffer, progressCallback);
}

/**
 * Send an in-memory firmware image to a connected device over BLE and finalize it. Shared
 * by performOTAUpdate (signed, registry-sourced) and performManualOTAUpdate (file-sourced,
 * optionally unsigned). A non-null `signatureBuffer` is sent and the device verifies it via
 * END_OTA; a null one finalizes via END_OTA_UNSIGNED (no verification).
 */
async function streamFirmwareOverBle(
  deviceId: string,
  firmwareBuffer: ArrayBuffer,
  signatureBuffer: ArrayBuffer | null,
  progressCallback: (status: OTAUpdateStatus) => void
): Promise<void> {
  let otaDataNotificationsStartedForAck = false;
  // Declared at function scope so the finally block can detach it. Assigned in step 3.
  let onAck: () => void = () => {};

  try {
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
    // A refusal from the device ends the transfer now, with the device's own reason.
    otaDeviceFault = null;
    const throwIfDeviceRefused = () => {
      if (otaDeviceFault) throw new Error(`Device stopped the update: ${otaDeviceFault}`);
    };
    // Resolves on the next ACK; rejects on a device refusal, or after a timeout (a stall).
    const waitForAck = (timeoutMs: number) => new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(t); clearInterval(poll); ackWaiter = null; fn(); };
      const t = setTimeout(() => done(() => reject(new Error('Timeout waiting for OTA ACK'))), timeoutMs);
      const poll = setInterval(() => {
        if (otaDeviceFault) done(() => reject(new Error(`Device stopped the update: ${otaDeviceFault}`)));
      }, 100);
      ackWaiter = () => done(resolve);
    });

    // The device ACKs each chunk by notifying OTA_DATA. Over Wi-Fi that is the same
    // characteristic on the same channel, so the window works there unchanged.
    await startBinaryNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA, () => onAck());
    otaDataNotificationsStartedForAck = true;

    // 4. Send firmware as a sliding window: keep up to OTA_WINDOW chunks in flight,
    //    sending the next as each ACK arrives. ~OTA_WINDOW× fewer round-trips than
    //    stop-and-wait, while the ACK-driven window prevents overrunning the device.
    let offset = 0;
    let sentChunks = 0;
    const totalSize = firmwareBuffer.byteLength;
    const streamChunkSize = getTransport(deviceId).maxStreamWriteLen;
    // The binding constraint is the device's HEAP, not the WebSocket parser's ~64 KiB
    // inbound buffer. A classic ESP32 running a real installation has ~75 KB free, and
    // every byte in flight is a byte of it: a 60 KiB window left so little behind that the
    // update transferred all 1.4 MB and then died at the finalize, unable to allocate the
    // 16 KB signature-verification task (OTA_ERR_TASK_CREATE). Firmware now reserves that
    // task up front, but keeping the window small is the other half — it leaves the device
    // room to render, receive and write while the transfer runs. 24 KiB is three of Wi-Fi's
    // 8 KiB writes, still ~3x fewer round-trips than stop-and-wait; BLE (500 B) stays at eight.
    // 8 KiB. Measured on a classic ESP32 ballasted to ~64 KB free: 4 KiB writes three deep
    // failed every time and two deep succeeded every time, because the socket buffer has to
    // hold whatever is in flight and mid-update the largest contiguous block is only ~8 KB.
    // Costs about 6 s on a 1.4 MB image and buys updates that finish on the small chip.
    const OTA_MAX_IN_FLIGHT_BYTES = 8 * 1024;
    const streamWindow = Math.max(1, Math.min(OTA_WINDOW, Math.floor(OTA_MAX_IN_FLIGHT_BYTES / streamChunkSize)));
    const totalChunks = Math.ceil(totalSize / streamChunkSize);
    progressCallback({ statusMessage: 'Sending firmware data...', progress: 0 });

    while (offset < totalSize) {
      // Wait until the window has room (bounded chunks awaiting ACK).
      while (sentChunks - ackedChunks >= streamWindow) {
        await waitForAck(15000);
      }
      throwIfDeviceRefused();
      const chunkEnd = Math.min(offset + streamChunkSize, totalSize);
      await writeChunkNoWait(deviceId, firmwareBuffer.slice(offset, chunkEnd));
      offset = chunkEnd;
      sentChunks++;
      const progress = Math.round((offset / totalSize) * 100);
      progressCallback({ statusMessage: `Sending firmware: ${progress}%`, progress });
    }

    // Drain remaining ACKs so we know the device wrote everything. If a tail ACK
    // notification is lost the wait times out — we proceed anyway: the device's
    // esp_ota_end image check (and, on the signed path, signature verification) is the
    // real integrity gate, so a truly dropped chunk fails the finalize rather than booting
    // corrupt firmware.
    while (ackedChunks < totalChunks) {
      try { await waitForAck(15000); } catch { break; }
    }
    progressCallback({ statusMessage: 'All firmware chunks sent.', progress: 100 });

    // 5. Send signature AFTER firmware data (signed path only).
    if (signatureBuffer) {
      progressCallback({ statusMessage: 'Sending signature...' });
      await sendFirmwareSignature(deviceId, signatureBuffer);
      progressCallback({ statusMessage: 'Signature sent.' });
    }

    // 6. Finalize: END_OTA verifies the signature then reboots; END_OTA_UNSIGNED skips
    //    verification (unsigned manual upload) and reboots directly.
    const endCommand = signatureBuffer ? 'END_OTA' : 'END_OTA_UNSIGNED';
    progressCallback({ statusMessage: 'Finalizing update...' });
    try {
      await sendOTAControlCommand(deviceId, endCommand);
      progressCallback({ statusMessage: 'Update finalized. Device should be rebooting...', isComplete: true });
    } catch (error: any) {
      // If the finalize write fails, it's likely because ESP32 rebooted during finalize
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
            await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_OTA_DATA);
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
  
  const deviceIds = getConnectedDevices();
  if (deviceIds.length === 0) {
    console.log('No devices connected, skipping pattern sync');
    return;
  }

  try {
    // Serialize the current pattern. lib:false → this is a Live push (preview/current): the
    // device shows it + persists it as the boot pattern, but does NOT add it to the cycle.
    const serializedPattern = serializeCurrentPattern();
    console.log('Serialized pattern:', serializedPattern);

    // Encode as MessagePack
    const msgpackData = msgpackEncode({ ...serializedPattern, lib: false }) as Uint8Array;

    console.log(`Pattern serialized: ${msgpackData.byteLength} bytes`);

    // Send to all connected devices
    const syncPromises = deviceIds.map(async (deviceId) => {
      try {
        console.log(`Sending pattern to device ${deviceId}`);
        await sendPatternChunked(deviceId, msgpackData);
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
 * CycleControlCallbacks): [u32 intervalMs][u8 enabled][u32 crossfadeMs], little-endian.
 *
 * crossfadeSeconds dissolves each pattern into the next instead of cutting; 0 cuts, as
 * before. Firmware older than feat 4 ignores the trailing word — it reads the first five
 * bytes and stops — so sending it unconditionally is safe and costs nothing.
 */
export async function setCycleOnDevice(
  deviceId: string,
  enabled: boolean,
  intervalSeconds: number,
  crossfadeSeconds: number = 0
): Promise<void> {
  const intervalMs = Math.max(1, Math.round(intervalSeconds * 1000));
  const crossfadeMs = Math.max(0, Math.round(crossfadeSeconds * 1000));
  const out = new Uint8Array(9);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, intervalMs, true);
  dv.setUint8(4, enabled ? 1 : 0);
  dv.setUint32(5, crossfadeMs, true);
  console.log(`[Cycle] ${enabled ? 'ON' : 'OFF'} @ ${intervalMs}ms, crossfade ${crossfadeMs}ms -> ${deviceId}`);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_PLAYLIST_SYNC, dv);
}

/**
 * Push a single named pattern to ONE device. The device upserts it into its library
 * by name (meta.name) and shows it. ("Here's your pattern now.")
 */
export async function sendSinglePatternToDevice(deviceId: string, pattern: any): Promise<void> {
  // Strip app/cloud-sync metadata (id/updatedAt/deleted) — the device wire is name+output only.
  // lib:true → this is a deliberate "sync": the device adds it to its cycled library.
  const clean = { ...pattern, meta: { name: pattern?.meta?.name, output: pattern?.meta?.output ?? 1 }, lib: true };
  const msgpackData = msgpackEncode(clean) as Uint8Array;
  await sendPatternChunked(deviceId, msgpackData);
}

/**
 * Send a msgpack-encoded pattern to PATTERN_SYNC in chunks framed
 * [u16 totalLen LE][u16 offset LE][payload], reassembled on the device (mirrors
 * LAYOUT_SET). A single BLE write is capped ~512B by CoreBluetooth, so a larger
 * pattern (e.g. a detailed SVG-fill path) would otherwise be silently truncated
 * and never load. Writes are serialized + in-order via bleSerial, which the
 * device's offset-based reassembly relies on.
 */
async function sendPatternChunked(deviceId: string, msgpackData: Uint8Array): Promise<void> {
  const total = msgpackData.byteLength;
  if (total === 0) return;
  // The firmware drops a pattern whose totalLen is over 16 KiB without replying (and the u16
  // length/offset fields can't describe more than 64 KiB). Fail here instead, so the pattern
  // isn't reported as synced when the device never got it.
  if (total > 16384) {
    throw new Error(
      `Pattern is ${total.toLocaleString()} bytes, but devices accept at most 16,384. ` +
      `Remove some nodes or shorten long text/SVG parameters.`,
    );
  }
  const HEADER = 4;
  const MAX_PAYLOAD = getTransport(deviceId).maxWriteLen - HEADER;
  await serializeDeviceBulk(deviceId, async () => {
    for (let offset = 0; offset < total; offset += MAX_PAYLOAD) {
      const payloadLen = Math.min(MAX_PAYLOAD, total - offset);
      const frame = new Uint8Array(HEADER + payloadLen);
      const dv = new DataView(frame.buffer);
      dv.setUint16(0, total, true);  // totalLen LE
      dv.setUint16(2, offset, true); // offset LE
      frame.set(msgpackData.subarray(offset, offset + payloadLen), HEADER);
      const view = new DataView(frame.buffer, 0, frame.byteLength);
      await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_PATTERN_SYNC, view);
    }
  });
}

// === ON-DEVICE PATTERN LIBRARY MAINTENANCE ===
// The app is the source of truth (device→app sync isn't built), so these keep the device's
// stored/cycled set aligned with the app: [0x00] clears all; [0x01]+name deletes one.

/** Wipe ALL stored patterns on one device (the live/displayed pattern keeps running). */
export async function clearDeviceLibrary(deviceId: string): Promise<void> {
  const dv = new DataView(new Uint8Array([0x00]).buffer);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LIBRARY_CMD, dv);
}

/** Delete the pattern with this name from one device's library. */
export async function deletePatternOnDevice(deviceId: string, name: string): Promise<void> {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(1 + nameBytes.length);
  out[0] = 0x01;
  out.set(nameBytes, 1);
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LIBRARY_CMD, new DataView(out.buffer));
}

/** Best-effort clear on every connected device. */
export async function clearLibraryOnAllDevices(): Promise<void> {
  await Promise.allSettled(getConnectedDevices().map((id) => clearDeviceLibrary(id)));
}

/** Best-effort delete-by-name on every connected device (wired to in-app pattern deletes). */
export async function deletePatternOnAllDevices(name: string): Promise<void> {
  const deviceIds = getConnectedDevices();
  if (deviceIds.length === 0) return;
  await Promise.allSettled(deviceIds.map((id) => deletePatternOnDevice(id, name)));
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
  try {
    await writeCharacteristicWithoutResponse(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_BRIGHTNESS, dataView);
  } catch (error) {
    console.error(`Error sending brightness to ${deviceId}:`, error);
    throw error;
  }
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
export async function writeCharacteristicBinary(deviceId: string, serviceUuid: string, characteristicUuid: string, dataView: DataView): Promise<void> {
  try {
    await getTransport(deviceId).write(serviceUuid, characteristicUuid, dataView);
  } catch (error) {
    console.error(`Error writing binary data to characteristic ${characteristicUuid}:`, error);
    throw error;
  }
}

export interface LedStripConfig {
  chipset: number;
  pin: number;          // data pin (all chipsets)
  clockPin?: number;    // clock pin — only used by 4-wire SPI chipsets (APA102/SK9822)
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
  dither?: boolean; // per-strip temporal-dithering opt-in (auto-activates only if fast enough); default true
  // RGBW auto-white mode and white-die colour (0xRRGGBB). No UI edits them yet; they are
  // carried from the device's report back into every save so a save doesn't reset them.
  autoWhite?: number;
  whiteLedColor?: number;
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
  SM16825_RGBCW: 65,
  // 4-wire SPI (clock + data) — these expose a clock-pin input in the UI.
  APA102_SPI: 25,
  SK9822_SPI: 26
} as const;

// Chipsets that need a clock pin in addition to the data pin (4-wire SPI). Must mirror
// led_types.h isFourWire().
export function isFourWireChipset(chipset: number): boolean {
  return chipset === LedChipsets.APA102_SPI || chipset === LedChipsets.SK9822_SPI;
}

// Single-core ESP32 variants (from DeviceInfo.chip). On these the render loop shares a core
// with Bluetooth, so timing-critical one-wire LEDs (WS2812 etc.) can flicker when BLE preempts
// output — 4-wire clock+data LEDs (APA102/SK9822) are immune. Unknown/absent => treat as
// dual-core (pre-multi-chip devices are all classic ESP32; don't warn spuriously).
export function isSingleCoreChip(chip?: string): boolean {
  return chip === 'esp32c3' || chip === 'esp32s2' || chip === 'esp32c2'
      || chip === 'esp32c6' || chip === 'esp32h2';
}

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
  // NOT wrapped in bleSerial: the read below already takes that lock inside the BLE
  // transport, and nesting the queue inside itself deadlocks — the inner op waits for a
  // chain the outer op is holding, until the 15s guard fires as "BLE op timed out".
  {
   try {
    console.log(`[LED Config] Reading config from ${deviceId}…`);

    // Read the LED config characteristic (returns binary MessagePack data)
    const rawDataView = await readCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LED_CONFIG_GET);

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
          clockPin: strip.clk ?? 0,
          numLeds,
          colorOrder: strip.co ?? ColorOrders.GRB,
          rmtChannel: strip.rmt ?? 0,
          width,
          height,
          orientation: strip.ort ?? 0,
          // Firmware stores gamma*100 as an int; default 1.0 (off) if absent.
          gamma: (strip.gm ?? 100) / 100,
          // White point packed as 0xRRGGBB; default 0xFFFFFF (neutral) if absent.
          whitePoint: '#' + ((strip.wp ?? 0xffffff) & 0xffffff).toString(16).padStart(6, '0'),
          // Temporal dithering opt-in; default on if absent.
          dither: strip.de ?? true,
          // Absent from older firmware; then left out of the save too (firmware keeps its default).
          ...(typeof strip.aw === 'number' ? { autoWhite: strip.aw } : {}),
          ...(typeof strip.wc === 'number' ? { whiteLedColor: strip.wc } : {}),
        };
      })
    };
    
    return config;
   } catch (error) {
    console.error(`[LED Config] ❌ ${deviceId}: read/decode failed:`, error);
    throw error;
   }
  }
}

// Encode an LED configuration into the exact MessagePack bytes the firmware's LED_CONFIG_SET
// expects. Shared by BLE (this file) and WiFi (wifiTransport) so BOTH transports send the
// identical payload — the firmware decodes it the same way regardless of how it arrived.
// The firmware expects integers for num/w/h; coerce defensively so a stray null can't
// serialize to nil and break the decode.
export function encodeLedConfig(config: LedConfiguration): Uint8Array {
  // A blank pin box binds to null, which encodes as nil; the firmware rejects the whole config
  // over it without replying, so the save would look successful and change nothing. Refuse it
  // here with a message the user can act on. (GPIO numbers run to 48 on the ESP32-S3.)
  const validPin = (p: unknown) => typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 48;
  config.strips.forEach((strip, i) => {
    const which = config.strips.length > 1 ? `Strip ${i + 1}: ` : '';
    if (!validPin(strip.pin)) throw new Error(`${which}enter a data pin (a GPIO number from 0 to 48).`);
    if (isFourWireChipset(strip.chipset) && !validPin(strip.clockPin)) {
      throw new Error(`${which}enter a clock pin (a GPIO number from 0 to 48).`);
    }
  });
  const esp32Config = {
    gb: config.globalBrightness,
    strips: config.strips.map(strip => ({
      cs: strip.chipset,
      pin: strip.pin,
      clk: strip.clockPin ?? 0,
      num: strip.numLeds ?? 0,
      co: strip.colorOrder,
      rmt: strip.rmtChannel,
      w: strip.width ?? 0,
      h: strip.height ?? 0,
      ort: strip.orientation,
      gm: Math.round((strip.gamma ?? 1.0) * 100),
      wp: strip.whitePoint ? (parseInt(strip.whitePoint.slice(1), 16) & 0xffffff) : 0xffffff,
      de: strip.dither ?? true,
      ...(strip.autoWhite !== undefined ? { aw: strip.autoWhite } : {}),
      ...(strip.whiteLedColor !== undefined ? { wc: strip.whiteLedColor } : {}),
    }))
  };
  return msgpackEncode(esp32Config) as Uint8Array;
}

export async function setLedConfiguration(deviceId: string, config: LedConfiguration): Promise<void> {
  try {
    console.log(`[LED Config] Setting configuration for ${deviceId}:`, config);
    const msgpackData = encodeLedConfig(config);
    const dataView = new DataView(msgpackData.buffer, msgpackData.byteOffset, msgpackData.byteLength);
    console.log(`[LED Config] Sending MessagePack data: ${msgpackData.byteLength} bytes`);
    await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LED_CONFIG_SET, dataView);
    console.log('[LED Config] Configuration sent successfully');
  } catch (error) {
    console.error('Error setting LED configuration:', error);
    throw error;
  }
}

/**
 * Upload an arbitrary pixel layout (WLED ledmap) for one strip, or clear it.
 * `map[cell]` = the physical LED index that lights grid cell `cell` (row-major over
 * width×height), or -1 for a gap. Pass an empty map (or width/height 0) to clear.
 * Wire format: [u8 stripIndex][u16 W][u16 H][u16 count][count × i16 ledIndex] (LE),
 * sent CHUNKED as [u16 totalLen][u16 offset][bytes] so large maps work (firmware feat>=2
 * reassembles up to a 16 KB / ~8000-cell buffer). Older firmware (no feat) only handles a
 * single ~250-cell write — callers gate on DeviceInfo.feat before sending a bigger map.
 */
export async function uploadStripLayout(
  deviceId: string,
  stripIndex: number,
  layout: { width: number; height: number; map: number[] } | null
): Promise<void> {
  const W = layout?.width ?? 0;
  const H = layout?.height ?? 0;
  const map = layout?.map ?? [];
  const clearing = !layout || W <= 0 || H <= 0 || map.length === 0;
  const count = clearing ? 0 : Math.min(map.length, W * H);
  const total = 1 + 6 + count * 2;
  if (total > 16384) {
    const maxCells = Math.floor((16384 - 7) / 2);
    throw new Error(
      `Layout is ${total} bytes (${count} cells), but this firmware accepts at most ` +
      `16,384 bytes (${maxCells} cells). Reduce the layout dimensions or gaps.`,
    );
  }

  // Logical payload the device reassembles: [u8 stripIndex][u16 W][u16 H][u16 count][count×i16].
  const payload = new Uint8Array(total);
  const dv = new DataView(payload.buffer);
  dv.setUint8(0, stripIndex & 0xff);
  dv.setUint16(1, clearing ? 0 : W, true);
  dv.setUint16(3, clearing ? 0 : H, true);
  dv.setUint16(5, count, true);
  for (let i = 0; i < count; i++) {
    const led = Number.isFinite(map[i]) ? Math.trunc(map[i]) : -1;
    dv.setInt16(7 + i * 2, led, true); // -1 = gap
  }

  // Chunk it: each frame is [u16 totalLen][u16 offset][bytes]. Writes are serialized via
  // bleSerial, so the device reassembles in order. Lifts the single-write size limit.
  // The transport owns its safe write size: BLE stays at the proven 180 B body, while Wi-Fi
  // uses an 8188 B body and turns a maximum layout from ~90 WebSocket messages into two.
  const CHUNK = getTransport(deviceId).maxWriteLen - 4;
  await serializeDeviceBulk(deviceId, async () => {
    let statusResolve: ((code: number) => void) | null = null;
    const statusPromise = new Promise<number>((resolve) => { statusResolve = resolve; });
    let statusNotifications = false;
    try {
      // New firmware acknowledges only after LittleFS commit + live apply. Older firmware did
      // not expose NOTIFY here; keep a timeout fallback so updating the app does not strand it.
      try {
        await startBinaryNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_SET, (reply) => {
          if (reply.byteLength >= 2 && reply.getUint8(1) === (stripIndex & 0xff)) {
            statusResolve?.(reply.getUint8(0));
            statusResolve = null;
          }
        });
        statusNotifications = true;
      } catch {
        // Legacy characteristic was write-only.
      }

      for (let off = 0; off < total; off += CHUNK) {
        const slice = payload.subarray(off, Math.min(off + CHUNK, total));
        const frame = new Uint8Array(4 + slice.length);
        const fdv = new DataView(frame.buffer);
        fdv.setUint16(0, total, true);
        fdv.setUint16(2, off, true);
        frame.set(slice, 4);
        await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_SET,
          new DataView(frame.buffer));
      }

      const status = statusNotifications
        ? await Promise.race<number | null>([
            statusPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ])
        : null;
      if (status != null && status !== 0) {
        const reason = ['ok', 'unsupported size', 'out of memory', 'out-of-order chunk', 'flash write failed'][status]
          ?? `device error ${status}`;
        throw new Error(`Layout rejected: ${reason}`);
      }
      if (status == null) {
        // Legacy fallback: its write resolves before the loop task commits the file.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (statusNotifications) {
        await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_SET).catch(() => {});
      }
    }
  });
  console.log(`[Layout] strip ${stripIndex}: ${clearing ? 'cleared' : `${W}x${H}, ${count} cells`} sent (${total}B)`);
}

/**
 * Start the auto-layout calibration flash on the device: each LED blinks its index as a
 * structured-light sequence the camera decodes. `stripIndex` 0xFF flashes all strips.
 */
export async function startCalibration(deviceId: string, stripIndex = 0xff, brightness = 40, mode: 'strobe' | 'full' | 'detect' = 'full'): Promise<void> {
  // brightness: per-channel white level (1..255) the strips flash at. Keep low — full brightness
  // saturates the camera and blooms LEDs into one blob; ~40 keeps them as distinct dots. 0 => firmware default.
  // mode: 'detect' = steady ALL-ON (tune exposure + detect blobs), 'strobe' = ALL on/off,
  //       'full' = structured-light (ON + bit planes).
  const m = mode === 'strobe' ? 0 : mode === 'detect' ? 2 : 1;
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_CALIBRATION,
    new DataView(new Uint8Array([1, stripIndex & 0xff, brightness & 0xff, m]).buffer));
}
export async function stopCalibration(deviceId: string): Promise<void> {
  await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_CALIBRATION,
    new DataView(new Uint8Array([0]).buffer));
}

/**
 * Read back a strip's current layout (so the user can see/copy/tweak it). Writes the strip
 * index to LAYOUT_GET; the device NOTIFYs the layout chunked ([u16 totalLen][u16 offset][bytes],
 * the bytes being the [u16 W][u16 H][u16 count][count×i16] file). Returns null if the strip
 * has no layout (grid mapping) or on timeout.
 */
export async function getStripLayout(
  deviceId: string,
  stripIndex: number
): Promise<{ width: number; height: number; map: number[] } | null> {
  let total = -1, received = 0;
  let buf: Uint8Array | null = null;
  const seenOffsets = new Set<number>(); // dedupe chunks + count real bytes (not max-offset)
  let settle: ((v: any) => void) | null = null;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return; cleanedUp = true;
    try {
      await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_GET).catch(() => {});
    } catch { /* ignore */ }
  };

  const onFrame = (dv: DataView) => {
    if (!settle || dv.byteLength < 4) return;
    const totalLen = dv.getUint16(0, true);
    const offset = dv.getUint16(2, true);
    if (totalLen === 0) { const s = settle; settle = null; s(null); return; } // no layout
    if (total < 0) { total = totalLen; buf = new Uint8Array(total); received = 0; }
    const dataLen = dv.byteLength - 4;
    for (let i = 0; i < dataLen && offset + i < total; i++) buf![offset + i] = dv.getUint8(4 + i);
    // Count REAL bytes received (dedup by offset), not the max offset seen. BLE notifications
    // can arrive out of order or drop; completing on max-offset would finish early with
    // zero-filled holes → cells read as LED 0 (lit) → a corrupt "reloaded" layout. This way
    // a missing chunk keeps us waiting (then times out to null) instead of showing garbage.
    if (!seenOffsets.has(offset)) { seenOffsets.add(offset); received += Math.min(dataLen, total - offset); }
    if (received >= total && buf) {
      const p = new DataView(buf.buffer);
      const W = p.getUint16(0, true), H = p.getUint16(2, true), count = p.getUint16(4, true);
      const map: number[] = [];
      for (let k = 0; k < count && 6 + k * 2 + 1 < buf.length; k++) map.push(p.getInt16(6 + k * 2, true));
      const s = settle; settle = null; s({ width: W, height: H, map });
    }
  };

  const result = await new Promise<any>(async (resolve, reject) => {
    settle = resolve;
    const timer = setTimeout(() => { if (settle) { const s = settle; settle = null; s(null); } }, 8000);
    const origSettle = settle;
    settle = (v: any) => { clearTimeout(timer); origSettle(v); };
    try {
      await startBinaryNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_GET, onFrame);
      // Request the strip's layout (1-byte write).
      await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LAYOUT_GET,
        new DataView(new Uint8Array([stripIndex & 0xff]).buffer));
    } catch (err) {
      if (settle) { const s = settle; settle = null; s(null); }
      console.error('[Layout] read-back failed:', err);
    }
  });
  await cleanup();
  return result;
}

/**
 * Pull the device's stored pattern library back to the app (for the "From Devices" view).
 * Writes to LIBRARY_DUMP; the device NOTIFYs each pattern's MessagePack framed
 * [u8 idx][u16 totalLen LE][u16 offset LE][bytes], then a done sentinel idx=0xFF. Returns the
 * decoded patterns. Mirrors getStripLayout's reassembly.
 */
export async function pullDeviceLibrary(deviceId: string): Promise<import('./patternSerializer').SerializedPattern[]> {
  // Track TRUE coverage per pattern (a set of chunk offsets + bytes actually filled), not just
  // a max-offset watermark: a dropped middle chunk would otherwise let `received` reach `total`
  // over a hole, and we'd decode a zero-filled buffer into a garbage pattern (renders wrong /
  // decode-fails). Only decode once every byte is present.
  const bufs = new Map<number, { total: number; buf: Uint8Array; covered: number; seen: Set<number>; done: boolean }>();
  const results: any[] = [];
  let settle: ((v: any) => void) | null = null;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return; cleanedUp = true;
    try {
      await stopNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LIBRARY_DUMP).catch(() => {});
    } catch { /* ignore */ }
  };

  const onFrame = (dv: DataView) => {
    if (!settle || dv.byteLength < 5) return;
    const idx = dv.getUint8(0);
    if (idx === 0xFF) { const s = settle; settle = null; s(results); return; } // done sentinel
    const totalLen = dv.getUint16(1, true);
    const offset = dv.getUint16(3, true);
    let e = bufs.get(idx);
    if (!e) { e = { total: totalLen, buf: new Uint8Array(totalLen), covered: 0, seen: new Set(), done: false }; bufs.set(idx, e); }
    const dataLen = dv.byteLength - 5;
    for (let i = 0; i < dataLen && offset + i < e.total; i++) e.buf[offset + i] = dv.getUint8(5 + i);
    if (!e.seen.has(offset)) { e.seen.add(offset); e.covered += Math.min(dataLen, e.total - offset); } // dedupe; count real bytes
    if (!e.done && e.covered >= e.total) {
      e.done = true;
      try { const p = msgpackDecode(e.buf) as any; if (p && Array.isArray(p.nodes)) results.push(p); }
      catch (err) { console.warn('[LibDump] decode failed for pattern', idx, err); }
    }
  };

  const result = await new Promise<any[]>(async (resolve) => {
    settle = resolve;
    const timer = setTimeout(() => { if (settle) { const s = settle; settle = null; s(results); } }, 15000);
    const orig = settle;
    settle = (v: any) => { clearTimeout(timer); orig(v); };
    try {
      await startBinaryNotifications(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LIBRARY_DUMP, onFrame);
      await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_LIBRARY_DUMP,
        new DataView(new Uint8Array([0]).buffer));
    } catch (err) {
      if (settle) { const s = settle; settle = null; s(results); }
      console.error('[LibDump] pull failed:', err);
    }
  });
  await cleanup();
  return result;
}

// Timestamp Sync Functions

/**
 * Sends current system timestamp to ESP32 for synchronization
 */
export async function sendTimestampSync(deviceId: string): Promise<void> {
  try {
    // Two clocks in one 16-byte message:
    //  bytes 0-7  = the frame clock: integer ms since page load (performance.now), the SAME
    //               clock the browser preview feeds its operators (see flowStore). Devices sync
    //               to THIS so preview and hardware render the same frame. Monotonic.
    //  bytes 8-15 = the WALL clock: Unix epoch ms (Date.now). Used for the Clock node + the
    //               on/off schedule. This is a real date — the frame clock is NOT, so they must
    //               travel separately. (Older firmware ignores bytes 8-15 and just frame-syncs.)
    const frameMs = Math.floor(performance.now());
    const epochMs = Date.now();
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    view.setUint32(0, frameMs >>> 0, true);
    view.setUint32(4, Math.floor(frameMs / 0x100000000), true);
    view.setUint32(8, epochMs >>> 0, true);
    view.setUint32(12, Math.floor(epochMs / 0x100000000), true);

    // Send binary data to timestamp sync characteristic
    await writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, CHARACTERISTIC_UUID_TIMESTAMP_SYNC, view);

    console.log(`[Timestamp Sync] Sent frame=${frameMs} epoch=${epochMs} to device ${deviceId}`);
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
        if (fails >= SYNC_FAILURE_LIMIT && bleConnections.has(deviceId)) {
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
