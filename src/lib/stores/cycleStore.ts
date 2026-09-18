// Session-wide Cycle mode. When ON, connected devices play their own on-device library
// autonomously (each steps its stored patterns on the synced clock — see setCycleOnDevice).
// When OFF, the app drives: devices mirror the one current pattern (Live).
//
// This lives in a store (not the Patterns page) so that WYSIWYG holds everywhere: any
// single-pattern action — selecting/interacting/editing a pattern, or opening the Edit or
// Interact tabs — calls exitCycle(), so what you see is what the devices show.
import { writable, get } from 'svelte/store';
import { connectedDevices, getConnectedDevicesList } from './deviceStore';
import { setCycleOnDevice } from '$lib/ble';

export const cycleEnabled = writable(false);
export const cycleSeconds = writable(30);
// Seconds to dissolve one pattern into the next. 0 = cut, which is how cycling behaved
// before crossfading existed, so it stays the default.
export const cycleCrossfadeSeconds = writable(0);

// The device clamps a crossfade to half the interval (a fade as long as the interval never
// finishes before the next one starts), so clamp here too and write the clamped value back
// — otherwise the box would keep showing a number the devices aren't honouring.
function normalizedCycleSettings() {
  const secs = Math.max(1, Math.floor(get(cycleSeconds) || 1));
  const fade = Math.min(Math.max(0, get(cycleCrossfadeSeconds) || 0), secs / 2);
  return { secs, fade };
}

/** Push the current cycle state (on/off + interval + crossfade) to every connected device. */
export async function applyCycle() {
  const { secs, fade } = normalizedCycleSettings();
  cycleSeconds.set(secs);
  cycleCrossfadeSeconds.set(fade);
  const on = get(cycleEnabled);
  for (const d of getConnectedDevicesList(get(connectedDevices))) {
    try {
      await setCycleOnDevice(d.deviceId, on, secs, fade);
    } catch (e) {
      console.error('[cycle] apply failed for', d.deviceId, e);
    }
  }
}

/** Leave Cycle mode (WYSIWYG). No-op if already off. */
export async function exitCycle() {
  if (!get(cycleEnabled)) return;
  cycleEnabled.set(false);
  await applyCycle();
}

// Keep devices consistent with the app's Cycle state BOTH ways: when a device (re)connects it
// may still be cycling from before while the UI shows Cycle off (or vice-versa), so push the
// current state to any freshly-connected device. Small delay so the link is ready first.
let cyclePrevConnected = new Set<string>();
connectedDevices.subscribe((map) => {
  const cur = new Set(map.keys());
  const fresh = [...cur].filter((id) => !cyclePrevConnected.has(id));
  cyclePrevConnected = cur;
  if (fresh.length === 0) return;
  setTimeout(() => {
    const on = get(cycleEnabled);
    const { secs, fade } = normalizedCycleSettings();
    for (const id of fresh) {
      if (!get(connectedDevices).has(id)) continue; // dropped again before we applied
      setCycleOnDevice(id, on, secs, fade).catch((e) => console.error('[cycle] apply-on-connect failed', id, e));
    }
  }, 1500);
});
