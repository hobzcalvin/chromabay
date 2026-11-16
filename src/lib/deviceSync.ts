// The one place that reads a connected device's state. Pages ask for it here instead of each
// firing their own reads at connect: the Devices page, the settings panel, Interact and
// Patterns used to read device info, the LED config, every strip's layout and the whole
// library independently — some of it twice — and the big transfers ran at the same time,
// competing for the link until notifications were dropped and reads failed.
//
// Per device, in order and one at a time:
//   core     device info + LED config        (what every page needs first)
//   layouts  each strip's custom layout      (Interact, the settings panel)
//   library  every stored pattern            (Patterns, on demand)
// Each is read at most once per connection (memoized until the device disconnects or the app
// changes it), and — on firmware that reports content generations (feat >= 9) — not at all
// when the copy in deviceCache.ts is still current. Device info is always read: it is the
// tiny message that says whether anything else changed.
import {
  getDeviceInfo, getLedConfiguration, getStripLayout, pullDeviceLibrary,
  type DeviceInfo, type LedConfiguration,
} from './ble';
import { cached, store, currentGen, onInvalidate, forgetSession, type StripLayout } from './deviceCache';
import { connectedDevices } from './stores/deviceStore';
import { recordDeviceConfig, recordStripLayout } from './stores/deviceLayoutStore';
import type { SerializedPattern } from './patternSerializer';
import { get } from 'svelte/store';

export interface Core { info?: DeviceInfo; config: LedConfiguration; fromCache: boolean }
/** Per strip: the layout, null = none (grid mapping), undefined = couldn't be read. */
export interface Layouts { layouts: (StripLayout | undefined)[]; complete: boolean; fromCache: boolean }
export interface Library { patterns: SerializedPattern[]; complete: boolean; fromCache: boolean }

interface Session { core?: Promise<Core>; layouts?: Promise<Layouts> }
const sessions = new Map<string, Session>();
const session = (id: string): Session => {
  let s = sessions.get(id);
  if (!s) { s = {}; sessions.set(id, s); }
  return s;
};

// One transfer at a time per device: a layout read and a library dump at once share one link
// and starve each other.
const queues = new Map<string, Promise<unknown>>();
function queued<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(deviceId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  queues.set(deviceId, run);
  run.finally(() => { if (queues.get(deviceId) === run) queues.delete(deviceId); }).catch(() => {});
  return run;
}

const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const nameOf = (id: string) => get(connectedDevices).get(id)?.name;

/**
 * Device info + LED config. The returned config is the caller's own copy (the settings form
 * edits it in place). `force` re-reads both, e.g. after a WLED import rewrote the config.
 */
export function syncCore(deviceId: string, opts: { force?: boolean } = {}): Promise<Core> {
  const s = session(deviceId);
  if (opts.force || !s.core) {
    const p = queued(deviceId, async (): Promise<Core> => {
      let info: DeviceInfo | undefined;
      try { info = await getDeviceInfo(deviceId); }
      catch (e) { console.warn('[deviceSync] device info read failed', deviceId, e); }
      // Only trust the cache against info read just now; without it we can't know it's current.
      const hit = info && !opts.force ? cached(deviceId, 'cfg') : undefined;
      let config: LedConfiguration;
      if (hit) {
        config = clone(hit);
        if (typeof info?.bri === 'number') config.globalBrightness = info.bri; // brightness isn't in the generation
      } else {
        const gen = info ? currentGen(deviceId, 'cfg') : undefined;
        config = await getLedConfiguration(deviceId);
        store(deviceId, 'cfg', gen, config);
      }
      recordDeviceConfig(deviceId, nameOf(deviceId), config.strips);
      if (hit) console.log(`[deviceSync] ${deviceId}: LED config unchanged (gen ${info?.gcfg}) — using the saved copy`);
      return { info, config, fromCache: !!hit };
    });
    s.core = p;
    p.catch(() => { if (session(deviceId).core === p) delete session(deviceId).core; }); // let a retry read again
  }
  return s.core!.then((c) => ({ ...c, config: clone(c.config) }));
}

/** Every strip's custom layout, recorded into deviceLayoutStore for previews. */
export function syncLayouts(deviceId: string, opts: { force?: boolean } = {}): Promise<Layouts> {
  const s = session(deviceId);
  if (opts.force || !s.layouts) {
    const p = (async (): Promise<Layouts> => {
      const core = await syncCore(deviceId);
      const count = core.config.strips.length;
      const hit = core.info && !opts.force ? cached(deviceId, 'lay') : undefined;
      if (hit && hit.length === count) {
        hit.forEach((l, i) => recordStripLayout(deviceId, i, l));
        console.log(`[deviceSync] ${deviceId}: layouts unchanged (gen ${core.info?.glay}) — using the saved copy`);
        return { layouts: hit, complete: true, fromCache: true };
      }
      return queued(deviceId, async () => {
        const gen = core.info ? currentGen(deviceId, 'lay') : undefined;
        const layouts: (StripLayout | undefined)[] = [];
        for (let i = 0; i < count; i++) {
          try {
            const l = await getStripLayout(deviceId, i);
            layouts.push(l);
            recordStripLayout(deviceId, i, l);
          } catch (e) {
            // Unknown, not "none": whatever was remembered for this strip stays.
            layouts.push(undefined);
            console.warn('[deviceSync] layout read failed', deviceId, i, e);
          }
        }
        const complete = layouts.every((l) => l !== undefined);
        if (complete) store(deviceId, 'lay', gen, layouts as StripLayout[]);
        return { layouts, complete, fromCache: false };
      });
    })();
    s.layouts = p;
    // An incomplete or failed read isn't kept: the next caller tries again.
    p.then((r) => { if (!r.complete && session(deviceId).layouts === p) delete session(deviceId).layouts; },
           () => { if (session(deviceId).layouts === p) delete session(deviceId).layouts; });
  }
  return s.layouts!;
}

/**
 * The device's stored patterns. From the saved copy when the library generation is unchanged;
 * otherwise a full dump, queued behind the device's other reads. Not memoized here —
 * deviceLibraryStore keeps the session's snapshot and decides when to ask.
 */
export async function syncLibrary(deviceId: string, opts: { force?: boolean } = {}): Promise<Library> {
  const core = await syncCore(deviceId).catch(() => null);
  if (core?.info && !opts.force) {
    const hit = cached(deviceId, 'lib');
    if (hit) {
      console.log(`[deviceSync] ${deviceId}: library unchanged (gen ${core.info.glib}) — using the saved copy (${hit.length} patterns)`);
      return { patterns: hit, complete: true, fromCache: true };
    }
  }
  return queued(deviceId, async () => {
    const gen = core?.info ? currentGen(deviceId, 'lib') : undefined;
    const r = await pullDeviceLibrary(deviceId);
    if (r.complete) store(deviceId, 'lib', gen, r.patterns);
    return { ...r, fromCache: false };
  });
}

// The app changed something on the device: this connection's copy is stale too.
onInvalidate((deviceId, kind) => {
  const s = sessions.get(deviceId);
  if (!s) return;
  if (kind === 'cfg') delete s.core;
  if (kind === 'lay') delete s.layouts;
});

// A disconnect ends the session: on reconnect, device info is read again and decides what's
// current. (A reconnect after a reboot onto new firmware must not reuse this session's reads.)
if (typeof window !== 'undefined') {
  let prev = new Set<string>();
  connectedDevices.subscribe((devices) => {
    for (const id of prev) {
      if (!devices.has(id)) { sessions.delete(id); forgetSession(id); }
    }
    prev = new Set(devices.keys());
  });
}

/** For tests. */
export function _resetDeviceSync() { sessions.clear(); queues.clear(); }
