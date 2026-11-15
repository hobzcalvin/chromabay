/**
 * Store for per-parameter automation (LFO / noise / random).
 * A parameter is either static, interactive (knob on the interact page), or modulated —
 * mutually exclusive. Modulation is evaluated in shared C++ (native/Modulation.h), compiled
 * into both the WASM preview and the firmware, so the browser and device agree.
 */
import { writable, get } from 'svelte/store';

// Shape enum — must match native/Modulation.h. 0-5 run on the clock; 6+ follow the audio input
// (the device's microphone; in the preview, the simulated groove or the browser mic).
export const SHAPES = ['Sine', 'Triangle', 'Sawtooth', 'Square', 'Random', 'Perlin',
  'Volume', 'Bass', 'Mids', 'Treble', 'Beat', 'Beat wave', 'Beat ramp'] as const;
export type Shape = number; // index into SHAPES
export const CLOCK_SHAPES = 6;          // shapes [0, 6) are LFOs on the clock
export const FIRST_AUDIO_SHAPE = 6;
/** Audio level shapes: `period` is a release time in seconds (0 = raw). */
export function isAudioLevelShape(shape: number): boolean { return shape >= 6 && shape <= 10; }
/** Tempo-locked shapes: `period` is the cycle length in beats. */
export function isBeatLockedShape(shape: number): boolean { return shape === 11 || shape === 12; }
export function isAudioShape(shape: number): boolean { return shape >= FIRST_AUDIO_SHAPE && shape < SHAPES.length; }
/** What `period` means for a shape, for labels: seconds per cycle, release seconds, or beats. */
export function periodLabel(shape: number): string {
  return isBeatLockedShape(shape) ? 'Beats per cycle' : isAudioLevelShape(shape) ? 'Release (s)' : 'Period (s)';
}
export function periodSuffix(shape: number, period: number): string {
  if (isBeatLockedShape(shape)) return `${Math.max(1, Math.round(period))} beat${Math.round(period) > 1 ? 's' : ''}`;
  return isAudioLevelShape(shape) ? `${period}s release` : `${period}s`;
}

// Which of an automation's own fields can be driven live from the Interact page.
export type ModField = 'shape' | 'min' | 'max' | 'period';

export interface ModulatorConfig {
  shape: Shape;   // index into SHAPES
  min: number;
  max: number;
  period: number; // seconds per cycle (Random: between jumps; audio levels: release; beat-locked: beats)
  interactive?: ModField[]; // fields exposed as live controls on the Interact page (any subset)
  seed?: number;  // the saved pattern's `sd`; absent for a new automation (see modulatorSeedFor)
}

// nodeId -> paramName -> config
export const modulators = writable<Map<string, Map<string, ModulatorConfig>>>(new Map());

export function getModulator(nodeId: string, paramName: string): ModulatorConfig | null {
  return get(modulators).get(nodeId)?.get(paramName) ?? null;
}

// A stable per-automation seed so two Random/Perlin automations running at the same time
// (even the same param on different nodes) decorrelate instead of moving in lockstep. Derived
// deterministically from the node id + param name (FNV-1a), so it's identical every load and
// — since the app hands this same value to BOTH the WASM preview and the firmware — the device
// and browser stay bit-identical. Capped at 24 bits so it survives the mpack wire (read as a
// float on-device) with no precision loss. Feeds native/Modulation.h's `seed` argument.
//
// Node ids are regenerated on every load (they embed Date.now()), so this is only the seed an
// automation is BORN with: it is saved as `sd` and read back into cfg.seed, and every consumer
// goes through modulatorSeedFor() so the saved value wins from then on.
export function modulatorSeed(nodeId: string, paramName: string): number {
  const s = `${nodeId}:${paramName}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0xffffff; // 24-bit, exactly representable as float32 on the device
}

/** The seed an automation actually uses: its saved one, else the one derived for a new one. */
export function modulatorSeedFor(nodeId: string, paramName: string, cfg: ModulatorConfig): number {
  return typeof cfg.seed === 'number' ? cfg.seed : modulatorSeed(nodeId, paramName);
}

// `silent` skips the autosave side-effect. Deserialize (global load AND isolated
// previews) registers modulators in bulk — that is not a user "set automation"
// action, so it must not schedule a save. Left unguarded, preview deserializes on
// the patterns list autosaved the current pattern, which rewrote localStorage and
// re-mounted every thumbnail → endless re-deserialize loop (~500ms debounce).
export function setModulator(nodeId: string, paramName: string, cfg: ModulatorConfig, silent = false): void {
  modulators.update((m) => {
    if (!m.has(nodeId)) m.set(nodeId, new Map());
    m.get(nodeId)!.set(paramName, cfg);
    return m;
  });
  if (!silent) autosave('parameter automation set');
}

export function clearModulator(nodeId: string, paramName: string): void {
  modulators.update((m) => {
    m.get(nodeId)?.delete(paramName);
    if (m.get(nodeId)?.size === 0) m.delete(nodeId);
    return m;
  });
  autosave('parameter automation cleared');
}

/** Drop all automation for a node (used when a node is deleted). */
export function clearNodeModulators(nodeId: string): void {
  modulators.update((m) => { m.delete(nodeId); return m; });
}

function autosave(reason: string) {
  if (typeof window === 'undefined') return;
  import('../flowStore').then(({ triggerAutoSave }) => triggerAutoSave(reason)).catch(() => {});
}
