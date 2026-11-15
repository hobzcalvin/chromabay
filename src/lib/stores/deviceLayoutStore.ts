// What each device physically looks like — its strips' shapes — remembered across sessions so
// Interact can preview a pattern the way a device shows it, even after it disconnects.
//
// A device's strips each render the pattern on their own canvas (firmware
// PatternRendererBase::render): a linear strip at numLeds×1, a matrix at W×H, a custom layout
// (WLED ledmap) at the layout's W×H with only its mapped cells lit. A StripShape carries just
// enough to draw that: the size, which cells hold an LED, and the wiring for matrices whose LED
// count doesn't fill the grid.
import { writable, get } from 'svelte/store';
import type { LedStripConfig } from '$lib/ble';
import { connectedDevices } from '$lib/stores/deviceStore';

export type StripKind = 'strip' | 'matrix' | 'custom';

export interface StripShape {
  kind: StripKind;   // 'custom' when `layout` is set
  width: number;     // the config's grid (numLeds×1 for a strip)
  height: number;
  numLeds: number;
  orientation: number;
  layout?: { width: number; height: number; map: number[] }; // custom layout: LED per cell, -1 = gap
}

/** The canvas a strip renders the pattern at (firmware LedBus::effectiveWidth/Height). */
export function shapeSize(s: StripShape): { width: number; height: number } {
  return s.layout ? { width: s.layout.width, height: s.layout.height } : { width: s.width, height: s.height };
}

export interface DeviceLayoutRecord {
  deviceId: string;
  name: string;
  lastConnected: number;
  strips: StripShape[];
}

const STORAGE_KEY = 'chromabay.deviceLayouts.v1';
const MAX_RECORDS = 12;

function load(): DeviceLayoutRecord[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && r.deviceId && Array.isArray(r.strips)) : [];
  } catch { return []; }
}

function save(list: DeviceLayoutRecord[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* quota / private mode */ }
}

/** Known devices, most recently connected first. */
export const deviceLayouts = writable<DeviceLayoutRecord[]>(load());

function commit(mutate: (list: DeviceLayoutRecord[]) => DeviceLayoutRecord[]) {
  deviceLayouts.update((list) => {
    const next = mutate(list.map((r) => ({ ...r, strips: r.strips.map((s) => ({ ...s })) })))
      .sort((a, b) => b.lastConnected - a.lastConnected)
      .slice(0, MAX_RECORDS);
    save(next);
    return next;
  });
}

function upsert(list: DeviceLayoutRecord[], deviceId: string, name?: string): DeviceLayoutRecord {
  let rec = list.find((r) => r.deviceId === deviceId);
  if (!rec) {
    rec = { deviceId, name: name || 'Device', lastConnected: Date.now(), strips: [] };
    list.push(rec);
  }
  if (name) rec.name = name;
  const live = get(connectedDevices).get(deviceId);
  if (live) rec.lastConnected = Math.max(rec.lastConnected, live.lastConnected || 0);
  return rec;
}

/** Shape of a strip from its config (no custom layout). */
export function shapeFromConfig(s: LedStripConfig): StripShape {
  const numLeds = Math.max(0, s.numLeds ?? 0);
  const width = s.width && s.width >= 1 ? s.width : numLeds;
  const height = s.height && s.height >= 1 ? s.height : 1;
  return { kind: height === 1 || width === 1 ? 'strip' : 'matrix', width, height, numLeds, orientation: s.orientation ?? 0 };
}

/** The LED index shown in each cell (row-major over shapeSize; -1 = no LED) — a ledmap, for
 *  previewing any strip the way a custom layout is previewed. */
export function cellMap(s: StripShape): number[] {
  if (s.layout) return s.layout.map.slice(0, s.layout.width * s.layout.height);
  const map: number[] = [];
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
    const i = xyToIndex(x, y, s.width, s.height, s.orientation, s.numLeds);
    map.push(i < s.numLeds ? i : -1);
  }
  return map;
}

// A strip (one LED wide) can run four ways; the firmware sees it as a 1-row or 1-column grid.
//   0° → left to right (N×1) · 90° → top to bottom (1×N) · 180° → right to left · 270° → bottom to top
export function stripRotation(s: { width: number | null; height: number | null; orientation: number }): number {
  const vertical = s.width === 1 && (s.height ?? 0) > 1;
  const reversed = (s.orientation & 0x03) === 2 || (!vertical && (s.orientation & 0x04) !== 0);
  return (vertical ? 1 : 0) + (reversed ? 2 : 0);
}
export function applyStripRotation(s: { numLeds: number | null; width: number | null; height: number | null; orientation: number }, rotation: number) {
  const n = s.numLeds;
  const vertical = rotation % 2 === 1;
  if (n) { s.width = vertical ? 1 : n; s.height = vertical ? n : 1; }
  s.orientation = rotation >= 2 ? 2 : 0; // the firmware's 180° turn reverses a row or a column
}

/** Record a device's LED config. Custom layouts already known for a strip are kept (a config
 *  read doesn't carry them); recordStripLayout updates those. */
export function recordDeviceConfig(deviceId: string, name: string | undefined, strips: LedStripConfig[]) {
  commit((list) => {
    const rec = upsert(list, deviceId, name);
    rec.strips = strips.map((s, i) => {
      const shape = shapeFromConfig(s);
      const prev = rec.strips[i];
      return prev?.layout ? { ...shape, kind: 'custom', layout: prev.layout } : shape;
    });
    return list;
  });
}

/** Record (or clear, with null) a strip's custom layout. */
export function recordStripLayout(deviceId: string, index: number, layout: { width: number; height: number; map: number[] } | null) {
  commit((list) => {
    const rec = list.find((r) => r.deviceId === deviceId);
    const s = rec?.strips[index];
    if (!rec || !s) return list;
    if (layout && layout.map.length && layout.width && layout.height) {
      rec.strips[index] = { ...s, kind: 'custom', layout: { width: layout.width, height: layout.height, map: layout.map } };
    } else if (s.layout) {
      const { layout: _drop, ...rest } = s; // back to the config's grid
      rec.strips[index] = { ...rest, kind: rest.height === 1 || rest.width === 1 ? 'strip' : 'matrix' };
    }
    return list;
  });
}

// Devices read in full (config + layouts) this session, so Interact only asks each once.
const synced = new Set<string>();
const syncing = new Map<string, Promise<void>>();

/** Read a connected device's config and custom layouts into the record (once per session). */
export function syncDeviceLayout(deviceId: string): Promise<void> {
  if (synced.has(deviceId)) return Promise.resolve();
  const pending = syncing.get(deviceId);
  if (pending) return pending;
  const p = (async () => {
    const { getLedConfiguration, getStripLayout } = await import('$lib/ble');
    const name = get(connectedDevices).get(deviceId)?.name;
    const cfg = await getLedConfiguration(deviceId);
    recordDeviceConfig(deviceId, name, cfg.strips);
    // A layout that couldn't be read keeps what we already knew (a failed read is not "no
    // layout"); the device then isn't marked synced, so the next visit tries again.
    let allRead = true;
    for (let i = 0; i < cfg.strips.length; i++) {
      try { recordStripLayout(deviceId, i, await getStripLayout(deviceId, i)); }
      catch (e) { allRead = false; console.warn('[deviceLayouts] layout read failed', deviceId, i, e); }
    }
    if (allRead) synced.add(deviceId);
  })().catch((e) => console.warn('[deviceLayouts] sync failed for', deviceId, e))
    .finally(() => syncing.delete(deviceId));
  syncing.set(deviceId, p);
  return p;
}

/** Mark a device's layouts as already read this session (the settings UI just read them). */
export function markDeviceLayoutSynced(deviceId: string) { synced.add(deviceId); }

// A (re)connect makes a known device the most recent one.
if (typeof window !== 'undefined') {
  let seen = new Set<string>();
  connectedDevices.subscribe((devices) => {
    const fresh = [...devices.keys()].filter((id) => !seen.has(id));
    seen = new Set(devices.keys());
    for (const id of [...synced]) if (!devices.has(id)) synced.delete(id); // reread after reconnect
    if (!fresh.length) return;
    const known = get(deviceLayouts);
    if (!fresh.some((id) => known.some((r) => r.deviceId === id))) return;
    commit((list) => {
      for (const id of fresh) {
        const rec = list.find((r) => r.deviceId === id);
        const d = devices.get(id);
        if (rec && d) { rec.lastConnected = Math.max(Date.now(), d.lastConnected || 0); if (d.name) rec.name = d.name; }
      }
      return list;
    });
  });
}

// --- Which cells of a strip hold an LED -------------------------------------------------

// Port of the firmware's LedConfig::xyToIndex (led_manager.h) — needed to tell which cells of a
// matrix whose LED count doesn't fill the grid actually have an LED.
export function xyToIndex(x: number, y: number, width: number, height: number, orientation: number, numLeds: number): number {
  if (x >= width || y >= height) return numLeds;
  let rx = x, ry = y;
  const rot = orientation & 0x03;
  if (rot === 1) { rx = y; ry = width - 1 - x; }
  else if (rot === 2) { rx = width - 1 - x; ry = height - 1 - y; }
  else if (rot === 3) { rx = height - 1 - y; ry = x; }
  const rowLen = rot === 1 || rot === 3 ? height : width;
  if (orientation & 0x04) rx = rowLen - 1 - rx;
  const index = (orientation & 0x08) && ry % 2 === 1 ? ry * rowLen + (rowLen - 1 - rx) : ry * rowLen + rx;
  return index < numLeds ? index : numLeds;
}

/** For each cell of shapeSize(s) (row-major): does an LED show it? */
export function litCells(s: StripShape): Uint8Array {
  if (s.layout) {
    const { width, height, map } = s.layout;
    const lit = new Uint8Array(width * height);
    for (let c = 0; c < lit.length; c++) lit[c] = (map[c] ?? -1) >= 0 ? 1 : 0;
    return lit;
  }
  const n = s.width * s.height;
  const lit = new Uint8Array(n);
  if (s.height === 1 || s.width === 1) {
    for (let c = 0; c < n; c++) lit[c] = c < s.numLeds ? 1 : 0;
  } else {
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      lit[y * s.width + x] = xyToIndex(x, y, s.width, s.height, s.orientation, s.numLeds) < s.numLeds ? 1 : 0;
    }
  }
  return lit;
}
