// A layout read that fails (timeout, dropped link) is not "this strip has no layout": the app
// used to treat it as one and forget a device's custom layout, so Interact drew the plain grid.
import { test, expect, vi } from 'vitest';
import { get } from 'svelte/store';

let layoutRead: () => Promise<any> = async () => { throw new Error('timed out'); };
vi.mock('$lib/ble', () => ({
  getLedConfiguration: vi.fn(async () => ({ globalBrightness: 255, strips: [
    { chipset: 26, pin: 32, numLeds: 144, colorOrder: 0, rmtChannel: 0, width: 48, height: 3, orientation: 0 }] })),
  getStripLayout: vi.fn(() => layoutRead()),
}));

const { deviceLayouts, recordDeviceConfig, recordStripLayout, syncDeviceLayout } = await import('../stores/deviceLayoutStore');

test('a failed layout read keeps the remembered layout, and is retried', async () => {
  const layout = { width: 57, height: 49, map: Array.from({ length: 57 * 49 }, (_, i) => (i % 50 === 0 ? i / 50 : -1)) };
  recordDeviceConfig('dev', 'Portal', [{ chipset: 26, pin: 32, numLeds: 144, colorOrder: 0, rmtChannel: 0, width: 48, height: 3, orientation: 0 }]);
  recordStripLayout('dev', 0, layout);

  await syncDeviceLayout('dev'); // read fails
  expect(get(deviceLayouts)[0].strips[0].layout?.width).toBe(57);

  layoutRead = async () => null; // next session the device really has none
  await syncDeviceLayout('dev'); // not marked synced after the failure, so it reads again
  expect(get(deviceLayouts)[0].strips[0].layout).toBeUndefined();
});
