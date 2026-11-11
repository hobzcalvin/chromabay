// A board converted from WLED keeps WLED's cfg.json and ledmap.json on its filesystem; on first
// connect the app applies them and retires them, with nobody opening a settings page.
import { test, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let info: any;
vi.mock('$lib/ble', () => ({
  WLED_FILES: { CFG: 0xf0, LEDMAP: 0xf1, LAST: 0xfa, RETIRE: 0xff },
  WLED_IMPORT_FEAT: 8,
  LedChipsets: { WS2812_RGB: 22, SK6812_RGBW: 27, TM1814_RGBW: 32, WS2811_400KHZ: 24, TM1829_RGB: 20, UCS8903_RGB: 52, UCS8904_RGBW: 53, APA106_RGB: 47, FW1906_RGBCW: 62, WS2805_RGBCW: 63, TM1914_RGB: 64, SM16825_RGBCW: 65, APA102_SPI: 25, SK9822_SPI: 26 },
  ColorOrders: { RGB: 0, RBG: 1, GRB: 2, GBR: 3, BRG: 4, BGR: 5 },
  getDeviceInfo: vi.fn(async () => info),
  readWledFile: vi.fn(async (_id: string, code: number) => {
    calls.push(['read', code]);
    if (code === 0xf0) return JSON.stringify({ id: { name: 'Desk' }, hw: { led: { ins: [{ len: 64, pin: [16], type: 22, order: 0 }], matrix: { panels: [{ w: 8, h: 8, s: true }] } }, btn: { ins: [{ type: 2, pin: [0] }] } }, def: { bri: 77 } });
    if (code === 0xf1) return JSON.stringify({ map: Array.from({ length: 64 }, (_, i) => 63 - i) });
    return null;
  }),
  retireWledFiles: vi.fn(async () => { calls.push(['retire']); }),
  setLedConfiguration: vi.fn(async (_id: string, c: any) => { calls.push(['config', c.strips[0].numLeds, c.strips[0].pin, c.globalBrightness]); }),
  setDeviceName: vi.fn(async (_id: string, n: string) => { calls.push(['name', n]); }),
  setButtonPin: vi.fn(async (_id: string, p: number) => { calls.push(['button', p]); }),
  uploadStripLayout: vi.fn(async (_id: string, i: number, l: any) => { calls.push(['layout', i, l.width, l.height, l.map[0]]); }),
}));

const { migrateFromWledIfNeeded } = await import('../wledMigration');
const { saveWledImport } = await import('../wledImport');
beforeEach(() => { calls.length = 0; localStorage.clear(); });

test('applies the settings WLED left on the device, once, then retires them', async () => {
  info = { feat: 8, wled: 1, name: 'ChromaBay_1B44' };
  const r = await migrateFromWledIfNeeded('dev1', info);
  expect(r?.source).toBe('device');
  expect(calls).toEqual([
    ['read', 0xf0], ['read', 0xf1],
    ['config', 64, 16, 77], ['name', 'Desk'], ['button', 0], ['layout', 0, 8, 8, 63],
    ['retire'],
  ]);
  calls.length = 0;
  expect(await migrateFromWledIfNeeded('dev1', info)).toBeNull();
  expect(calls).toEqual([]);
});

test('keeps a name the user already gave the device', async () => {
  info = { feat: 8, wled: 1, name: 'Porch' };
  await migrateFromWledIfNeeded('dev2', info);
  expect(calls.some((c) => c[0] === 'name')).toBe(false);
});

test('falls back to what the converter saved, for a factory-fresh device only', async () => {
  saveWledImport({ id: { name: 'Shelf' }, hw: { led: { ins: [{ len: 30, pin: [2], type: 22, order: 1 }] } }, def: { bri: 50 } });
  info = { feat: 7, name: 'Already Named' };
  expect(await migrateFromWledIfNeeded('dev3', info)).toBeNull();
  info = { feat: 7, name: 'ChromaBay_00AA' };
  const r = await migrateFromWledIfNeeded('dev4', info);
  expect(r?.source).toBe('saved');
  expect(calls).toEqual([['config', 30, 2, 50], ['name', 'Shelf']]);
  expect(localStorage.getItem('chromabay.wledImport')).toBeNull();
});
