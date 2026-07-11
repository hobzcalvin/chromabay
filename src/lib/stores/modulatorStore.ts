/**
 * Store for per-parameter automation (LFO / noise / random).
 * A parameter is either static, interactive (knob on the interact page), or modulated —
 * mutually exclusive. Modulation is evaluated in shared C++ (native/Modulation.h), compiled
 * into both the WASM preview and the firmware, so the browser and device agree.
 */
import { writable, get } from 'svelte/store';

// Shape enum — must match native/Modulation.h.
export const SHAPES = ['Sine', 'Triangle', 'Sawtooth', 'Square', 'Random', 'Perlin'] as const;
export type Shape = number; // 0..5, index into SHAPES

// Which of an automation's own fields can be driven live from the Interact page.
export type ModField = 'shape' | 'min' | 'max' | 'period';

export interface ModulatorConfig {
  shape: Shape;   // 0..5
  min: number;
  max: number;
  period: number; // seconds per cycle (for Random: seconds between jumps)
  interactive?: ModField[]; // fields exposed as live controls on the Interact page (any subset)
}

// nodeId -> paramName -> config
export const modulators = writable<Map<string, Map<string, ModulatorConfig>>>(new Map());

export function getModulator(nodeId: string, paramName: string): ModulatorConfig | null {
  return get(modulators).get(nodeId)?.get(paramName) ?? null;
}

export function setModulator(nodeId: string, paramName: string, cfg: ModulatorConfig): void {
  modulators.update((m) => {
    if (!m.has(nodeId)) m.set(nodeId, new Map());
    m.get(nodeId)!.set(paramName, cfg);
    return m;
  });
  autosave('parameter automation set');
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
