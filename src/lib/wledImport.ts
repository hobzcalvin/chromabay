// Read a WLED configuration (its cfg.json: "Config → Security & Updates → Backup configuration",
// or GET http://<device>/json/cfg) and turn it into ChromaBay LED settings, so moving a light
// from WLED to ChromaBay keeps its LED count, pins, chipset, color order, matrix size, gamma
// and brightness. Pure: no I/O here, the callers fetch or read the file.
import type { LedConfiguration, LedStripConfig } from './ble';
import { LedChipsets, ColorOrders } from './ble';

export interface WledImport {
  /** WLED's device name (id.name), if any — offered as the ChromaBay device name. */
  name?: string;
  config: LedConfiguration;
  /** WLED's first button's GPIO, if it had one configured. */
  buttonPin?: number;
  /** Things that didn't carry over, in words a person can act on. */
  warnings: string[];
}

// WLED bus types (wled00/const.h) → ChromaBay chipsets.
const WLED_TYPES: Record<number, { chipset: number; name: string }> = {
  22: { chipset: LedChipsets.WS2812_RGB, name: 'WS281x' },
  24: { chipset: LedChipsets.WS2811_400KHZ, name: 'WS2811 400 kHz' },
  25: { chipset: LedChipsets.TM1829_RGB, name: 'TM1829' },
  26: { chipset: LedChipsets.UCS8903_RGB, name: 'UCS8903' },
  27: { chipset: LedChipsets.APA106_RGB, name: 'APA106' },
  28: { chipset: LedChipsets.FW1906_RGBCW, name: 'FW1906' },
  29: { chipset: LedChipsets.UCS8904_RGBW, name: 'UCS8904' },
  30: { chipset: LedChipsets.SK6812_RGBW, name: 'SK6812 RGBW' },
  31: { chipset: LedChipsets.TM1814_RGBW, name: 'TM1814' },
  32: { chipset: LedChipsets.WS2805_RGBCW, name: 'WS2805' },
  33: { chipset: LedChipsets.TM1914_RGB, name: 'TM1914' },
  34: { chipset: LedChipsets.SM16825_RGBCW, name: 'SM16825' },
  51: { chipset: LedChipsets.APA102_SPI, name: 'APA102' },
};
const WLED_TYPE_NAMES: Record<number, string> = {
  18: 'WS2812 single-channel', 19: 'WS2812 1-channel x3', 20: 'WS2812 CCT x3', 21: 'WS2812 WWA',
  23: 'GS8608', 50: 'WS2801', 52: 'LPD8806', 53: 'P9813', 54: 'LPD6803',
  41: 'PWM white', 42: 'PWM CCT', 43: 'PWM RGB', 44: 'PWM RGBW', 45: 'PWM RGB+CCT',
  80: 'DDP output', 81: 'E1.31 output', 82: 'Art-Net output',
};

// WLED color orders (low nibble of `order`) → ChromaBay's.
const WLED_ORDERS: Record<number, number> = {
  0: ColorOrders.GRB, 1: ColorOrders.RGB, 2: ColorOrders.BRG,
  3: ColorOrders.RBG, 4: ColorOrders.BGR, 5: ColorOrders.GBR,
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Parse WLED's cfg.json (as text or an object). Throws if it isn't one. */
export function wledConfigToChromaBay(input: unknown): WledImport {
  let cfg: any = input;
  if (typeof input === 'string') {
    try { cfg = JSON.parse(input); } catch { throw new Error("That file isn't JSON. Use WLED's cfg.json (Config → Security & Updates → Backup configuration)."); }
  }
  const ins: any[] | undefined = cfg?.hw?.led?.ins;
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(ins)) {
    throw new Error("That doesn't look like a WLED configuration (no hw.led.ins). Use WLED's cfg.json, not a presets file.");
  }
  const warnings: string[] = [];
  const strips: LedStripConfig[] = [];

  // Gamma: WLED corrects colors with gc.col (2.8 by default) when gamma correction is on.
  const gcol = num(cfg?.light?.gc?.col);
  const gamma = gcol && gcol > 1 ? Math.min(3, Math.round(gcol * 10) / 10) : 1.0;

  // A 2D setup with one panel maps onto one matrix strip.
  const panels: any[] = Array.isArray(cfg?.hw?.led?.matrix?.panels) ? cfg.hw.led.matrix.panels : [];

  ins.forEach((b, i) => {
    const type = num(b?.type) ?? 22;
    const t = WLED_TYPES[type];
    const label = `WLED output ${i + 1}`;
    if (!t) {
      warnings.push(`${label} is ${WLED_TYPE_NAMES[type] ?? `type ${type}`}, which ChromaBay doesn't drive; skipped.`);
      return;
    }
    const pins: number[] = Array.isArray(b?.pin) ? b.pin.filter((p: unknown) => typeof p === 'number') : [];
    const len = num(b?.len) ?? 0;
    if (!pins.length || len < 1) {
      warnings.push(`${label} has no pin or LED count; skipped.`);
      return;
    }
    if ((num(b?.skip) ?? 0) > 0) warnings.push(`${label} skips its first ${b.skip} LED(s); ChromaBay will drive them too.`);
    if ((num(b?.start) ?? 0) > 0 && i === 0) warnings.push(`${label} starts at LED ${b.start}; ChromaBay starts each output at 0.`);
    const order = num(b?.order) ?? 0;
    let width = len, height = 1, orientation = 0;
    if (panels.length === 1 && ins.length === 1) {
      const p = panels[0];
      const w = num(p?.w), h = num(p?.h);
      if (w && h && w * h === len) {
        width = w; height = h;
        if (p?.s) orientation |= 0x08; // serpentine
      } else if (w && h) {
        warnings.push(`WLED's ${w}×${h} matrix doesn't match the ${len} LEDs on ${label}; imported as a single row.`);
      }
    } else if (panels.length > 1 && i === 0) {
      warnings.push(`WLED had ${panels.length} matrix panels; set up the layout under Custom Layout.`);
    }
    if (b?.rev) orientation |= 0x04; // reversed → flipped horizontally
    strips.push({
      chipset: t.chipset,
      pin: pins[0],
      clockPin: t.chipset === LedChipsets.APA102_SPI ? (pins[1] ?? 0) : 0,
      numLeds: len,
      colorOrder: WLED_ORDERS[order & 0x0f] ?? ColorOrders.GRB,
      rmtChannel: 0,
      width,
      height,
      orientation,
      gamma,
      whitePoint: '#ffffff',
      dither: true,
    });
  });
  if (!strips.length) throw new Error(`No LED outputs ChromaBay can drive in that configuration.${warnings.length ? ' ' + warnings.join(' ') : ''}`);

  const bri = num(cfg?.def?.bri);
  const btn = Array.isArray(cfg?.hw?.btn?.ins) ? cfg.hw.btn.ins.find((x: any) => num(x?.type) && Array.isArray(x?.pin) && x.pin[0] >= 0) : undefined;
  const name = typeof cfg?.id?.name === 'string' && cfg.id.name.trim() ? cfg.id.name.trim() : undefined;
  return {
    name,
    config: { globalBrightness: bri !== undefined ? Math.max(1, Math.min(255, Math.round(bri))) : 128, strips },
    buttonPin: btn ? btn.pin[0] : undefined,
    warnings,
  };
}

/** One line describing what an import contains, for a confirmation prompt. */
export function describeWledImport(w: WledImport): string {
  const parts = w.config.strips.map((s) => {
    const shape = s.height && s.height > 1 ? `${s.width}×${s.height}` : `${s.numLeds} LEDs`;
    return `${shape} on GPIO ${s.pin}`;
  });
  return `${w.name ? `“${w.name}”: ` : ''}${parts.join(', ')}, brightness ${w.config.globalBrightness}`;
}

// A WLED config fetched just before converting a device, kept so the settings can be offered
// once the board is running ChromaBay (the conversion itself wipes WLED's settings).
const SAVED_KEY = 'chromabay.wledImport';
export function saveWledImport(cfg: unknown): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify({ cfg, savedAt: Date.now() })); } catch { /* storage unavailable */ }
}
export function loadSavedWledImport(): { result: WledImport; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const { cfg, savedAt } = JSON.parse(raw);
    return { result: wledConfigToChromaBay(cfg), savedAt };
  } catch { return null; }
}
export function clearSavedWledImport(): void {
  try { localStorage.removeItem(SAVED_KEY); } catch { /* ignore */ }
}
