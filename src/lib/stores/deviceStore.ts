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
  connectedDevices.update(devices => {
    devices.set(device.deviceId, device);
    return devices;
  });
}

export function removeConnectedDevice(deviceId: string) {
  connectedDevices.update(devices => {
    devices.delete(deviceId);
    return devices;
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
    if (device) {
      device.deviceInfo = info;
      devices.set(deviceId, device);
    }
    return devices;
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