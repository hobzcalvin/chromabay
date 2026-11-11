// Switching a light from WLED to ChromaBay keeps its settings, without anyone asking for it.
//
// Where the settings come from, in order:
//  1. The device itself. Converting over the air rewrites only the app, so WLED's filesystem,
//     with its cfg.json and ledmap.json, is still there on ChromaBay's first boot. Firmware
//     feat >= 8 says so ("wled":1 in device info) and serves the files; once applied, the app
//     tells it to retire them so this happens once.
//  2. A copy the in-app converter saved just before flashing (for a board whose filesystem
//     didn't survive), applied to the first factory-fresh ChromaBay device that connects soon
//     after.
// Applied: LED outputs (chipset, pins, counts, color order, matrix, gamma), brightness, the
// device name, the button pin, and WLED's ledmap.json as strip 1's layout.
import {
  getDeviceInfo, readWledFile, retireWledFiles, setLedConfiguration, setDeviceName, setButtonPin,
  uploadStripLayout, WLED_FILES, WLED_IMPORT_FEAT, type DeviceInfo,
} from './ble';
import { wledConfigToChromaBay, describeWledImport, loadSavedWledImport, clearSavedWledImport, type WledImport } from './wledImport';

/** A name ChromaBay gives a device on first boot ("ChromaBay_1B44"), i.e. nobody has named it. */
export const isFactoryName = (name: string | undefined): boolean => !!name && /^ChromaBay_[0-9A-Fa-f]{4}$/.test(name);
const SAVED_IMPORT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const attempted = new Set<string>();

export interface WledMigrationResult { summary: string; warnings: string[]; source: 'device' | 'saved' }

/**
 * If this device is fresh from WLED, apply WLED's settings to it. Returns what was applied,
 * or null when there was nothing to do. Never throws; runs at most once per device per session.
 */
export async function migrateFromWledIfNeeded(deviceId: string, info?: DeviceInfo | null): Promise<WledMigrationResult | null> {
  if (attempted.has(deviceId)) return null;
  attempted.add(deviceId);
  try {
    const di = info ?? (await getDeviceInfo(deviceId));
    let imp: WledImport | null = null;
    let source: 'device' | 'saved' = 'device';
    if ((di?.feat ?? 1) >= WLED_IMPORT_FEAT && (di as any)?.wled === 1) {
      const cfg = await readWledFile(deviceId, WLED_FILES.CFG);
      if (cfg) {
        const ledmap = await readWledFile(deviceId, WLED_FILES.LEDMAP);
        imp = wledConfigToChromaBay(cfg, ledmap ?? undefined);
      }
    }
    if (!imp) {
      const saved = loadSavedWledImport();
      if (saved && Date.now() - saved.savedAt < SAVED_IMPORT_MAX_AGE_MS && isFactoryName(di?.name)) {
        imp = saved.result;
        source = 'saved';
      }
    }
    if (!imp) return null;

    await applyWledImport(deviceId, imp, { rename: isFactoryName(di?.name) });
    if (source === 'device') await retireWledFiles(deviceId).catch(() => {});
    else clearSavedWledImport();
    return { summary: describeWledImport(imp), warnings: imp.warnings, source };
  } catch (e) {
    console.warn('[WLED migration] skipped:', e);
    attempted.delete(deviceId); // a failed read can be retried on the next connect
    return null;
  }
}

/** Write an import to a device: LED config (with brightness), name, button pin, layout. */
export async function applyWledImport(deviceId: string, imp: WledImport, opts: { rename: boolean }): Promise<void> {
  await setLedConfiguration(deviceId, imp.config);
  if (opts.rename && imp.name) await setDeviceName(deviceId, imp.name.slice(0, 31)).catch((e) => console.warn('[WLED migration] name:', e));
  if (imp.buttonPin !== undefined && imp.buttonPin >= 0 && imp.buttonPin <= 39) {
    await setButtonPin(deviceId, imp.buttonPin).catch((e) => console.warn('[WLED migration] button:', e));
  }
  if (imp.layout) await uploadStripLayout(deviceId, 0, imp.layout).catch((e) => console.warn('[WLED migration] layout:', e));
}
