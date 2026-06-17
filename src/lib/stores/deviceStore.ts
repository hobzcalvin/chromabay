import { writable } from 'svelte/store';

export interface ConnectedDevice {
  deviceId: string;
  name: string;
  webDevice?: any; // For web bluetooth
  services: any[];
  deviceInfo?: {
    fw_ver: string;
    hw_ver: string;
    heap?: number;
  };
  lastConnected: number;
}

export const connectedDevices = writable<Map<string, ConnectedDevice>>(new Map());
export const activeDeviceId = writable<string | null>(null);

// Helper functions
export function addConnectedDevice(device: ConnectedDevice) {
  // Return a NEW Map each time. Mutating + returning the same reference can be
  // missed by derived reactivity ($: list = getList($store)) and keyed {#each}
  // blocks, leaving the UI stale until the component remounts.
  connectedDevices.update(devices => {
    const next = new Map(devices);
    next.set(device.deviceId, device);
    return next;
  });
}

export function removeConnectedDevice(deviceId: string) {
  connectedDevices.update(devices => {
    const next = new Map(devices);
    next.delete(deviceId);
    return next;
  });
  
  // Clear active device if this device was active
  activeDeviceId.update(current => {
    if (current === deviceId) {
      return null;
    }
    return current;
  });
}

export function updateDeviceInfo(deviceId: string, info: any) {
  connectedDevices.update(devices => {
    const device = devices.get(deviceId);
    if (!device) return devices;
    const next = new Map(devices);
    next.set(deviceId, { ...device, deviceInfo: info });
    return next;
  });
}

export function setActiveDevice(deviceId: string | null) {
  activeDeviceId.set(deviceId);
}

export function getActiveDevice(devices: Map<string, ConnectedDevice>, activeId: string | null): ConnectedDevice | null {
  if (!activeId) return null;
  return devices.get(activeId) || null;
}

export function getConnectedDevicesList(devices: Map<string, ConnectedDevice>): ConnectedDevice[] {
  return Array.from(devices.values()).sort((a, b) => b.lastConnected - a.lastConnected);
} 