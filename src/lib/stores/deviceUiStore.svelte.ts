// Per-device UI state for the Devices page, at MODULE scope so it survives navigating away
// and back. It used to be component-local $state, which was wiped on every remount — so
// returning to Devices re-read the device over BLE, and if that read failed/raced you were
// left with a stuck "Loading…" and no brightness. Keeping it here means a device that already
// loaded stays loaded; we only (re)read genuinely new connections. Reactivity works because
// these are $state proxies exported from a .svelte.ts module.
import type { LedConfiguration, DeviceInfo, OTAUpdateStatus, FirmwareRegistryEntry, FirmwareChoice } from '$lib/ble';

export type DeviceSettings = {
  // 'connecting' until the initial handshake (LED config + device info) succeeds; the full
  // device card only renders when 'ready'. Until then the user sees a "connecting…" card.
  phase: 'connecting' | 'ready';
  showSettings: boolean;
  ledConfig: LedConfiguration | null;
  ledConfigLoading: boolean;
  deviceInfo: DeviceInfo | null;
  otaStatus: OTAUpdateStatus | null;
  otaInProgress: boolean;
  otaSuccess: boolean;
  checkingForUpdate: boolean;
  showUpdateConfirmation: boolean;
  latestFirmware: FirmwareRegistryEntry | null;
  firmwareChoice: FirmwareChoice | null; // variant resolution (wifi/no-wifi + fit) for the UI
  buttonPin: number | null;
};

export const deviceSettings = $state<Record<string, DeviceSettings>>({});
// Slider value, kept out of deviceSettings so dragging doesn't churn that object.
export const liveBrightness = $state<Record<string, number>>({});
// Devices whose initial handshake has completed — so a remount doesn't re-run it.
export const initializedDevices = new Set<string>();
