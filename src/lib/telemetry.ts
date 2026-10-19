/**
 * What the app tells Sentry about its devices, so a problem report can be read from both ends.
 *
 * - Tags every app event with the connected devices' `device_id` (the factory MAC that
 *   firmware feat >= 7 reports in device info, and that sentry-micro already tags the device's
 *   own events with). In Sentry, `device_id:<id>` then finds the app's errors, logs, replays and
 *   feedback next to that device's crashes and logs, across the two projects.
 * - Records the BLE traffic that matters for "it did something weird" as breadcrumbs (they ride
 *   on every event, feedback included) and as Sentry Logs (searchable on their own):
 *   connects and drops, pattern pushes, brightness changes from either side.
 *
 * Brightness is the one stream that cannot be logged write by write: the slider sends one
 * every 40 ms. Writes are coalesced into gestures instead — one record per drag with its first
 * and last value, write count and duration — which is what the "slider stopped working"
 * question needs (did writes go out? how many? to which device?) at a fraction of the volume.
 */
import * as Sentry from '@sentry/sveltekit';
import { connectedDevices } from './stores/deviceStore';

type Level = 'info' | 'warning' | 'error';

/** A BLE breadcrumb, and (for the ones worth searching) a Sentry log line. */
export function bleEvent(message: string, data: Record<string, unknown> = {}, { level = 'info' as Level, log = true } = {}): void {
  Sentry.addBreadcrumb({ category: 'ble', message, data, level });
  if (!log) return;
  const attrs = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])) as Record<string, string | number | boolean>;
  try {
    if (level === 'error') Sentry.logger.error(message, attrs);
    else if (level === 'warning') Sentry.logger.warn(message, attrs);
    else Sentry.logger.info(message, attrs);
  } catch { /* logging must never break a BLE path */ }
}

// ---- Brightness gestures ------------------------------------------------------------------

const GESTURE_GAP_MS = 600; // a pause this long ends a gesture
interface Gesture { first: number; last: number; writes: number; failures: number; t0: number; t1: number; timer: ReturnType<typeof setTimeout> | null }
const gestures = new Map<string, Gesture>();

function endGesture(deviceId: string): void {
  const g = gestures.get(deviceId);
  if (!g) return;
  gestures.delete(deviceId);
  bleEvent('brightness gesture', {
    device: deviceName(deviceId), first: g.first, last: g.last, writes: g.writes, failures: g.failures, ms: Math.round(g.t1 - g.t0),
  }, { level: g.failures ? 'warning' : 'info' });
}

/** One brightness write the app sent (or failed to send) to a device. */
export function noteBrightnessWrite(deviceId: string, value: number, ok: boolean): void {
  const now = performance.now();
  let g = gestures.get(deviceId);
  if (!g) {
    g = { first: value, last: value, writes: 0, failures: 0, t0: now, t1: now, timer: null };
    gestures.set(deviceId, g);
  }
  g.last = value; g.t1 = now; g.writes++;
  if (!ok) g.failures++;
  if (g.timer) clearTimeout(g.timer);
  g.timer = setTimeout(() => endGesture(deviceId), GESTURE_GAP_MS);
}

/** A brightness value the device pushed on its own (button, schedule, boot floor). */
export function noteBrightnessFromDevice(deviceId: string, value: number): void {
  bleEvent('brightness from device', { device: deviceName(deviceId), value });
}

/** Flush any open gesture now (a report is being filed: get it into the breadcrumbs). */
export function flushGestures(): void {
  for (const id of [...gestures.keys()]) {
    const g = gestures.get(id);
    if (g?.timer) clearTimeout(g.timer);
    endGesture(id);
  }
}

// ---- Device identity on every event --------------------------------------------------------

let names = new Map<string, string>();
function deviceName(deviceId: string): string { return names.get(deviceId) ?? deviceId; }

/** The connected devices as Sentry sees them; also what a problem report attaches. */
export function deviceSummary(): Array<{ ble_id: string; name: string; device_id?: string; fw?: string; chip?: string; feat?: number; mode?: string }> {
  let list: ReturnType<typeof deviceSummary> = [];
  const unsub = connectedDevices.subscribe((m) => {
    list = [...m.values()].map((d) => {
      const info = (d.deviceInfo ?? {}) as Record<string, any>;
      return { ble_id: d.deviceId, name: info.name ?? d.name, device_id: info.id, fw: info.fw_ver, chip: info.chip, feat: info.feat, mode: info.mode };
    });
  });
  unsub();
  return list;
}

let started = false;
/** Keep Sentry's tags in step with the connected devices. Idempotent. */
export function startDeviceTelemetry(): void {
  if (started) return;
  started = true;
  let before = new Set<string>();
  connectedDevices.subscribe((m) => {
    names = new Map([...m.values()].map((d) => [d.deviceId, ((d.deviceInfo as any)?.name ?? d.name) as string]));
    const devices = deviceSummary();
    const ids = devices.map((d) => d.device_id).filter(Boolean) as string[];
    // `device_id` matches the firmware's own tag; with several devices it holds the first and
    // `device_ids` lists them all (a tag is one value).
    Sentry.setTag('device_id', ids[0] ?? null);
    Sentry.setTag('device_ids', ids.length > 1 ? ids.join(',') : null);
    Sentry.setTag('device_fw', devices[0]?.fw ?? null);
    Sentry.setTag('devices_connected', String(devices.length));
    Sentry.setContext('chromabay_devices', devices.length ? { devices } : null);
    const now = new Set(m.keys());
    for (const id of now) if (!before.has(id)) bleEvent('device connected', { device: deviceName(id), ble_id: id });
    for (const id of before) if (!now.has(id)) bleEvent('device gone', { ble_id: id });
    before = now;
  });
}
