import { test, expect } from 'vitest';
import { wledConfigToChromaBay, describeWledImport } from '../wledImport';
import { LedChipsets, ColorOrders } from '../ble';

// Trimmed from a real WLED 0.14 cfg.json (Config → Security & Updates → Backup configuration).
const cfg = {
  rev: [1, 0], vid: 2405180,
  id: { mdns: 'wled-porch', name: 'Porch Lights', inv: 'Light' },
  nw: { ins: [{ ssid: 'home', pskl: 10, ip: [0, 0, 0, 0] }] },
  hw: {
    led: {
      total: 256, maxpwr: 850, ledma: 55,
      ins: [{ start: 0, len: 256, pin: [16], order: 0, rev: false, skip: 0, type: 22, ref: false, rgbwm: 3, freq: 0 }],
      matrix: { mpc: 1, panels: [{ b: false, r: false, v: false, s: true, x: 0, y: 0, h: 16, w: 16 }] },
    },
    btn: { max: 4, pull: true, ins: [{ type: 2, pin: [0], macros: [0, 0, 0] }, { type: 0, pin: [-1] }] },
  },
  light: { 'scale-bri': 100, gc: { bri: 1, col: 2.8, val: 2.8 } },
  def: { ps: 0, on: true, bri: 96 },
};

test('maps a 16x16 serpentine WS2812 matrix', () => {
  const r = wledConfigToChromaBay(JSON.stringify(cfg));
  expect(r.name).toBe('Porch Lights');
  expect(r.buttonPin).toBe(0);
  expect(r.config.globalBrightness).toBe(96);
  expect(r.config.strips).toHaveLength(1);
  const s = r.config.strips[0];
  expect(s).toMatchObject({ chipset: LedChipsets.WS2812_RGB, pin: 16, numLeds: 256, width: 16, height: 16, colorOrder: ColorOrders.GRB, gamma: 2.8 });
  expect(s.orientation & 0x08).toBe(0x08);
  expect(r.warnings).toEqual([]);
  expect(describeWledImport(r)).toContain('16×16 on GPIO 16');
});

test('maps several outputs, APA102 clock pin, RGBW, orders, and warns about the rest', () => {
  const c = structuredClone(cfg) as any;
  c.hw.led.matrix = undefined;
  c.light.gc.col = 1.0;
  c.hw.led.ins = [
    { start: 0, len: 60, pin: [2], order: 1, rev: true, skip: 0, type: 30 },
    { start: 60, len: 144, pin: [13, 14], order: 4, type: 51 },
    { start: 204, len: 1, pin: [12], order: 0, type: 43 },
    { start: 205, len: 30, pin: [4], order: 0x30 | 2, type: 22, skip: 1 },
  ];
  const r = wledConfigToChromaBay(c);
  expect(r.config.strips.map((s) => [s.chipset, s.pin, s.clockPin, s.numLeds, s.colorOrder, s.gamma])).toEqual([
    [LedChipsets.SK6812_RGBW, 2, 0, 60, ColorOrders.RGB, 1],
    [LedChipsets.APA102_SPI, 13, 14, 144, ColorOrders.BGR, 1],
    [LedChipsets.WS2812_RGB, 4, 0, 30, ColorOrders.BRG, 1],
  ]);
  expect(r.config.strips[0].orientation & 0x04).toBe(0x04);
  expect(r.warnings.join(' ')).toMatch(/PWM RGB.*skipped/);
  expect(r.warnings.join(' ')).toMatch(/skips its first 1/);
});

test('rejects things that are not a WLED config', () => {
  expect(() => wledConfigToChromaBay('not json')).toThrow(/isn't JSON/);
  expect(() => wledConfigToChromaBay({ 0: { n: 'preset' } })).toThrow(/doesn't look like a WLED configuration/);
  expect(() => wledConfigToChromaBay({ hw: { led: { ins: [{ type: 43, pin: [1], len: 1 }] } } })).toThrow(/No LED outputs/);
});

test('a WLED ledmap.json becomes strip 1 layout; 1D maps take the matrix size', async () => {
  const { wledLedmapToLayout } = await import('../wledImport');
  expect(wledLedmapToLayout('{"n":"snake","width":2,"height":2,"map":[0,1,3,-1]}')).toEqual({ width: 2, height: 2, map: [0, 1, 3, -1] });
  expect(wledLedmapToLayout({ map: [3, 2, 1, 0] }, { width: 2, height: 2 })).toEqual({ width: 2, height: 2, map: [3, 2, 1, 0] });
  expect(wledLedmapToLayout({ map: [2, 1, 0] })).toEqual({ width: 3, height: 1, map: [2, 1, 0] });
  expect(wledLedmapToLayout({ width: 3, height: 3, map: [0, 1] })).toBeNull();
  const map = Array.from({ length: 256 }, (_, i) => 255 - i);
  const r = wledConfigToChromaBay(cfg, { map });
  expect(r.layout).toEqual({ width: 16, height: 16, map });
  expect(describeWledImport(r)).toContain('custom layout');
});
