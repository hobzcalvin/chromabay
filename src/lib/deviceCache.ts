// What we last read from each device — its LED config, custom layouts and pattern library —
// kept across sessions and tagged with the device's content generations (firmware feat >= 9
// reports "gcfg"/"glay"/"glib" in device info, bumped whenever that content changes). On a
// reconnect, device info (~300 B) says whether anything changed; if not, the copy here is
// used and the config, every strip's layout and the whole library aren't read again — over
// BLE that's many KB and several seconds, and it all used to compete at connect.
//
// Keyed by the device's own id (eFuse MAC, "id" in device info) plus its firmware version: a
// BLE deviceId is per-browser and a Wi-Fi id is per-address, and a new firmware may describe
// the same content differently.
//
// No BLE imports here: ble.ts calls invalidate() whenever the app itself writes config,
// layouts or library, so a write can never leave a stale copy behind even before the device
// reports its new generation.
import type { DeviceInfo, LedConfiguration } from './ble';
import type { SerializedPattern } from './patternSerializer';

export type StripLayout = { width: number; height: number; map: number[] } | null;
export type CacheKind = 'cfg' | 'lay' | 'lib';

interface Slot<T> { gen: number; value: T }
interface Entry {
  id: string;
  fw: string;
  at: number; // last used, for eviction
  cfg?: Slot<LedConfiguration>;
  lay?: Slot<StripLayout[]>;
  lib?: Slot<SerializedPattern[]>;
}

const PREFIX = 'chromabay.deviceCache.v1.';
const MAX_DEVICES = 12;

// This session's deviceId (BLE id / wifi:host) → the device's info, so callers can work in
// deviceIds while entries are keyed by the device's own id.
const infoFor = new Map<string, DeviceInfo>();

const genOf = (info: DeviceInfo | undefined, kind: CacheKind): number | undefined => {
  const g = kind === 'cfg' ? info?.gcfg : kind === 'lay' ? info?.glay : info?.glib;
  return typeof g === 'number' ? g : undefined;
};

/** True when this device reports content generations (and can be cached at all). */
export function supportsCache(info: DeviceInfo | undefined): boolean {
  return !!info?.id && !!info.fw_ver && genOf(info, 'cfg') !== undefined;
}

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function read(id: string): Entry | null {
  try {
    const raw = storage()?.getItem(PREFIX + id);
    const e = raw ? JSON.parse(raw) : null;
    return e && e.id === id ? e : null;
  } catch { return null; }
}

function allIds(): string[] {
  const s = storage();
  if (!s) return [];
  const ids: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(PREFIX)) ids.push(k.slice(PREFIX.length));
  }
  return ids;
}

function evictOldest(except: string): boolean {
  const entries = allIds().filter((id) => id !== except).map((id) => ({ id, at: read(id)?.at ?? 0 }));
  if (!entries.length) return false;
  entries.sort((a, b) => a.at - b.at);
  storage()?.removeItem(PREFIX + entries[0].id);
  return true;
}

function write(e: Entry) {
  const s = storage();
  if (!s) return;
  e.at = Date.now();
  const text = JSON.stringify(e);
  // A library can be large: on a full quota, make room by dropping the least recently used
  // devices, and as a last resort keep this device without its library.
  for (let attempt = 0; attempt < MAX_DEVICES + 1; attempt++) {
    try { s.setItem(PREFIX + e.id, attempt === MAX_DEVICES && e.lib ? JSON.stringify({ ...e, lib: undefined }) : text); break; }
    catch { if (!evictOldest(e.id)) { try { s.setItem(PREFIX + e.id, JSON.stringify({ ...e, lib: undefined })); } catch { /* give up */ } break; } }
  }
  const ids = allIds();
  if (ids.length > MAX_DEVICES) {
    for (let i = ids.length - MAX_DEVICES; i > 0; i--) evictOldest(e.id);
  }
}

/** Record a device's freshly read info for this session (call on every device-info read). */
export function noteDeviceInfo(deviceId: string, info: DeviceInfo) {
  infoFor.set(deviceId, info);
}

export function forgetSession(deviceId: string) {
  infoFor.delete(deviceId);
}

/** The cached value of `kind` when it is still current for this device, else undefined. */
export function cached(deviceId: string, kind: 'cfg'): LedConfiguration | undefined;
export function cached(deviceId: string, kind: 'lay'): StripLayout[] | undefined;
export function cached(deviceId: string, kind: 'lib'): SerializedPattern[] | undefined;
export function cached(deviceId: string, kind: CacheKind): unknown {
  const info = infoFor.get(deviceId);
  if (!supportsCache(info)) return undefined;
  const e = read(info!.id!);
  const slot = e && e.fw === info!.fw_ver ? e[kind] : undefined;
  return slot && slot.gen === genOf(info, kind) ? slot.value : undefined;
}

/**
 * Store what was just read. `gen` must be the generation from the device info read BEFORE the
 * content was read: if the content changed in between, the copy is filed under the older
 * number and the next connect reads it again rather than trusting it.
 */
export function store(deviceId: string, kind: 'cfg', gen: number | undefined, value: LedConfiguration): void;
export function store(deviceId: string, kind: 'lay', gen: number | undefined, value: StripLayout[]): void;
export function store(deviceId: string, kind: 'lib', gen: number | undefined, value: SerializedPattern[]): void;
export function store(deviceId: string, kind: CacheKind, gen: number | undefined, value: any): void {
  const info = infoFor.get(deviceId);
  if (gen === undefined || !supportsCache(info)) return;
  const id = info!.id!;
  const prev = read(id);
  const e: Entry = prev && prev.fw === info!.fw_ver ? prev : { id, fw: info!.fw_ver, at: 0 };
  (e as any)[kind] = { gen, value };
  write(e);
}

/** The generation of `kind` this session's device info reported (to pass to store()). */
export function currentGen(deviceId: string, kind: CacheKind): number | undefined {
  return genOf(infoFor.get(deviceId), kind);
}

const listeners = new Set<(deviceId: string, kind: CacheKind) => void>();
export function onInvalidate(fn: (deviceId: string, kind: CacheKind) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The app just changed `kind` on this device: forget the stored copy. */
export function invalidate(deviceId: string, kind: CacheKind) {
  const info = infoFor.get(deviceId);
  if (info?.id) {
    const e = read(info.id);
    if (e?.[kind]) { delete e[kind]; write(e); }
  }
  for (const fn of listeners) { try { fn(deviceId, kind); } catch { /* listener bug */ } }
}

/** For tests. */
export function _resetDeviceCache() {
  infoFor.clear();
  for (const id of allIds()) storage()?.removeItem(PREFIX + id);
}
