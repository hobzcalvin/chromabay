// deviceSync + deviceCache: a device's config, layouts and library are read once per
// connection, and not at all on a reconnect when its content generations say nothing changed.
import { test, expect, vi, beforeEach } from 'vitest';

const dev = {
  info: { fw_ver: 'fwv0.1.200', hw_ver: 'hwv0.0.1', feat: 9, id: 'aabbccddeeff', gcfg: 10, glay: 20, glib: 30, bri: 99 } as any,
  config: { globalBrightness: 50, strips: [{ numLeds: 144, width: 57, height: 49 }, { numLeds: 10, width: 10, height: 1 }] } as any,
  layouts: [{ width: 57, height: 49, map: [0, 1, -1] }, null] as any[],
  library: [{ meta: { name: 'A' } }, { meta: { name: 'B' } }] as any[],
};
const calls = { info: 0, config: 0, layout: 0, library: 0 };

vi.mock('$lib/ble', async () => {
  const cache = await import('$lib/deviceCache');
  return {
    getDeviceInfo: vi.fn(async (id: string) => { calls.info++; const i = { ...dev.info }; cache.noteDeviceInfo(id, i); return i; }),
    getLedConfiguration: vi.fn(async () => { calls.config++; return JSON.parse(JSON.stringify(dev.config)); }),
    getStripLayout: vi.fn(async (_id: string, i: number) => { calls.layout++; return dev.layouts[i]; }),
    pullDeviceLibrary: vi.fn(async () => { calls.library++; return { patterns: dev.library, complete: true }; }),
  };
});

import { connectedDevices } from '$lib/stores/deviceStore';
import { syncCore, syncLayouts, syncLibrary, _resetDeviceSync } from '$lib/deviceSync';
import { invalidate, _resetDeviceCache } from '$lib/deviceCache';

const ID = 'ble-1';
const connect = () => connectedDevices.set(new Map([[ID, { deviceId: ID, name: 'Portal', services: [], lastConnected: Date.now() }]]));
const disconnect = () => connectedDevices.set(new Map());

beforeEach(() => {
  localStorage.clear();
  _resetDeviceCache(); _resetDeviceSync();
  Object.assign(calls, { info: 0, config: 0, layout: 0, library: 0 });
  dev.info = { ...dev.info, gcfg: 10, glay: 20, glib: 30, bri: 99 };
  disconnect(); connect();
});

test('first connect reads everything once, however many pages ask', async () => {
  await Promise.all([syncCore(ID), syncCore(ID), syncLayouts(ID), syncLayouts(ID)]);
  await syncLibrary(ID);
  expect(calls).toEqual({ info: 1, config: 1, layout: 2, library: 1 });
});

test('a reconnect with unchanged generations reads only device info', async () => {
  await syncLayouts(ID); await syncLibrary(ID);
  disconnect(); connect();
  const core = await syncCore(ID);
  const lay = await syncLayouts(ID);
  const lib = await syncLibrary(ID);
  expect(calls).toEqual({ info: 2, config: 1, layout: 2, library: 1 });
  expect(core.fromCache && lay.fromCache && lib.fromCache).toBe(true);
  expect(core.config.globalBrightness).toBe(99); // live brightness from device info, not the stale copy
  expect(lay.layouts).toEqual(dev.layouts);
  expect(lib.patterns).toEqual(dev.library);
});

test('only what changed is read again', async () => {
  await syncLayouts(ID); await syncLibrary(ID);
  disconnect(); dev.info = { ...dev.info, glay: 21 }; connect();
  await syncLayouts(ID); await syncLibrary(ID);
  expect(calls).toEqual({ info: 2, config: 1, layout: 4, library: 1 });
});

test('a new firmware version ignores the saved copy', async () => {
  await syncLayouts(ID);
  disconnect(); dev.info = { ...dev.info, fw_ver: 'fwv0.1.201' }; connect();
  await syncLayouts(ID);
  expect(calls.config).toBe(2);
  expect(calls.layout).toBe(4);
});

test('the app writing a layout drops the saved copy, even before the device reports a new generation', async () => {
  await syncLayouts(ID);
  invalidate(ID, 'lay');
  disconnect(); connect();
  await syncLayouts(ID);
  expect(calls.layout).toBe(4);
  expect(calls.config).toBe(1);
});

test('firmware without generations reads every connection (no caching)', async () => {
  dev.info = { fw_ver: 'fwv0.1.160', hw_ver: 'x', feat: 8, id: 'aabbccddeeff' };
  await syncLayouts(ID); await syncLibrary(ID);
  disconnect(); connect();
  await syncLayouts(ID); await syncLibrary(ID);
  expect(calls).toEqual({ info: 2, config: 2, layout: 4, library: 2 });
});

test('a layout that could not be read is retried and never cached', async () => {
  const ble = await import('$lib/ble');
  (ble.getStripLayout as any).mockImplementationOnce(async () => { calls.layout++; throw new Error('timed out'); });
  const first = await syncLayouts(ID);
  expect(first.complete).toBe(false);
  expect(first.layouts[0]).toBeUndefined();
  const second = await syncLayouts(ID); // not memoized: reads again
  expect(second.complete).toBe(true);
  expect(calls.layout).toBe(4);
});

test('the config returned is the caller\'s own copy', async () => {
  const a = await syncCore(ID);
  a.config.strips[0].numLeds = 1;
  const b = await syncCore(ID);
  expect(b.config.strips[0].numLeds).toBe(144);
});
