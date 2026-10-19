// What the LEDs showed, and what they should have shown.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './emu.mjs';

// esp32sim's atech14 ring reports LEDs in PHYSICAL order: chain LED i sits at position
// KNOB_RING_PHYSICAL[i] (esp32s3/src/board/atech14.rs at the pinned commit). The firmware drives
// the chain, so undo the map to compare against pixel indices.
const KNOB_RING_PHYSICAL = [0, 2, 4, 6, 8, 10, 11, 1, 3, 5, 7, 9];
export const RING_LEDS = KNOB_RING_PHYSICAL.length;
export const chainOrder = (physical) => KNOB_RING_PHYSICAL.map((p) => physical[p]);

/**
 * The colour a WS2812 receives for a pixel the firmware was given as [r, g, b].
 *
 * OPEN QUESTION (documentation/ESP32_EMULATOR.md, "Colour order"): with the default
 * colorOrder GRB, LedWrapper swaps R and G, and the NeoGrbFeature bus swaps them again, so the
 * wire carries R and G exchanged. esp32sim decodes the wire as a WS2812 does (G first), so it
 * sees red as green. That is what the firmware does today, and this encodes it rather than
 * hides it; if the colour order is changed deliberately, change this one function.
 */
export const WIRE_SWAPS_RG = true;
export function onWire([r, g, b]) { return WIRE_SWAPS_RG ? [g, r, b] : [r, g, b]; }

/** A channel at global brightness `bri` as the strip emits it on average (dithered or not). */
export function scaled(c, bri) { return (c * bri) / 255; }
export function scaledRgb(rgb, bri) { return rgb.map((c) => scaled(c, bri)); }

export const fmt = (c) => `[${c.map((v) => (Number.isInteger(v) ? v : v.toFixed(1))).join(',')}]`;

/** Every frame's LEDs in chain order, between t0 and t1 (emulated seconds). */
export function framesIn(run, t0, t1) {
  return run.frames.filter((f) => f.t >= t0 && f.t < t1).map((f) => ({ ...f, leds: chainOrder(f.leds) }));
}

/** Per-LED mean over frames: what the eye sees of a dithered strip. */
export function mean(frames) {
  if (!frames.length) return null;
  const acc = Array.from({ length: RING_LEDS }, () => [0, 0, 0]);
  for (const f of frames) f.leds.forEach((c, i) => c.forEach((v, k) => { acc[i][k] += v; }));
  return acc.map((c) => c.map((v) => v / frames.length));
}

export function uniform(leds, tol = 1) {
  const c0 = leds[0];
  return leds.every((c) => c.every((v, k) => Math.abs(v - c0[k]) <= tol)) ? c0 : null;
}

export function close(a, b, tol) { return a.every((v, k) => Math.abs(v - b[k]) <= tol); }

/**
 * The ring over time as runs of identical frames: [{ t0, t1, leds, uniform }]. Dither flicker
 * (±1 between sub-frames) is merged into one run.
 */
export function timeline(run, t0 = 0, t1 = Infinity, tol = 1) {
  const runs = [];
  for (const f of framesIn(run, t0, t1)) {
    const last = runs[runs.length - 1];
    if (last && last.leds.every((c, i) => close(c, f.leds[i], tol))) { last.t1 = f.t; last.count++; continue; }
    if (last) last.t1 = f.t;
    runs.push({ t0: f.t, t1: f.t, leds: f.leds, count: 1 });
  }
  for (const r of runs) r.uniform = uniform(r.leds, tol);
  return runs;
}

export function describeTimeline(runs, max = 25) {
  const lines = runs.slice(0, max).map((r) => `  t=${r.t0.toFixed(3)}..${r.t1.toFixed(3)} (${r.count} frames) ` +
    (r.uniform ? `all ${fmt(r.uniform)}` : r.leds.map(fmt).join(' ')));
  if (runs.length > max) lines.push(`  … ${runs.length - max} more`);
  return lines.join('\n') || '  (no LED frames at all)';
}

// ---- The app's renderer --------------------------------------------------------------------

let wasm = null;

/**
 * The FastLED WASM build the app previews with (static/native/, built from the same native/
 * operator sources the firmware compiles). It is built for the browser; given the binary and a
 * stand-in for `document`, it runs in Node unchanged.
 */
export async function wasmEngine() {
  if (wasm) return wasm;
  const dir = path.join(ROOT, 'static/native');
  const src = fs.readFileSync(path.join(dir, 'fastled.js'), 'utf8');
  const ctx = { console, URL, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance,
    location: { href: `file://${dir}/` }, document: { currentScript: { src: `file://${dir}/fastled.js` } } };
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src}\n;globalThis.__fastled = fastled;`, ctx);
  wasm = await ctx.__fastled({ wasmBinary: fs.readFileSync(path.join(dir, 'fastled.wasm')), print: () => {}, printErr: () => {} });
  return wasm;
}

/**
 * Render one operator with the WASM engine, as the app's preview does for a one-node pattern:
 * width x height RGB pixels, row-major, at timestampMs.
 */
export async function wasmRender(type, params, { width, height = 1, timestampMs = 1000 }) {
  const m = await wasmEngine();
  const id = m.ccall('createOperatorInstance', 'number', ['string'], [type]);
  if (id < 0) throw new Error(`WASM has no operator "${type}"`);
  const n = m.ccall('getOperatorParameterCount', 'number', ['string'], [type]);
  const info = [];
  for (let i = 0; i < n; i++) info.push(JSON.parse(m.ccall('getOperatorParameterInfo', 'string', ['string', 'number'], [type, i])));
  for (const [k, v] of Object.entries(params)) {
    const i = info.findIndex((p) => p.name === k);
    if (i < 0) throw new Error(`operator "${type}" has no parameter "${k}" (has ${info.map((p) => p.name).join(', ')})`);
    m.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [id, i, v]);
  }
  const bytes = width * height * 3;
  const out = m._malloc(bytes);
  m.HEAPU8.fill(0, out, out + bytes);
  m.ccall('renderOperator', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [id, 0, 0, out, width, height, timestampMs, 16]);
  const px = [];
  for (let i = 0; i < width * height; i++) px.push(Array.from(m.HEAPU8.subarray(out + i * 3, out + i * 3 + 3)));
  m._free(out);
  m.ccall('destroyOperatorInstance', null, ['number'], [id]);
  return px;
}
