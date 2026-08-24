// Hex ↔ hue/saturation for COLOR parameters.
//
// The app has one colour control everywhere: the hue/sat wheel (ColorWheel.svelte), where
// angle is hue and radius is saturation. Value/brightness deliberately isn't a dimension —
// that's the device's brightness control — so a colour param lives on the wheel at full
// value: the centre is white, the rim is fully saturated.
//
// A colour param's value travels as "#rrggbb" all the way to the operator: it's what the
// WASM metadata reports as the default, what the preview binding parses, and what the
// firmware's pattern parser reads. These two functions are the only places that convert.

/** "#rrggbb" → hue/sat on the operator's 0–255 scale. Brightness is discarded. */
export function hexToHueSat(hex: unknown): { hue: number; sat: number } {
  const s = typeof hex === 'string' ? hex.trim() : '';
  if (!/^#[0-9a-f]{6}$/i.test(s)) return { hue: 0, sat: 0 }; // anything unreadable reads as white
  const r = parseInt(s.slice(1, 3), 16) / 255;
  const g = parseInt(s.slice(3, 5), 16) / 255;
  const b = parseInt(s.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { hue: Math.round(h * 255) % 256, sat: max > 0 ? Math.round((d / max) * 255) : 0 };
}

/** Hue/sat on the operator's 0–255 scale → "#rrggbb" at full value. */
export function hueSatToHex(hue: number, sat: number): string {
  const h = ((Math.round(hue) % 256) + 256) % 256 / 255 * 6;
  const s = Math.max(0, Math.min(1, sat / 255));
  const i = Math.floor(h) % 6;
  const f = h - Math.floor(h);
  const p = Math.round(255 * (1 - s));
  const q = Math.round(255 * (1 - s * f));
  const t = Math.round(255 * (1 - s * (1 - f)));
  const rgb = [
    [255, t, p], [q, 255, p], [p, 255, t], [p, q, 255], [t, p, 255], [255, p, q],
  ][i];
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---- Colour parameter grouping ---------------------------------------------------------
// An operator expresses a colour in one of two ways, and the editor shows the same wheel for
// both: a COLOR param carrying "#rrggbb" (Test Rectangle, Time), or a hue+saturation pair of
// FLOAT params on the 0–255 scale (Rainbow's hue/saturation, Gradient's start_/end_ sets).
// A matching `*_val` stays a slider of its own — the wheel has no brightness axis.

import type { Parameter } from './flowStore';

export interface ColorGroup {
  key: string;           // stable id for {#each} — the hue (or hex) param's name
  label: string;         // "Color", "Start Color", …
  hex: Parameter | null; // a COLOR param, or null when this is a hue/sat pair
  hue: Parameter | null;
  sat: Parameter | null;
  val: Parameter | null; // shown as an ordinary slider under the wheel
}

/**
 * Colour controls an operator's params add up to, in declaration order. Each group's members
 * are the params the caller should NOT also render as plain sliders (except `val`, which is
 * exactly that).
 */
export function findColorGroups(params: Parameter[]): ColorGroup[] {
  const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
  const pick = (...names: string[]) => names.map((n) => byName.get(n)).find(Boolean) ?? null;
  const groups: ColorGroup[] = [];

  for (const p of params) {
    if (p.type === 'color') {
      groups.push({ key: p.name, label: p.label || 'Color', hex: p, hue: null, sat: null, val: null });
      continue;
    }
    // "hue" on its own, or a prefixed set like "start_hue" / "end_hue".
    const m = /^(|.*_)hue$/i.exec(p.name);
    if (!m) continue;
    const prefix = m[1].toLowerCase();
    const sat = pick(prefix + 'sat', prefix + 'saturation');
    if (!sat) continue; // a lone hue is a hue slider, not a colour
    groups.push({
      key: p.name,
      // "Start Hue" → "Start Color", "Hue" → "Color".
      label: (p.label || 'Hue').replace(/hue$/i, 'Color').replace(/^Color$/i, 'Color').trim(),
      hex: null,
      hue: p,
      sat,
      val: pick(prefix + 'val', prefix + 'value'),
    });
  }
  return groups;
}

/** Every param a colour group owns outright — the ones to hide from the plain slider list. */
export function colorGroupOwned(groups: ColorGroup[]): Set<string> {
  const owned = new Set<string>();
  for (const g of groups) {
    for (const p of [g.hex, g.hue, g.sat, g.val]) if (p) owned.add(p.name);
  }
  return owned;
}
