// What patterns each connected device currently holds in its on-device library, pulled via
// LIBRARY_DUMP (see pullDeviceLibrary). Best-effort + cached: a failed/empty pull just leaves
// the last known value, so the UI (N-Synced counts, "New From Devices") degrades gracefully
// rather than blocking. Refreshed on demand — on the Patterns page mount and after a
// push/delete that changes what's on a device.
import { writable, get } from 'svelte/store';
import { pullDeviceLibrary } from '$lib/ble';
import { connectedDevices, getConnectedDevicesList } from './deviceStore';
import type { SerializedPattern } from '$lib/patternSerializer';

// deviceId -> the patterns stored on that device.
export const deviceLibraries = writable<Record<string, SerializedPattern[]>>({});
export const deviceLibrariesLoading = writable(false);

let inFlight = false;

/** Pull every connected device's library into the store. Concurrency-guarded + best-effort. */
export async function refreshDeviceLibraries(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  deviceLibrariesLoading.set(true);
  try {
    const list = getConnectedDevicesList(get(connectedDevices));
    const prev = get(deviceLibraries);
    const next: Record<string, SerializedPattern[]> = {};
    for (const d of list) {
      try {
        next[d.deviceId] = await pullDeviceLibrary(d.deviceId);
      } catch (e) {
        console.warn('[deviceLibrary] pull failed for', d.deviceId, e);
        next[d.deviceId] = prev[d.deviceId] ?? []; // keep last known
      }
    }
    deviceLibraries.set(next); // drops entries for now-disconnected devices
  } finally {
    inFlight = false;
    deviceLibrariesLoading.set(false);
  }
}

/** How many connected devices hold a pattern with this name (device libraries key by name). */
export function syncedCountFor(libs: Record<string, SerializedPattern[]>, name: string): number {
  let n = 0;
  for (const pats of Object.values(libs)) {
    if (pats.some((p) => p.meta?.name === name)) n++;
  }
  return n;
}
