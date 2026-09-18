// The protocol is singular — this test is what keeps it that way.
//
// Bluetooth and Wi-Fi carry the same characteristics. That property used to be maintained by
// hand (a firmware enum of Wi-Fi channels, mirrored against the BLE characteristics), and it
// drifted: 22 characteristics against 11 channels, so OTA, layouts, calibration, the button
// and the crash relay silently did not exist over Wi-Fi.
//
// Now the firmware's ENDPOINTS table is the single source of truth and channels are derived
// from UUIDs. These tests check that mechanically, so adding a characteristic to one side and
// not the other fails here rather than in someone's hands.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { channelForUuid } from '$lib/transport';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

/** UUIDs the firmware declares as endpoints (the table rows, resolved through the #defines). */
function firmwareEndpoints(): Map<string, string> {
  const main = read('esp32/src/main.cpp');
  const sentry = read('esp32/src/sentry_reporting.h');
  const defines = new Map<string, string>();
  for (const src of [main, sentry]) {
    for (const m of src.matchAll(/#define\s+(CHARACTERISTIC_UUID_\w+)\s+"([0-9a-fA-F-]+)"/g)) {
      defines.set(m[1], m[2].toLowerCase());
    }
  }
  const table = main.slice(main.indexOf('static const Endpoints::Endpoint ENDPOINTS[]'));
  const body = table.slice(table.indexOf('{'), table.indexOf('};'));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/\{\s*(CHARACTERISTIC_UUID_\w+)\s*,/g)) {
    const uuid = defines.get(m[1]);
    expect(uuid, `${m[1]} is used in ENDPOINTS but never #defined`).toBeTruthy();
    out.set(m[1], uuid!);
  }
  return out;
}

/** UUIDs the app addresses. */
function appCharacteristics(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of ['src/lib/ble.ts', 'src/lib/sentryRelay.ts']) {
    for (const m of read(file).matchAll(
      /const\s+(CHARACTERISTIC_UUID_\w+|SENTRY_\w+_UUID)\s*=\s*["']([0-9a-fA-F-]+)["']/g
    )) {
      out.set(m[1], m[2].toLowerCase());
    }
  }
  return out;
}

describe('BLE/Wi-Fi protocol parity', () => {
  it('every characteristic the app uses is an endpoint in the firmware', () => {
    const fw = new Set(firmwareEndpoints().values());
    const missing = [...appCharacteristics()]
      .filter(([, uuid]) => !fw.has(uuid))
      .map(([name, uuid]) => `${name} (${uuid})`);
    expect(missing, 'app addresses characteristics the firmware table does not declare').toEqual([]);
  });

  it('every firmware endpoint has a channel, and channels are unique', () => {
    const seen = new Map<number, string>();
    for (const [name, uuid] of firmwareEndpoints()) {
      const ch = channelForUuid(uuid); // throws if the UUID is outside the addressable family
      expect(ch, `${name} derived channel 0`).toBeGreaterThan(0);
      expect(seen.has(ch), `${name} collides with ${seen.get(ch)} on channel ${ch}`).toBe(false);
      seen.set(ch, name);
    }
  });

  it('both ends derive the same channel from a UUID', () => {
    // The firmware computes this from the two hex digits at offset 6; mirror it independently
    // rather than trusting the app's implementation to be its own oracle.
    for (const [, uuid] of firmwareEndpoints()) {
      expect(channelForUuid(uuid)).toBe(parseInt(uuid.slice(6, 8), 16));
    }
  });

  it('rejects a UUID that could not be carried over Wi-Fi', () => {
    expect(() => channelForUuid('0000180f-0000-1000-8000-00805f9b34fb')).toThrow(/no Wi-Fi channel/);
  });

  it('no operation reaches Bluetooth directly above the transport layer', () => {
    // The bug this catches: a high-level operation that calls BleClient/Web Bluetooth itself
    // instead of the shared primitives. It works perfectly over BLE and throws
    // "Device not connected" over Wi-Fi — which is exactly how getLedConfiguration,
    // sendBrightnessToDevice, getStripLayout and pullDeviceLibrary were found to be broken.
    const src = read('src/lib/ble.ts');
    const marker = '// --- Characteristic primitives (transport-agnostic) ---';
    const idx = src.indexOf(marker);
    expect(idx, 'primitive-layer marker missing from ble.ts').toBeGreaterThan(0);

    const offenders: string[] = [];
    src.slice(idx).split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (/\bBleClient\.|isWeb\(\)/.test(line)) offenders.push(`${i}: ${line.trim()}`);
    });
    expect(offenders, 'these bypass the transport and will fail over Wi-Fi').toEqual([]);
  });

  it('all-device live actions enumerate the shared device store, not BLE GATT state', () => {
    // A Wi-Fi connection is registered in deviceStore but intentionally has no BLE/GATT
    // entry. Using the private BLE map here made a pattern-card tap silently skip Wi-Fi while
    // the explicit per-device "Sync" button worked.
    const src = read('src/lib/ble.ts');
    const listFn = src.slice(
      src.indexOf('export function getConnectedDevices()'),
      src.indexOf('export function getConnectedDeviceCount()'),
    );
    const liveSyncFn = src.slice(
      src.indexOf('export async function syncPatternToAllDevices()'),
      src.indexOf('export async function setCycleOnDevice'),
    );
    expect(listFn).toContain('connectedDeviceStore');
    expect(listFn).not.toContain('bleConnections');
    expect(liveSyncFn).toContain('getConnectedDevices()');
    expect(liveSyncFn).not.toContain('bleConnections');
  });

  it('Wi-Fi connection initialization and layout commit acknowledgements stay symmetric', () => {
    const wifiStore = read('src/lib/stores/wifiDeviceStore.ts');
    const app = read('src/lib/ble.ts');
    const firmware = read('esp32/src/main.cpp');
    expect(wifiStore).toContain('await initializeConnectedDevice(id)');
    expect(app).toContain('CHARACTERISTIC_UUID_LAYOUT_SET, (reply)');
    expect(firmware).toMatch(
      /\{\s*CHARACTERISTIC_UUID_LAYOUT_SET,\s*NIMBLE_PROPERTY::WRITE\s*\|\s*NIMBLE_PROPERTY::NOTIFY/,
    );
    expect(firmware).toContain('Endpoints::notify(CHARACTERISTIC_UUID_LAYOUT_SET, status');
  });

  it('the cycle-control payload agrees end to end, and still accepts the old short form', () => {
    // [u32 intervalMs][u8 enabled][u32 crossfadeMs]. The crossfade word was appended to a
    // payload already in the field, so two things have to stay true at once: the app writes
    // the long form, and the firmware still accepts the short one from an app that predates
    // it. Getting the offset wrong here would read the enabled byte as part of the duration.
    const app = read('src/lib/ble.ts');
    const firmware = read('esp32/src/main.cpp');
    const sendFn = app.slice(
      app.indexOf('export async function setCycleOnDevice'),
      app.indexOf('export async function sendSinglePatternToDevice'),
    );
    expect(sendFn).toContain('new Uint8Array(9)');
    expect(sendFn).toContain('dv.setUint32(0, intervalMs, true)');
    expect(sendFn).toContain('dv.setUint8(4, enabled ? 1 : 0)');
    expect(sendFn).toContain('dv.setUint32(5, crossfadeMs, true)');

    const recvFn = firmware.slice(
      firmware.indexOf('static void onPlaylistSyncWrite'),
      firmware.indexOf('// Timestamp Sync Callbacks'),
    );
    expect(recvFn).toContain('if (v.length() < 5) return;');        // short form still lands
    expect(recvFn).toContain('v.length() >= 9');                    // long form detected, not assumed
    expect(recvFn).toContain('memcpy(&xf, v.data() + 5, 4)');       // same offset the app writes

    // A device told nothing about crossfading must keep what it had rather than silently
    // losing it, so the read is gated on the flag rather than defaulting to zero.
    expect(firmware).toContain('if (pendingCycleHasCrossfade) cycleCrossfadeMs = pendingCycleCrossfadeMs;');
  });

  it('the firmware has no hand-maintained channel list left', () => {
    // The specific thing that rotted. If someone reintroduces a second source of truth for
    // channel identity, this fails.
    expect(read('esp32/src/main.cpp')).not.toMatch(/enum\s+TcpChannel/);
  });
});
