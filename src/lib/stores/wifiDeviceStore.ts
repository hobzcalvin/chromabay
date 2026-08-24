// Devices reachable over Wi-Fi.
//
// This store's only job is *finding* them: a browser cannot browse mDNS, so we keep a small
// remembered list of `<name>.local` hosts (populated when you switch a device to Wi-Fi, or
// when you add one by host) and resolve it through the OS.
//
// Connecting is deliberately NOT special. A connected Wi-Fi device is registered as a
// transport and put into the SAME `connectedDevices` store a Bluetooth device lands in, with
// the id `wifi:<host>`. From that moment the devices page, the settings panel, OTA, the LED
// editor and the crash relay all treat it as an ordinary device — there is no Wi-Fi branch
// anywhere above this file.
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { WifiTransport } from '$lib/wifiTransport';
import { registerTransport, unregisterTransport, wifiIdFor } from '$lib/transport';
import { addConnectedDevice, connectedDevices } from './deviceStore';
import { disconnectFromDevice, handleDeviceDisconnected } from '$lib/ble';

export type KnownWifi = { name: string; host: string };
const LS_KEY = 'chromabay.wifiDevices';

function load(): KnownWifi[] {
  if (!browser) return [];
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function persist(list: KnownWifi[]) { if (browser) try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* private mode */ } }

export const knownWifi = writable<KnownWifi[]>(load());

/** Per-host connect progress. The connected device itself lives in `connectedDevices`. */
export type WifiConnState = { state: 'idle' | 'connecting' | 'error'; error?: string };
export const wifiStatus = writable<Record<string, WifiConnState>>({});

// Mirror the firmware's mDNS hostname sanitization (lowercase, [a-z0-9-], collapse others).
// Keep this in step with the sanitizer in esp32/src/main.cpp's WifiLink::begin().
export function hostForName(name: string): string {
  let h = '';
  for (const c of name.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) h += c;
    else if ((c === ' ' || c === '_' || c === '-') && h && h.slice(-1) !== '-') h += '-';
  }
  h = h.replace(/-+$/, '');
  return (h || 'chromabay') + '.local';
}

export function rememberWifiDevice(name: string, host?: string) {
  const h = host || hostForName(name);
  knownWifi.update((l) => {
    if (l.some((d) => d.name === name)) return l;
    const n = [...l, { name, host: h }]; persist(n); return n;
  });
}

export function forgetWifiDevice(name: string) {
  const entry = get(knownWifi).find((d) => d.name === name);
  if (entry) void disconnectWifi(entry.host);
  knownWifi.update((l) => { const n = l.filter((d) => d.name !== name); persist(n); return n; });
}

const setStatus = (host: string, s: WifiConnState) => wifiStatus.update((m) => ({ ...m, [host]: s }));

/**
 * Connect, then hand the device to the shared store. `name` is only a display label; the id
 * is derived from the host so it is stable across renames.
 */
export async function connectWifi(name: string, host: string): Promise<void> {
  const id = wifiIdFor(host);
  if (get(connectedDevices).has(id)) return;
  setStatus(host, { state: 'connecting' });
  const transport = new WifiTransport(host);
  try {
    await transport.connect();
    // Wire the close handler only after a successful connect: during a FAILED connect the
    // socket's close event fires after we have already recorded the error, and would
    // otherwise clobber it back to idle, leaving the user with no feedback.
    // The same cleanup a dropped BLE link runs: clears the store and stops the per-device
    // timers (timestamp sync would otherwise keep writing into a dead socket).
    transport.onClose = () => {
      unregisterTransport(id);
      handleDeviceDisconnected(id);
      setStatus(host, { state: 'idle' });
    };
    registerTransport(transport);
    // Exactly what the BLE connect path does. Everything downstream keys off this.
    addConnectedDevice({ deviceId: id, name, services: [], lastConnected: Date.now() });
    setStatus(host, { state: 'idle' });
  } catch (e: any) {
    await transport.disconnect();
    unregisterTransport(id);
    setStatus(host, { state: 'error', error: e?.message ?? String(e) });
    throw e;
  }
}

export async function disconnectWifi(host: string) {
  // Goes through the shared disconnect so the socket is actually closed and the store,
  // timers and transport registry are cleaned up in one place.
  await disconnectFromDevice(wifiIdFor(host)).catch(() => { /* already gone */ });
  setStatus(host, { state: 'idle' });
}
