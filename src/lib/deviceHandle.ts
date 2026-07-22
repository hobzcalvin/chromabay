// A transport-agnostic handle to a connected device. The whole point: UI components take a
// DeviceHandle and never care whether the device is reached over Bluetooth or Wi-Fi — the
// SAME operations (and, underneath, the same command bytes) go out either link. BLE ops
// delegate to the deviceId-based functions in ble.ts; Wi-Fi ops delegate to a WifiDevice
// (WebSocket channels that mirror the BLE characteristics 1:1).
//
// This is grown incrementally: as each UI surface is migrated onto the handle, its ops are
// added here. Ops not yet wired over Wi-Fi throw a clear "not yet over Wi-Fi" error rather
// than silently no-op, so gaps are obvious.
import * as ble from './ble';
import type { DeviceInfo, DeviceSettings, DeviceSettingsPatch, LedConfiguration } from './ble';
import type { WifiDevice } from './wifiTransport';

export interface DeviceHandle {
  readonly id: string;                 // stable id: BLE deviceId, or "wifi:<name>"
  readonly transport: 'ble' | 'wifi';
  getDeviceInfo(): Promise<DeviceInfo>;
  readSettings(): Promise<DeviceSettings | null>;
  writeSettings(patch: DeviceSettingsPatch): Promise<void>;
  getLedConfig(): Promise<LedConfiguration>;
  setLedConfig(config: LedConfiguration): Promise<void>;
}

const notYet = (op: string): never => { throw new Error(`${op} is not available over Wi-Fi yet`); };

// Cache handles by their underlying key so a component re-render passes the SAME object
// (stable identity → effects keyed on the handle don't thrash).
const bleCache = new Map<string, DeviceHandle>();
const wifiCache = new WeakMap<object, DeviceHandle>();

export function bleHandle(deviceId: string): DeviceHandle {
  let h = bleCache.get(deviceId);
  if (!h) {
    h = {
      id: deviceId,
      transport: 'ble',
      getDeviceInfo: () => ble.getDeviceInfo(deviceId),
      readSettings: () => ble.readDeviceSettings(deviceId),
      writeSettings: (p) => ble.writeDeviceSettings(deviceId, p),
      getLedConfig: () => ble.getLedConfiguration(deviceId),
      setLedConfig: (c) => ble.setLedConfiguration(deviceId, c),
    };
    bleCache.set(deviceId, h);
  }
  return h;
}

export function wifiHandle(dev: WifiDevice, name: string): DeviceHandle {
  let h = wifiCache.get(dev);
  if (!h) {
    h = {
      id: `wifi:${name}`,
      transport: 'wifi',
      getDeviceInfo: () => dev.getDeviceInfo(),
      readSettings: () => dev.readSettings(),
      writeSettings: async (p) => dev.writeSettings(p),
      getLedConfig: () => dev.getLedConfig(),
      setLedConfig: async (c) => dev.setLedConfig(c),
    };
    wifiCache.set(dev, h);
  }
  return h;
}
