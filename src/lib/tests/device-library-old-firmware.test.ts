// A LIBRARY_DUMP freezes firmware before feature level 6 (lights and brightness stop while it
// lists), and the Patterns page used to start one on every visit. Old devices are now dumped
// only when asked for by name; newer ones as before.
import { test, expect, vi } from 'vitest';
import { get } from 'svelte/store';

const pulls: string[] = [];
vi.mock('$lib/ble', () => ({
  pullDeviceLibrary: vi.fn(async (id: string) => { pulls.push(id); return { patterns: [{ nodes: [], meta: { name: 'p', output: 0 } }], complete: true }; }),
  getDeviceInfo: vi.fn(async () => ({ feat: 1 })),
}));

const { connectedDevices } = await import('../stores/deviceStore');
const { refreshDeviceLibraries, libraryHeldBack, deviceLibraries } = await import('../stores/deviceLibraryStore');

test('old firmware is not dumped automatically, only on request', async () => {
  const dev = (id: string, feat: number) => [id, { deviceId: id, name: id, services: [], lastConnected: 0, deviceInfo: { fw_ver: 'x', hw_ver: 'x', feat } }] as const;
  connectedDevices.set(new Map([dev('old', 4), dev('new', 7)]));
  await refreshDeviceLibraries();
  expect(pulls).toEqual(['new']);
  expect([...get(libraryHeldBack)]).toEqual(['old']);

  await refreshDeviceLibraries({ force: true }); // e.g. after a sync: still not the old one
  expect(pulls).toEqual(['new', 'new']);

  await refreshDeviceLibraries({ force: true, only: ['old'] }); // Per Device → load the list now
  expect(pulls).toEqual(['new', 'new', 'old']);
  expect(get(deviceLibraries).old).toHaveLength(1);
  expect(get(libraryHeldBack).has('old')).toBe(false);
});
