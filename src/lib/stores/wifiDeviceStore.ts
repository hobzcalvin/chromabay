// Known WiFi devices (persisted) + their live WebSocket connections. The browser can't
// browse mDNS, so we connect to devices we KNOW by name via <name>.local — populated when the
// user switches a device to WiFi (or adds one by host). The OS resolves .local via Bonjour.
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { WifiDevice } from '$lib/wifiTransport';
import type { DeviceInfo } from '$lib/ble';

export type KnownWifi = { name: string; host: string };
const LS_KEY = 'chromabay.wifiDevices';

function load(): KnownWifi[] {
  if (!browser) return [];
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function persist(list: KnownWifi[]) { if (browser) try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {} }

export const knownWifi = writable<KnownWifi[]>(load());

export type WifiConn = {
  name: string; host: string; dev: WifiDevice | null;
  state: 'idle' | 'connecting' | 'ready' | 'error'; info?: DeviceInfo; error?: string;
};
export const wifiConns = writable<Record<string, WifiConn>>({});

// Mirror the firmware's mDNS hostname sanitization (lowercase, [a-z0-9-], collapse others).
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
  disconnectWifi(name);
  knownWifi.update((l) => { const n = l.filter((d) => d.name !== name); persist(n); return n; });
}

export async function connectWifi(name: string, host: string) {
  wifiConns.update((m) => ({ ...m, [name]: { name, host, dev: null, state: 'connecting' } }));
  const dev = new WifiDevice(host);
  dev.onClose = () => wifiConns.update((m) => (m[name] ? { ...m, [name]: { ...m[name], state: 'idle', dev: null } } : m));
  try {
    await dev.connect();
    const info = await dev.getDeviceInfo();
    dev.syncTime(); // give the device our clock (for cycle timing / the Clock node)
    wifiConns.update((m) => ({ ...m, [name]: { name, host, dev, state: 'ready', info } }));
  } catch (e: any) {
    dev.disconnect();
    wifiConns.update((m) => ({ ...m, [name]: { name, host, dev: null, state: 'error', error: e?.message ?? String(e) } }));
  }
}
export function disconnectWifi(name: string) {
  get(wifiConns)[name]?.dev?.disconnect();
  wifiConns.update((m) => (m[name] ? { ...m, [name]: { ...m[name], state: 'idle', dev: null } } : m));
}
