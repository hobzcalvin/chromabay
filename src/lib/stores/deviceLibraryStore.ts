// What patterns each connected device holds in its on-device library, pulled via LIBRARY_DUMP
// (see pullDeviceLibrary). Best-effort + resilient to reconnects:
//  - retries an empty pull (right after a (re)connect the link isn't ready and the dump comes
//    back empty — that's NOT the same as an empty device);
//  - keeps the last-known snapshot across a disconnect blip, so counts don't collapse to
//    "0 synced / No stored patterns" when a device drops and comes back;
//  - counts only CONNECTED devices (stale snapshots for disconnected ones are ignored).
import { writable, get } from 'svelte/store';
import { pullDeviceLibrary } from '$lib/ble';
import { connectedDevices, getConnectedDevicesList } from './deviceStore';
import type { SerializedPattern } from '$lib/patternSerializer';

// deviceId -> the patterns stored on that device (may include stale entries for devices that
// have since disconnected; consumers scope to the connected set — see syncedCountFor).
export const deviceLibraries = writable<Record<string, SerializedPattern[]>>({});
export const deviceLibrariesLoading = writable(false);

let inFlight = false;

// A brief reconnect blip can't have changed a device's library, but a LONGER absence might
// (someone re-synced it, it was cleared, etc.). Track when each device dropped so refresh
// re-dumps only after it's been gone longer than this; a quick blip keeps the cache.
const STALE_RECONNECT_MS = 30_000;
const disconnectedAt: Record<string, number> = {};
let prevConnected = new Set<string>();
connectedDevices.subscribe((map) => {
  const cur = new Set(map.keys());
  const now = Date.now();
  for (const id of prevConnected) if (!cur.has(id)) disconnectedAt[id] = now; // just dropped
  prevConnected = cur;
});

async function pullWithRetry(deviceId: string, fallback: SerializedPattern[]): Promise<SerializedPattern[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pulled = await pullDeviceLibrary(deviceId);
      if (pulled.length > 0) return pulled; // got real data
      // Empty: usually a not-ready-yet race just after (re)connect. Wait and retry.
    } catch (e) {
      console.warn('[deviceLibrary] pull attempt failed for', deviceId, e);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
  }
  // Still empty after retries → keep the last-known snapshot rather than wiping good counts
  // on a transient failure. (A genuinely-empty device just has no fallback, so shows empty.)
  return fallback.length ? fallback : [];
}

/**
 * Refresh connected devices' libraries. A device's on-board library doesn't change while
 * we're merely disconnected, so by default we DON'T re-dump a device we already have a
 * snapshot for — a few-second reconnect blip keeps the cached list (no wasteful re-dump).
 * We only pull devices we've never seen. Pass { force: true } to re-dump everything (after
 * we changed a device's library via sync/remove, or an explicit user refresh).
 */
export async function refreshDeviceLibraries(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  deviceLibrariesLoading.set(true);
  try {
    const list = getConnectedDevicesList(get(connectedDevices));
    const prev = get(deviceLibraries);
    const next: Record<string, SerializedPattern[]> = { ...prev }; // keep snapshots across blips
    for (const d of list) {
      const have = prev[d.deviceId];
      const away = disconnectedAt[d.deviceId];
      const staleReconnect = away != null && Date.now() - away > STALE_RECONNECT_MS;
      delete disconnectedAt[d.deviceId]; // consume — it's connected now
      // Keep the cache for a device we already know, UNLESS forced or it was gone long enough
      // that its library might have changed.
      if (!opts.force && have && have.length > 0 && !staleReconnect) continue;
      next[d.deviceId] = await pullWithRetry(d.deviceId, have ?? []);
    }
    deviceLibraries.set(next);
  } finally {
    inFlight = false;
    deviceLibrariesLoading.set(false);
  }
}

/** How many of the given (connected) devices hold a pattern with this name. */
// Optimistically record that `pattern` was just pushed into these devices' libraries, so the
// "N synced" counts update INSTANTLY without a full LIBRARY_DUMP re-pull (which is slow and
// made the sync button feel unresponsive). Only call for devices whose push actually
// succeeded. Adds by name if not already present; a real re-dump later reconciles.
export function markSyncedLocally(deviceIds: Iterable<string>, pattern: SerializedPattern): void {
  const name = pattern.meta?.name;
  if (!name) return;
  deviceLibraries.update((libs) => {
    const next = { ...libs };
    for (const id of deviceIds) {
      const lib = next[id] ?? [];
      if (!lib.some((p) => p.meta?.name === name)) next[id] = [...lib, pattern];
    }
    return next;
  });
}

// Optimistically drop a pattern (by name) from every device's cached library — mirror of the
// above for deletes, so counts fall to 0 immediately.
export function markUnsyncedLocally(name: string): void {
  deviceLibraries.update((libs) => {
    const next: Record<string, SerializedPattern[]> = {};
    for (const [id, lib] of Object.entries(libs)) next[id] = lib.filter((p) => p.meta?.name !== name);
    return next;
  });
}

export function syncedCountFor(
  libs: Record<string, SerializedPattern[]>,
  name: string,
  connectedIds: Iterable<string>,
): number {
  let n = 0;
  for (const id of connectedIds) {
    if ((libs[id] ?? []).some((p) => p.meta?.name === name)) n++;
  }
  return n;
}
