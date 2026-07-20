<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { dev } from '$app/environment';
  import { patterns, currentPattern, switchToPattern } from '$lib/stores/patternsStore';
  import { loadSerializedPattern, forceSyncCurrentPattern } from '$lib/flowStore';
  import {
    initBle,
    isBleEnabled,
    enableBle,
    startScan,
    stopScan,
    startBleStateNotifications,
    startButtonEventNotifications,
    connectToDevice,
    disconnectFromDevice,
    isDeviceConnected,
    discoverServices,
    // OTA Imports
    getDeviceInfo,
    fetchFirmwareRegistry,
    findLatestFirmware,
    resolveFirmware,
    performOTAUpdate,
    performManualOTAUpdate,
    prefetchFirmware,
    startOTAStatusNotifications,
    stopOTAStatusNotifications,
    type DeviceInfo,
    type FirmwareRegistryEntry,
    type OTAUpdateStatus,
    // LED Configuration Imports
    getLedConfiguration,
    setLedConfiguration,
    sendBrightnessToDevice,
    setDeviceName,
    getButtonPin,
    setButtonPin,
    type LedConfiguration,
    type LedStripConfig,
    LedChipsets,
    ColorOrders,
    getRotation,
    getFlipH,
    getSerpentine,
    setRotation,
    setFlipH,
    setSerpentine
  } from '$lib/ble';
  import { Capacitor } from '@capacitor/core';
  import { connectedDevices, getConnectedDevicesList, type ConnectedDevice } from '$lib/stores/deviceStore';
  import { deviceSettings, liveBrightness, initializedDevices } from '$lib/stores/deviceUiStore.svelte';
  import LedConfigurationComponent from '$lib/components/LedConfiguration.svelte';
  import UsbFlash from '$lib/components/UsbFlash.svelte';
  import WledConvert from '$lib/components/WledConvert.svelte';
  import DeviceSettingsPanel from '$lib/components/DeviceSettingsPanel.svelte';
  import WifiDevices from '$lib/components/WifiDevices.svelte';

  let bleSupported = $state(false);
  let bleEnabled = $state(false);
  let scanning = $state(false);
  let devices: any[] = $state([]);
  let statusMessage = $state('');
  // deviceId -> last advertisement time (ms). Discovered devices are pruned from `devices`
  // once they've gone quiet for STALE_DEVICE_MS, so a powered-off/out-of-range device stops
  // lingering in the list. The window gives hysteresis so devices don't flicker in and out.
  let lastSeen: Record<string, number> = {};
  const STALE_DEVICE_MS = 10000;
  let pruneTimer: any = null;

  function pruneStaleDevices() {
    const cutoff = Date.now() - STALE_DEVICE_MS;
    // Keep a device if seen recently, OR if we're connected to it (connected devices may stop
    // advertising, and they're shown from the store anyway — never prune those from view here).
    const next = devices.filter(d =>
      (lastSeen[d.deviceId] ?? 0) >= cutoff || $connectedDevices.has(d.deviceId)
    );
    if (next.length !== devices.length) devices = next;
  }
  let isWeb = $state(false);

  // Per-device UI state (phase/ledConfig/deviceInfo/brightness/…) lives in a MODULE store so
  // it survives navigating away from and back to this page — otherwise remount wiped it and
  // forced a fresh (sometimes-failing) BLE re-read, which is what dropped the brightness.
  // See deviceUiStore. `deviceSettings` is deeply-reactive $state; mutate in place.

  // Connected devices from store
  const connectedDevicesList = $derived(getConnectedDevicesList($connectedDevices));

  // Load per-device data as a REACTION to a device being connected, regardless of
  // HOW it connected (native button, web auto-connect, or reconnect after reboot).
  // Previously each connect path initialized state differently, so e.g. web
  // auto-connected devices never loaded their LED config until Settings was opened.
  // Devices to RENDER as connected/connecting, keyed by id — decoupled from the raw BLE store
  // so the UI can: (a) show "connecting" the instant Connect is tapped (before the store adds
  // it), (b) show disconnected instantly on Disconnect, and (c) tolerate TRANSIENT drops — a
  // device that briefly leaves the store isn't yanked from the list; it lingers for a grace
  // period (like the pattern-library hysteresis) so a quick blip doesn't flash the card away.
  // Per-device state (connecting vs ready) still lives in deviceSettings[id].phase.
  let shown = $state<Record<string, any>>({});
  let dropTimers: Record<string, any> = {};
  let intentionalDisconnect = new Set<string>(); // user tapped Disconnect → drop now, no grace
  const CONNECT_GRACE_MS = 8000;
  const shownList = $derived(Object.values(shown));

  function removeShown(id: string) {
    if (dropTimers[id]) { clearTimeout(dropTimers[id]); delete dropTimers[id]; }
    delete shown[id];
    delete deviceSettings[id];
    initializedDevices.delete(id);
  }

  function reconcileShown(list: ConnectedDevice[]) {
    const storeIds = new Set(list.map((d) => d.deviceId));
    for (const d of list) {
      if (dropTimers[d.deviceId]) { clearTimeout(dropTimers[d.deviceId]); delete dropTimers[d.deviceId]; }
      shown[d.deviceId] = d; // (re)appeared → keep/refresh, cancelling any pending drop
      if (!initializedDevices.has(d.deviceId)) {
        initializedDevices.add(d.deviceId);
        initConnectedDevice(d.deviceId);
      }
    }
    // Shown but no longer in the store → grace timer, unless the user explicitly disconnected.
    for (const id of Object.keys(shown)) {
      if (storeIds.has(id) || intentionalDisconnect.has(id) || dropTimers[id]) continue;
      dropTimers[id] = setTimeout(() => {
        delete dropTimers[id];
        if (!get(connectedDevices).has(id)) removeShown(id); // still gone after grace → drop
      }, CONNECT_GRACE_MS);
    }
  }

  $effect(() => {
    const list = connectedDevicesList; // re-run only when the connected set changes
    untrack(() => reconcileShown(list));
  });

  let firmwareRegistry: FirmwareRegistryEntry[] = $state([]);
  let espFirmwareRegistryUrl = "https://chromabay.app/firmware/esp32/esp32_firmware_registry.json";

  // Fetch firmware registry on app load
  async function initializeFirmwareRegistry() {
    try {
      firmwareRegistry = await fetchFirmwareRegistry(espFirmwareRegistryUrl);
      // Check for updates for all connected devices
      const connected = getConnectedDevicesList($connectedDevices);
      for (const device of connected) {
        await checkForUpdateSilently(device.deviceId);
      }
    } catch (error) {
      console.error('Failed to initialize firmware registry:', error);
    }
  }

  // Build information
  const buildInfo = {
    version: import.meta.env.VITE_VERSION || 'dev',
    commitHash: import.meta.env.VITE_COMMIT_HASH || 'dev',
    buildDate: import.meta.env.VITE_BUILD_DATE || new Date().toISOString(),
    commitMessage: import.meta.env.VITE_COMMIT_MESSAGE || 'Development build'
  };

  // The build date is baked in as a UTC timestamp; show it in the viewer's local
  // timezone so "how current is this?" is obvious at a glance. Falls back to the
  // raw string if it isn't parseable.
  function formatBuildDate(raw: string): string {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short'
    });
  }

  onMount(async () => {
    isWeb = Capacitor.getPlatform() === 'web';
    // Periodically drop discovered devices that have gone quiet (see pruneStaleDevices).
    pruneTimer = setInterval(pruneStaleDevices, 3000);
    try {
      await initBle();
      bleSupported = true;
      bleEnabled = await isBleEnabled();
      statusMessage = bleEnabled ? 'Bluetooth is ready!' : 'Bluetooth is not enabled';
    } catch (error: any) {
      console.error('BLE initialization failed:', error);
      statusMessage = 'BLE not supported on this platform';
    }

    // Native: react to the system Bluetooth toggle, and always scan (no button).
    if (!isWeb) {
      startBleStateNotifications((enabled) => {
        bleEnabled = enabled;
        if (enabled) {
          statusMessage = 'Bluetooth is ready!';
          handleStartScan();
        } else {
          statusMessage = 'Bluetooth is off';
          scanning = false;
          devices = [];
          stopScan().catch(() => {});
        }
      });
      if (bleEnabled) handleStartScan(); // always scanning on mobile
    }

    // Initialize firmware registry
    await initializeFirmwareRegistry();
    
    // CREATE FAKE DEVICE FOR TESTING (dev mode only, and only when explicitly opted
    // in via localStorage — otherwise it clutters the real connected-device list and
    // gets mistaken for a real device. Enable with:
    //   localStorage.setItem('chromabay:fakeDevice', '1')
    if (dev && typeof localStorage !== 'undefined' && localStorage.getItem('chromabay:fakeDevice') === '1') {
      setTimeout(() => {
        const fakeDeviceId = 'fake-test-device-12345';
        const fakeName = 'TEST ESP32 Device';
        
        // Add to connected devices
        connectedDevices.update(devices => {
          devices.set(fakeDeviceId, { 
            name: fakeName, 
            deviceId: fakeDeviceId,
            services: [],
            lastConnected: Date.now()
          });
          return devices;
        });
        
        // Create fake device settings with all the data needed
        const fakeSettings = {
          phase: 'ready' as const,
          showSettings: false,
          deviceInfo: {
            fw_ver: 'esp32-v0.0.13',
            hw_ver: 'esp32-hw-v1.0',
            heap: 185420
          },
          ledConfig: {
            globalBrightness: 128,
            strips: [{
              chipset: LedChipsets.WS2812_RGB,
              pin: 13,
              numLeds: 144,
              colorOrder: ColorOrders.GRB,
              rmtChannel: 0,
              width: 12,
              height: 12,
              orientation: 0
            }]
          },
          ledConfigLoading: false,
          latestFirmware: null,
          firmwareChoice: null,
          showUpdateConfirmation: false,
          checkingForUpdate: false,
          otaInProgress: false,
          otaSuccess: false,
          otaStatus: null,
          buttonPin: null
        };
        
        deviceSettings[fakeDeviceId] = fakeSettings;
        initializedDevices.add(fakeDeviceId); // it has hardcoded data; skip BLE init

        liveBrightness[fakeDeviceId] = fakeSettings.ledConfig.globalBrightness;
        
        statusMessage = 'Fake test device created for debugging';
        console.log('Fake device created:', fakeDeviceId, fakeSettings);
      }, 2000);
    }
    
    // Auto-check for updates when app is foregrounded
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          // Check for updates for all connected devices
          const connected = getConnectedDevicesList($connectedDevices);
          for (const device of connected) {
            checkForUpdateSilently(device.deviceId);
          }
        }
      });
    }
  });

  function getDeviceSettings(deviceId: string) {
    if (!deviceSettings[deviceId]) {
      deviceSettings[deviceId] = {
        phase: 'connecting',
        showSettings: false,
        ledConfig: null,
        ledConfigLoading: false,
        deviceInfo: null,
        otaStatus: null,
        otaInProgress: false,
        otaSuccess: false,
        checkingForUpdate: false,
        showUpdateConfirmation: false,
        latestFirmware: null,
          firmwareChoice: null,
        buttonPin: null
      };
    }
    return deviceSettings[deviceId];
  }

  async function handleEnableBle() {
    try {
      await enableBle();
      bleEnabled = await isBleEnabled();
      statusMessage = 'Bluetooth enabled successfully!';
    } catch (error: any) {
      statusMessage = 'Failed to enable Bluetooth';
      console.error('Enable BLE error:', error);
    }
  }

  function handleStartScan() {
    if (!bleEnabled) {
      statusMessage = 'Please enable Bluetooth first';
      return;
    }

    scanning = true;
    devices = [];
    lastSeen = {};
    statusMessage = isWeb ? 'Opening device picker...' : 'Scanning for devices...';

    startScan((result) => {
      // Refresh the "last seen" time on every advertisement so pruneStaleDevices() keeps
      // present devices and drops ones that have gone quiet (see allowDuplicates in startScan).
      lastSeen[result.device.deviceId] = Date.now();
      const existingDevice = devices.find(d => d.deviceId === result.device.deviceId);
      if (!existingDevice) {
        devices = [...devices, result.device];
      }

      // Native: auto-reconnect a remembered device that just (re)appeared.
      maybeAutoReconnect(result.device);

      // Handle auto-connection for web
      if (isWeb && result.autoConnected) {
        statusMessage = `Connected to ${result.device.name}!`;
      } else if (isWeb && result.connectError) {
        statusMessage = `Device selected but connection failed: ${result.connectError.message}`;
      }
    }).then(() => {
      // Web: the picker has closed. Native: requestLEScan resolves once the scan
      // has STARTED and keeps running via the callback, so stay "scanning".
      if (isWeb) scanning = false;
    }).catch((error: any) => {
      scanning = false;
      if (error.name === 'NotFoundError') {
        statusMessage = 'No device selected or no devices found';
      } else if (error.name === 'SecurityError') {
        statusMessage = 'Bluetooth access denied. Make sure you clicked the button directly and your site is on HTTPS (or localhost).';
      } else {
        statusMessage = 'Failed to start scanning';
      }
      console.error('Scan error:', error);
    });
  }

  async function handleStopScan() {
    try {
      await stopScan();
      scanning = false;
      statusMessage = `Scan stopped. Found ${devices.length} devices.`;
    } catch (error: any) {
      scanning = false;
      statusMessage = 'Error stopping scan';
      console.error('Stop scan error:', error);
    }
  }

  // --- Auto-reconnect (native, while the app is open) ---
  // Remember devices we've connected to; when a remembered device shows up in the scan
  // again (e.g. it lost power and came back), reconnect without a tap. Native only —
  // Web Bluetooth needs a user gesture to connect.
  const REMEMBERED_KEY = 'chromabay:rememberedDevices';
  function getRemembered(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(REMEMBERED_KEY) || '[]')); } catch { return new Set(); }
  }
  function rememberDevice(id: string) {
    if (!id) return;
    try { const s = getRemembered(); s.add(id); localStorage.setItem(REMEMBERED_KEY, JSON.stringify([...s])); } catch {}
  }
  // A *manual* disconnect is sticky: forget the device so auto-reconnect doesn't
  // immediately pull it back. Only unexpected drops (power loss / out of range) keep
  // their remembered entry and auto-reconnect. Tapping Connect again re-arms it.
  function forgetDevice(id: string) {
    if (!id) return;
    try { const s = getRemembered(); s.delete(id); localStorage.setItem(REMEMBERED_KEY, JSON.stringify([...s])); } catch {}
  }
  const autoConnecting = new Set<string>();
  onDestroy(() => {
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    for (const id of Object.keys(dropTimers)) clearTimeout(dropTimers[id]);
  });

  async function maybeAutoReconnect(device: any) {
    if (isWeb) return;
    const id = device?.deviceId;
    if (!id || autoConnecting.has(id)) return;
    if (get(connectedDevices).has(id)) return;       // already connected
    if (!getRemembered().has(id)) return;            // not one of ours
    autoConnecting.add(id);
    try {
      statusMessage = `Reconnecting to ${device.name || id}…`;
      await connectToDevice(device);
      rememberDevice(id);
    } catch (e) {
      console.warn('Auto-reconnect failed for', id, e);
    } finally {
      autoConnecting.delete(id);
    }
  }

  async function handleConnect(device: any) {
    // Show the "connecting" card immediately — before the BLE store adds the device.
    intentionalDisconnect.delete(device.deviceId);
    getDeviceSettings(device.deviceId).phase = 'connecting';
    shown[device.deviceId] = device;
    try {
      statusMessage = `Connecting to ${device.name}...`;
      await connectToDevice(device);
      rememberDevice(device.deviceId);
      statusMessage = `Connected to ${device.name}!`;
      // Data loading happens in initConnectedDevice, triggered by reconcileShown once the
      // device lands in the connectedDevices store — same path web auto-connect uses.
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
      if (!get(connectedDevices).has(device.deviceId)) removeShown(device.deviceId); // failed → drop card
    }
  }

  // Single place that loads everything a connected device needs. Called once per
  // device by the reactive block above, no matter which connect path was used.
  async function initConnectedDevice(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    // Reset any stale OTA state from a previous (possibly interrupted) session so the
    // UI never shows a frozen "Updating…"/progress bar after reconnect.
    settings.otaInProgress = false;
    settings.otaStatus = null;
    settings.otaSuccess = false;

    // Core handshake: LED config (the brightness slider gates on it) + device info. A
    // just-connected link can NAK the first reads, so retry a few times before giving up.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        ok = await loadLedConfig(deviceId);
        await loadDeviceInfo(deviceId);
      } catch (e) {
        console.error(`[devices] init read failed for ${deviceId} (attempt ${attempt + 1}):`, e);
      }
      if (!ok && attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    }
    if (!ok) {
      // Couldn't read the device yet — leave it "connecting" (honest) and allow a retry,
      // rather than showing a broken "ready" card with no brightness. Dropping the init
      // marker lets a later reconnect re-run this.
      console.warn(`[devices] ${deviceId} not readable yet — staying 'connecting'`);
      initializedDevices.delete(deviceId);
      return;
    }

    // Core loaded → reveal the full card. Remaining loads refine it in place (best-effort).
    settings.phase = 'ready';
    try { settings.buttonPin = await getButtonPin(deviceId); } catch (e) { console.error('getButtonPin failed', e); }
    try {
      await startButtonEventNotifications(deviceId, (ev) => {
        if (ev === 'next') statusMessage = 'Device → next pattern';
      });
    } catch (e) { console.error('button event subscribe failed', e); }
    try { await checkForUpdateSilently(deviceId); } catch (e) { console.error('update check failed', e); }
    try {
      await startOTAStatusNotifications(deviceId, (status) => {
        settings.otaStatus = status;
        if (status.isError || status.isComplete) settings.otaInProgress = false;
      });
    } catch (e) { console.error('OTA status subscribe failed', e); }
  }

  async function handleDisconnect(deviceId: string) {
    const name = ($connectedDevices.get(deviceId)?.name) ?? shown[deviceId]?.name ?? 'device';
    const wasOta = deviceSettings[deviceId]?.otaInProgress;
    // Reflect disconnected state IMMEDIATELY (no grace period for an intentional disconnect),
    // and stop auto-reconnect from bringing it back.
    intentionalDisconnect.add(deviceId);
    removeShown(deviceId);
    try {
      if (wasOta) await stopOTAStatusNotifications(deviceId);
      await disconnectFromDevice(deviceId);
      forgetDevice(deviceId);
      statusMessage = `Disconnected from ${name}`;
    } catch (error: any) {
      statusMessage = 'Failed to disconnect';
      console.error('Disconnect error:', error);
    }
  }

  async function toggleSettings(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    settings.showSettings = !settings.showSettings;
    
    // Auto-load LED config when settings are shown
    if (settings.showSettings && !settings.ledConfig && !settings.ledConfigLoading) {
      await loadLedConfig(deviceId);
    }
    
  }

  // Per-device rename + button-pin edit buffers (keyed by deviceId).
  let renameValue: Record<string, string> = $state({});
  let buttonPinValue: Record<string, string> = $state({});

  // (Pattern advancement on a device's button double-click is handled on the device
  // itself now — it steps through its own stored library. The app no longer pushes a
  // pattern back in response, so devices keep their independent local selection.)

  // Single "Save Configuration" action. Name, button pin, and LED config are three
  // separate BLE writes, but the user sets them all in one place — so one button pushes
  // whatever's in the form. Everything is validated up front so we never half-apply a
  // bad value, then the writes go out in sequence.
  async function saveConfiguration(deviceId: string) {
    const settings = getDeviceSettings(deviceId);

    // --- Validate ---
    const rawPin = (buttonPinValue[deviceId] ?? settings.buttonPin ?? '').toString().trim();
    const pin = rawPin === '' ? null : parseInt(rawPin, 10);
    if (pin != null && (isNaN(pin) || pin < 0 || pin > 39)) {
      statusMessage = 'Button pin must be 0–39 (or blank for none)';
      return;
    }
    const name = (renameValue[deviceId] ?? settings.deviceInfo?.name ?? '').trim();
    if (settings.ledConfig) {
      for (const strip of settings.ledConfig.strips) {
        if (!strip.numLeds || strip.numLeds < 1) {
          statusMessage = 'Each strip needs a LED count before saving.';
          return;
        }
        if (!strip.width || strip.width < 1 || !strip.height || strip.height < 1) {
          strip.width = Math.ceil(Math.sqrt(strip.numLeds));
          strip.height = Math.ceil(strip.numLeds / strip.width);
        }
      }
    }

    // --- Apply ---
    settings.ledConfigLoading = true;
    try {
      // Name (skip if blank — never clear the device's name).
      if (name) {
        await setDeviceName(deviceId, name);
        if (settings.deviceInfo) settings.deviceInfo.name = name;
        connectedDevices.update(devices => {
          const next = new Map(devices);
          const d = next.get(deviceId);
          if (d) next.set(deviceId, { ...d, name });
          return next;
        });
      }
      await setButtonPin(deviceId, pin);
      settings.buttonPin = pin;
      if (settings.ledConfig) {
        console.log(`[devices] 💾 saveConfiguration → ${deviceId}: ${settings.ledConfig.strips.length} strip(s)`, JSON.parse(JSON.stringify(settings.ledConfig)));
        await setLedConfiguration(deviceId, settings.ledConfig);
      }
      statusMessage = 'Configuration saved';
    } catch (error: any) {
      statusMessage = `Save failed: ${error.message ?? error}`;
      console.error('Save configuration error:', error);
    } finally {
      settings.ledConfigLoading = false;
    }
  }

  async function loadDeviceInfo(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    try {
      settings.deviceInfo = await getDeviceInfo(deviceId);
    } catch (error: any) {
      console.error('Get device info error:', error);
    }
  }

  async function loadLedConfig(deviceId: string): Promise<boolean> {
    const settings = getDeviceSettings(deviceId);
    settings.ledConfigLoading = true;
    console.log(`[devices] loadLedConfig → ${deviceId}`);
    try {
      settings.ledConfig = await getLedConfiguration(deviceId);
      liveBrightness[deviceId] = settings.ledConfig.globalBrightness;
      console.log(`[devices] ✅ config loaded for ${deviceId}: ${settings.ledConfig.strips.length} strip(s), brightness ${settings.ledConfig.globalBrightness}`);
      return true;
    } catch (error: any) {
      console.error(`[devices] ❌ config load FAILED for ${deviceId}:`, error);
      settings.ledConfig = null;
      return false;
    } finally {
      settings.ledConfigLoading = false;
    }
  }

  // Live brightness: applies immediately as the slider moves (no Save button). We
  // throttle the BLE writes so a fast drag doesn't flood the connection, but always
  // send a trailing write so the final resting value lands. The firmware applies it
  // instantly and persists once the slider settles.
  const BRIGHTNESS_MIN_INTERVAL_MS = 40;
  let brightnessThrottle: Record<string, { last: number; timer: any; pending: number | null }> = {};
  // liveBrightness is imported from deviceUiStore (module scope, survives navigation).

  // Manual "install from a file" selections, keyed by deviceId. Kept out of
  // deviceSettings (like liveBrightness) so picking a file doesn't churn the shared
  // settings object. The .sig is optional — without it we flash unsigned.
  type ManualFw = {
    bin?: ArrayBuffer; binName?: string; binSize?: string;
    sig?: ArrayBuffer; sigName?: string;
    error?: string;
  };
  let manualFw: Record<string, ManualFw> = $state({});

  // Read a user-picked firmware/signature file into memory. Works in the iOS WKWebView:
  // a plain <input type="file"> opens the Files/iCloud document picker and we get the
  // bytes via File.arrayBuffer(). We don't restrict `accept` because iOS maps unknown
  // extensions (.bin/.sig) unreliably, which would grey out valid files in the picker.
  async function pickManualFile(deviceId: string, kind: 'bin' | 'sig', event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Read back through the store getter so `mf` is the reactive proxy, not a raw literal
    // (`x ??= {}` evaluates to the RHS object, which Svelte hasn't proxied yet).
    if (!manualFw[deviceId]) manualFw[deviceId] = {};
    const mf = manualFw[deviceId];
    mf.error = undefined;
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      if (kind === 'bin') {
        mf.bin = buf;
        mf.binName = file.name;
        mf.binSize = `${Math.round(buf.byteLength / 1024)} KB`;
      } else {
        if (buf.byteLength !== 64) {
          mf.sig = undefined; mf.sigName = undefined;
          mf.error = `Signature must be exactly 64 bytes (this file is ${buf.byteLength}). Pick the .sig that matches this build, or leave it empty to flash unsigned.`;
          return;
        }
        mf.sig = buf;
        mf.sigName = file.name;
      }
    } catch (e) {
      mf.error = 'Could not read that file.';
    }
  }

  async function handleManualOTAUpdate(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    const mf = manualFw[deviceId];
    if (!mf?.bin) return;
    const unsigned = !mf.sig;
    if (unsigned && !confirm(
      'Flash this firmware WITHOUT a signature check?\n\n' +
      'The device will accept whatever you selected. A wrong, corrupt, or wrong-chip image ' +
      'can leave it needing USB recovery. Only continue with firmware you trust.'
    )) return;

    settings.otaInProgress = true;
    settings.otaSuccess = false;
    settings.showUpdateConfirmation = false;
    settings.otaStatus = { statusMessage: 'Starting manual update...', progress: 0 };

    try {
      await performManualOTAUpdate(
        deviceId,
        mf.bin,
        mf.sig ?? null,
        (status) => {
          settings.otaStatus = status;
          if (status.isError || status.isComplete) settings.otaInProgress = false;
          if (status.isComplete && !status.isError) settings.otaSuccess = true;
        }
      );
      statusMessage = 'Manual firmware update completed.';
      // Clear the picked files, then return to a fresh-load state.
      manualFw[deviceId] = {};
      setTimeout(async () => {
        settings.otaSuccess = false;
        try { await loadDeviceInfo(deviceId); } catch (e) { /* device may still be rebooting */ }
        await checkForUpdateSilently(deviceId);
      }, 4000);
    } catch (error: any) {
      statusMessage = 'Manual firmware update failed';
      console.error('Manual OTA update error:', error);
      settings.otaInProgress = false;
      settings.otaSuccess = false;
    }
  }

  function sendBrightnessThrottled(deviceId: string, value: number) {
    let t = brightnessThrottle[deviceId];
    if (!t) { t = brightnessThrottle[deviceId] = { last: 0, timer: null, pending: null }; }
    const now = performance.now();
    const elapsed = now - t.last;
    if (elapsed >= BRIGHTNESS_MIN_INTERVAL_MS) {
      t.last = now;
      t.pending = null;
      sendBrightnessToDevice(deviceId, value).catch((e) => console.error('Brightness send failed:', e));
    } else {
      t.pending = value;
      if (!t.timer) {
        t.timer = setTimeout(() => {
          t.timer = null;
          if (t!.pending != null) {
            const v = t!.pending; t!.pending = null;
            t!.last = performance.now();
            sendBrightnessToDevice(deviceId, v).catch((e) => console.error('Brightness send failed:', e));
          }
        }, BRIGHTNESS_MIN_INTERVAL_MS - elapsed);
      }
    }
  }

  function handleBrightnessInput(deviceId: string, value: number) {
    const settings = getDeviceSettings(deviceId);
    // Keep ledConfig in sync so a later "Save Configuration" persists the same value.
    if (settings.ledConfig) settings.ledConfig.globalBrightness = value;
    liveBrightness[deviceId] = value; // reactive, drives slider + readout in place
    sendBrightnessThrottled(deviceId, value);
  }

  async function checkForUpdateSilently(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    try {
      // Lazily (re)fetch the registry if the one-shot mount load failed or raced
      // a remount — otherwise an empty registry sticks and we'd wrongly show
      // "no firmware available" even though the live registry is fine.
      if (firmwareRegistry.length === 0) {
        firmwareRegistry = await fetchFirmwareRegistry(espFirmwareRegistryUrl);
      }
      if (firmwareRegistry.length === 0) return;

      // Don't bail when device info is missing — if we can't read the current
      // version we should still surface the latest firmware and offer it. Variant-aware:
      // pass the device's OTA slot so we pick the WiFi build only where it fits, else no-WiFi.
      const choice = resolveFirmware(firmwareRegistry, settings.deviceInfo?.chip, settings.deviceInfo?.hw_ver, settings.deviceInfo?.slot);
      settings.firmwareChoice = choice;
      settings.latestFirmware = choice.recommended;
      // Prefetch the latest image into the offline cache now (while presumably online),
      // so the actual OTA can run even if internet drops later. Best-effort, non-blocking.
      if (settings.latestFirmware) {
        const baseUrl = 'https://chromabay.app';
        prefetchFirmware(
          settings.latestFirmware.version,
          settings.latestFirmware.date,
          `${baseUrl}/${settings.latestFirmware.path}`,
          `${baseUrl}/${settings.latestFirmware.signaturePath}`
        );
      }
      // Offer an update unless we positively know the device is already on the
      // latest version. Unknown current version => offer (better to ask).
      settings.showUpdateConfirmation =
        !!settings.latestFirmware &&
        settings.deviceInfo?.fw_ver !== settings.latestFirmware.version;
    } catch (error: any) {
      console.error('Silent firmware check error:', error);
    }
  }

  async function checkForUpdate(deviceId: string) {
    await checkForUpdateSilently(deviceId);
  }

  async function handlePerformOTAUpdate(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.latestFirmware) return;
    
    settings.otaInProgress = true;
    settings.otaSuccess = false;
    settings.showUpdateConfirmation = false;
    settings.otaStatus = { statusMessage: 'Starting OTA update...', progress: 0 };

    const baseUrl = 'https://chromabay.app';
    const firmwareUrl = `${baseUrl}/${settings.latestFirmware.path}`;
    const signatureUrl = `${baseUrl}/${settings.latestFirmware.signaturePath}`;

    try {
      await performOTAUpdate(
        deviceId,
        firmwareUrl,
        signatureUrl,
        (status) => {
          settings.otaStatus = status;
          if (status.isError || status.isComplete) {
            settings.otaInProgress = false;
          }
          if (status.isComplete && !status.isError) {
            settings.otaSuccess = true;
          }
          // The status callback fires outside Svelte reactivity — reassign so the
          // progress bar and success state actually re-render.
        },
        settings.latestFirmware.version,
        settings.latestFirmware.date
      );
      statusMessage = 'OTA update completed successfully!';
      // Briefly show success, then return to a fresh-load state: re-read device
      // info (now reporting the new version) and re-check for updates.
      setTimeout(async () => {
        settings.otaSuccess = false;
        try { await loadDeviceInfo(deviceId); } catch (e) { /* device may still be rebooting */ }
        await checkForUpdateSilently(deviceId);
      }, 4000);
    } catch (error: any) {
      statusMessage = 'OTA update failed';
      console.error('OTA update error:', error);
      settings.otaInProgress = false;
      settings.otaSuccess = false;
    }
  }

  function addLedStrip(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    
    const newStrip: LedStripConfig = {
      chipset: LedChipsets.WS2812_RGB,
      pin: 13,
      clockPin: 0,     // only used by 4-wire SPI chipsets (APA102/SK9822)
      numLeds: null,   // blank until the user enters a count (width/height auto-fill)
      colorOrder: ColorOrders.GRB,
      rmtChannel: 0,
      width: null,
      height: null,
      orientation: 0
    };
    settings.ledConfig.strips = [...settings.ledConfig.strips, newStrip];
  }

  function removeLedStrip(deviceId: string, index: number) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    settings.ledConfig.strips = settings.ledConfig.strips.filter((_: any, i: number) => i !== index);
  }

  function updateStripOrientation(deviceId: string, stripIndex: number, field: 'rotation' | 'flipH' | 'serpentine', value: number | boolean) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    const strip = settings.ledConfig.strips[stripIndex];
    if (!strip) return;
    
    if (field === 'rotation' && typeof value === 'number') {
      strip.orientation = setRotation(strip.orientation, value);
    } else if (field === 'flipH' && typeof value === 'boolean') {
      strip.orientation = setFlipH(strip.orientation, value);
    } else if (field === 'serpentine' && typeof value === 'boolean') {
      strip.orientation = setSerpentine(strip.orientation, value);
    }
  }
</script>

{#snippet firmwareSection(device: any, settings: any)}
  {@const mf = manualFw[device.deviceId] ?? {}}
  <!-- Connection (BLE/WiFi), sleep timer, startup-test toggle (firmware feat>=2) -->
  <DeviceSettingsPanel deviceId={device.deviceId} deviceInfo={settings.deviceInfo} />
  <!-- Firmware Update -->
  <div class="settings-section">
    <h4>Firmware Update</h4>
    {#if settings.otaInProgress}
      <div class="ota-progress">
        <p>{settings.otaStatus?.statusMessage || 'Updating...'}</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: {settings.otaStatus?.progress ?? 0}%"></div>
        </div>
      </div>
    {:else if settings.otaSuccess}
      <p style="color: #4caf50; font-weight: 600;">✓ Update complete — device restarting…</p>
    {:else}
      {#if settings.latestFirmware && settings.deviceInfo?.fw_ver === settings.latestFirmware.version}
        <p>Firmware is up to date - Current: {settings.deviceInfo.fw_ver}
          {#if settings.firmwareChoice?.recommended?.wifi === false}<span class="fw-variant">(no-Wi-Fi build)</span>{/if}
        </p>
      {:else if settings.latestFirmware}
        <div class="update-available">
          <p>Latest firmware: <strong>{settings.latestFirmware.version}</strong>
            {#if settings.latestFirmware.wifi !== undefined}<span class="fw-variant">{settings.latestFirmware.wifi ? 'Wi-Fi build' : 'no-Wi-Fi build'}</span>{/if}
            (current: {settings.deviceInfo?.fw_ver || 'unknown'})</p>
          <div class="update-actions">
            <button class="btn success" onclick={() => handlePerformOTAUpdate(device.deviceId)}>
              Update to {settings.latestFirmware.version}
            </button>
          </div>
        </div>
      {:else}
        <p>No firmware available in the registry yet.</p>
      {/if}
      {#if settings.firmwareChoice?.wifi && !settings.firmwareChoice.wifiFits}
        <p class="fw-note">📶 A Wi-Fi build is available but is larger than this device's current
          partition, so it can't be installed over the air. Flash it via USB (repartitions the
          device) to enable Wi-Fi / streaming.</p>
      {/if}

      <!-- Manual "install from a file" — a specific ChromaBay build, or another firmware
           (e.g. reverting to WLED). <input type="file"> opens the document picker on iOS. -->
      <details class="manual-fw">
        <summary>Install from a file…</summary>
        <p class="manual-hint">
          Flash a firmware image stored on this phone. Use a matching ChromaBay
          <code>.bin</code> + <code>.sig</code> for a verified install, or just a
          <code>.bin</code> to flash an unsigned image (e.g. going back to WLED). The image
          must be built for this device's chip (ESP32).
        </p>

        <label class="file-row">
          <span>Firmware <code>.bin</code></span>
          <input type="file" onchange={(e) => pickManualFile(device.deviceId, 'bin', e)} />
        </label>
        {#if mf.binName}<p class="file-name">✓ {mf.binName} · {mf.binSize}</p>{/if}

        <label class="file-row">
          <span>Signature <code>.sig</code> <em>(optional)</em></span>
          <input type="file" onchange={(e) => pickManualFile(device.deviceId, 'sig', e)} />
        </label>
        {#if mf.sigName}<p class="file-name">✓ {mf.sigName}</p>{/if}

        {#if mf.error}<p class="fw-note err">{mf.error}</p>{/if}

        {#if mf.bin}
          {#if mf.sig}
            <p class="fw-note ok">Signed install — the device verifies the signature before booting it.</p>
          {:else}
            <p class="fw-note warn">⚠ Unsigned — the signature check is skipped. Only flash firmware you trust; a wrong or corrupt image can require USB recovery.</p>
          {/if}
          <button class="btn success" onclick={() => handleManualOTAUpdate(device.deviceId)}>
            Flash {mf.sig ? 'signed' : 'unsigned'} image
          </button>
        {/if}
      </details>

      <!-- USB flashing + raw image downloads, kept here with the other firmware actions.
           USB flashing needs no BLE connection (it's for blank/other boards) so it also
           lives in the "Install on a device" section below; on the app this shows the
           download links + a "use desktop" note (Web Serial is desktop-Chromium only). -->
      <UsbFlash />
    {/if}
  </div>
{/snippet}

<!-- Shown while a device is connected at the BLE level but still handshaking (reading its
     settings/info). To the user this IS the connection process — no half-populated card. -->
{#snippet connectingCard(device: any)}
  <div class="device-card connected connecting">
    <div class="device-header">
      <h3 class="device-name">{device.name}</h3>
      <div class="connecting-status"><span class="spinner" aria-hidden="true"></span> Connecting… reading settings</div>
      <div class="device-actions">
        <button class="btn danger small" onclick={() => handleDisconnect(device.deviceId)}>Cancel</button>
      </div>
    </div>
  </div>
{/snippet}

<main>
  <header>
    <h1>ChromaBay</h1>
    <p class="company">by ReVolt Labs</p>
  </header>

  <section class="controls">
    <div class="control-buttons">
      {#if !bleEnabled && bleSupported}
        <button class="btn primary" onclick={handleEnableBle}>
          Enable Bluetooth
        </button>
      {/if}
      
      {#if bleEnabled}
        {#if isWeb}
          <button class="btn primary" onclick={handleStartScan}>Select ESP32 Device</button>
        {:else}
          <p class="scan-status">{scanning ? '🔍 Scanning for ESP32s…' : 'Starting scan…'}</p>
        {/if}
      {/if}
    </div>
  </section>

  <!-- Devices List -->
  <section class="devices">
    {#if isWeb}
      <h2>Connected Devices ({shownList.length})</h2>
    {:else}
      <h2>
        {#if shownList.length > 0}
          Devices ({devices.length} found, {shownList.length} connected)
        {:else}
          Found Devices ({devices.length})
        {/if}
      </h2>
    {/if}

    <div class="device-list">
      <!-- Show connected devices first on mobile -->
      {#if !isWeb}
        {#each shownList as device (device.deviceId)}
          {@const settings = deviceSettings[device.deviceId]}
          {#if settings?.phase === 'ready'}
            <div class="device-card connected">
              <div class="device-header">
                <h3 class="device-name">{device.name}</h3>
                {#if settings.ledConfig}
                  <div class="brightness-bar">
                    <span class="bri-label">Brightness</span>
                    <input type="range" min="0" max="255"
                      value={liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}
                      oninput={(e) => handleBrightnessInput(device.deviceId, parseInt(e.currentTarget.value))} />
                    <span class="bri-value">{liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}</span>
                  </div>
                {/if}
                <div class="device-actions">
                  <button class="btn danger small" onclick={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                    Disconnect
                  </button>
                  <button class="btn secondary small" onclick={() => toggleSettings(device.deviceId)}>
                    {settings.showSettings ? 'Hide Settings' : 'Show Settings'}
                  </button>
                </div>
              </div>

            {#if settings.showSettings}
              <div class="device-settings">
                <!-- Device Info -->
                {#if settings.deviceInfo}
                  <div class="settings-section">
                    <h4>Device Information</h4>
                    <div class="rename-row">
                      <label for={`rename-${device.deviceId}`}>Name</label>
                      <input
                        id={`rename-${device.deviceId}`}
                        type="text"
                        maxlength="31"
                        placeholder="Device name"
                        value={renameValue[device.deviceId] ?? settings.deviceInfo.name ?? device.name}
                        oninput={(e) => (renameValue[device.deviceId] = e.currentTarget.value)}
                      />
                    </div>
                    <div class="rename-row">
                      <label for={`btnpin-${device.deviceId}`}>Button pin</label>
                      <input
                        id={`btnpin-${device.deviceId}`}
                        type="number"
                        min="0"
                        max="39"
                        placeholder="none"
                        value={buttonPinValue[device.deviceId] ?? (settings.buttonPin ?? '')}
                        oninput={(e) => (buttonPinValue[device.deviceId] = e.currentTarget.value)}
                      />
                    </div>
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                    </div>
                  </div>
                {/if}

                <!-- LED Configuration -->
                <LedConfigurationComponent 
                  {settings}
                  deviceId={device.deviceId}
                  idPrefix=""
                  onAddStrip={addLedStrip}
                  onRemoveStrip={removeLedStrip}
                  onSaveConfig={saveConfiguration}
                />

                {@render firmwareSection(device, settings)}
              </div>
            {/if}
          </div>
          {:else if settings}
            {@render connectingCard(device)}
          {/if}
        {/each}
      {/if}

      <!-- Available/Found devices -->
      {#if isWeb}
        <!-- Web: Only show connected devices -->
        {#each shownList as device (device.deviceId)}
          {@const settings = deviceSettings[device.deviceId]}
          {#if settings?.phase === 'ready'}
            <div class="device-card connected">
              <div class="device-header">
                <h3 class="device-name">{device.name}</h3>
                {#if settings.ledConfig}
                  <div class="brightness-bar">
                    <span class="bri-label">Brightness</span>
                    <input type="range" min="0" max="255"
                      value={liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}
                      oninput={(e) => handleBrightnessInput(device.deviceId, parseInt(e.currentTarget.value))} />
                    <span class="bri-value">{liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}</span>
                  </div>
                {/if}
                <div class="device-actions">
                  <button class="btn danger small" onclick={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                    Disconnect
                  </button>
                  <button class="btn secondary small" onclick={() => toggleSettings(device.deviceId)}>
                    {settings.showSettings ? 'Hide Settings' : 'Show Settings'}
                  </button>
                </div>
              </div>

            {#if settings.showSettings}
              <div class="device-settings">
                <!-- Device Info -->
                {#if settings.deviceInfo}
                  <div class="settings-section">
                    <h4>Device Information</h4>
                    <div class="rename-row">
                      <label for={`rename-${device.deviceId}`}>Name</label>
                      <input
                        id={`rename-${device.deviceId}`}
                        type="text"
                        maxlength="31"
                        placeholder="Device name"
                        value={renameValue[device.deviceId] ?? settings.deviceInfo.name ?? device.name}
                        oninput={(e) => (renameValue[device.deviceId] = e.currentTarget.value)}
                      />
                    </div>
                    <div class="rename-row">
                      <label for={`btnpin-${device.deviceId}`}>Button pin</label>
                      <input
                        id={`btnpin-${device.deviceId}`}
                        type="number"
                        min="0"
                        max="39"
                        placeholder="none"
                        value={buttonPinValue[device.deviceId] ?? (settings.buttonPin ?? '')}
                        oninput={(e) => (buttonPinValue[device.deviceId] = e.currentTarget.value)}
                      />
                    </div>
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                    </div>
                  </div>
                {/if}

                <!-- LED Configuration -->
                <LedConfigurationComponent 
                  {settings}
                  deviceId={device.deviceId}
                  idPrefix="web"
                  onAddStrip={addLedStrip}
                  onRemoveStrip={removeLedStrip}
                  onSaveConfig={saveConfiguration}
                />

                {@render firmwareSection(device, settings)}
              </div>
            {/if}
          </div>
          {:else if settings}
            {@render connectingCard(device)}
          {/if}
        {/each}
      {:else}
        <!-- Mobile: Show available devices to connect to -->
        {#each devices as device}
          {@const isConnected = !!shown[device.deviceId] || $connectedDevices.has(device.deviceId)}
          
          {#if !isConnected}
            <div class="device-card available">
              <div class="device-header">
                <div class="device-info">
                  <h3>{device.name || 'Unknown Device'}</h3>
                  <p class="device-id">{device.deviceId}</p>
                  <span class="status-badge available">Available</span>
                </div>
                <div class="device-actions">
                  <button class="btn primary small" onclick={() => handleConnect(device)}>
                    Connect
                  </button>
                </div>
              </div>
            </div>
          {/if}
        {/each}
      {/if}
    </div>

  </section>

  <!-- Control devices over WiFi (WebSocket). Only functional on native + local dev. -->
  <WifiDevices />

  <!-- Install / add a device — one compact section; each method expands only when engaged. -->
  <section class="install-section">
    <h2 class="install-title">Install on a device</h2>
    <p class="install-intro">Put ChromaBay on new hardware, or convert a device running WLED.</p>
    <UsbFlash />
    <WledConvert />
  </section>

  <!-- Status section moved to bottom and made smaller -->
  <section class="status compact">
    <div class="status-indicators">
      <div class="indicator" class:active={bleSupported}>
        <span class="icon">📡</span>
        <span>BLE</span>
      </div>
      <div class="indicator" class:active={bleEnabled}>
        <span class="icon">🔘</span>
        <span>Enabled</span>
      </div>
      <div class="indicator" class:active={scanning}>
        <span class="icon">🔍</span>
        <span>Scanning</span>
      </div>
      <div class="indicator" class:active={shownList.length > 0}>
        <span class="icon">🔗</span>
        <span>Connected ({shownList.length})</span>
      </div>
    </div>
    
    <div class="status-message">
      {statusMessage}
    </div>
  </section>

  <footer>
    <div class="build-info">
      <p>📦 Version: <code>{buildInfo.version}</code> • <code>{buildInfo.commitHash.slice(0, 7)}</code> • 🕒 {formatBuildDate(buildInfo.buildDate)}</p>
    </div>
  </footer>
</main>

<style>
  main {
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
    min-height: 100vh;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  header {
    text-align: center;
    margin-bottom: 2rem;
  }

  h1 {
    font-size: 3rem;
    margin: 0;
    background: linear-gradient(45deg, #fff, #e0e7ff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .subtitle {
    font-size: 1.2rem;
    margin: 0.5rem 0;
    opacity: 0.9;
  }

  .company {
    font-size: 1rem;
    margin: 0;
    opacity: 0.7;
  }

  .controls {
    margin-bottom: 2rem;
  }

  .control-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .devices {
    margin-bottom: 3rem;
  }

  .devices h2 {
    margin-bottom: 1.5rem;
    text-align: center;
  }

  .device-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .device-card {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    overflow: hidden;
    transition: all 0.3s ease;
  }

  .device-card.connected {
    border-color: rgba(34, 197, 94, 0.5);
    box-shadow: 0 0 10px rgba(34, 197, 94, 0.2);
  }

  .device-card.available {
    border-color: rgba(59, 130, 246, 0.5);
  }

  /* Handshaking state: connected at the BLE level, still reading settings. */
  .device-card.connecting {
    border-color: rgba(234, 179, 8, 0.5);
    box-shadow: 0 0 10px rgba(234, 179, 8, 0.15);
  }
  .connecting-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    opacity: 0.8;
  }
  .spinner {
    width: 0.9rem;
    height: 0.9rem;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: rgba(234, 179, 8, 0.9);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .device-header {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1.25rem 1.5rem;
  }

  /* Connected card: name → brightness → actions, stacked. */
  .device-name {
    margin: 0;
    font-size: 1.3rem;
    color: white;
  }

  /* Always-visible live brightness slider (applies immediately, no Save). */
  .brightness-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0;
  }

  .brightness-bar .bri-label {
    font-size: 0.85rem;
    opacity: 0.85;
    min-width: 5rem;
  }

  .brightness-bar .bri-value {
    min-width: 2.5rem;
    text-align: right;
    font-family: monospace;
    font-size: 0.85rem;
    opacity: 0.85;
  }

  .brightness-bar input[type="range"] {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.3);
    outline: none;
    cursor: pointer;
  }

  .brightness-bar input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .brightness-bar input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
    border: none;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .device-info h3 {
    margin: 0 0 0.5rem 0;
    color: white;
  }

  .device-id {
    margin: 0.25rem 0;
    font-size: 0.8rem;
    opacity: 0.7;
    font-family: monospace;
  }

  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 0.5rem;
    display: inline-block;
  }

  .status-badge.available {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.5);
  }

  .device-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .device-settings {
    padding: 1.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.05);
  }

  /* Sections of one device blob: a header + content divided by a rule, not nested cards. */
  .settings-section {
    margin: 0;
    padding: 1.25rem 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }

  .settings-section:first-child {
    padding-top: 0;
    border-top: none;
  }

  .settings-section h4 {
    margin: 0 0 1rem 0;
    font-size: 1.05rem;
    opacity: 0.95;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .rename-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .rename-row label {
    flex: 0 0 auto;
    font-size: 0.9rem;
    opacity: 0.85;
  }

  /* Input takes the rest of the line once the label has its space. */
  .rename-row input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: white;
    font-size: 0.9rem;
  }



  .ota-progress {
    margin: 1rem 0;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 0.5rem;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #10b981, #34d399);
    transition: width 0.3s ease;
  }

  .update-available {
    margin: 1rem 0;
    padding: 1rem;
    background: rgba(34, 197, 94, 0.1);
    border-radius: 8px;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .update-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  /* Manual "install from a file" */
  .manual-fw {
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
  }
  .manual-fw summary {
    cursor: pointer;
    font-weight: 600;
    opacity: 0.9;
  }
  .manual-hint {
    font-size: 0.82rem;
    opacity: 0.7;
    line-height: 1.45;
    margin: 0.6rem 0 0.9rem;
  }
  .manual-fw code {
    background: rgba(255, 255, 255, 0.12);
    padding: 0.02rem 0.28rem;
    border-radius: 4px;
    font-size: 0.9em;
  }
  .file-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.6rem 0;
    font-size: 0.85rem;
  }
  .file-row span { opacity: 0.9; }
  .file-row em { opacity: 0.6; font-style: normal; }
  .file-row input[type="file"] { font-size: 0.8rem; }
  .file-name {
    font-size: 0.8rem;
    color: #4ade80;
    margin: 0.1rem 0 0.4rem;
    word-break: break-all;
  }
  .fw-note {
    font-size: 0.82rem;
    line-height: 1.4;
    margin: 0.5rem 0;
  }
  .fw-note.ok { color: #93c5fd; }
  .fw-note.warn { color: #fbbf24; }
  .fw-note.err { color: #f87171; }

  /* Compact status section */
  .status.compact {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 2rem;
  }

  .status-indicators {
    display: flex;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.8rem;
    min-width: 80px;
    justify-content: center;
  }

  .indicator.active {
    background: rgba(34, 197, 94, 0.2);
    border-color: rgba(34, 197, 94, 0.5);
  }

  .icon {
    font-size: 1rem;
  }

  .status-message {
    text-align: center;
    font-size: 0.9rem;
    opacity: 0.8;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }

  .btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .btn.primary {
    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
    color: white;
  }

  .btn.secondary {
    background: rgba(255, 255, 255, 0.1);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
  }

  .btn.danger {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    color: white;
  }

  .btn.success {
    background: linear-gradient(135deg, #10b981, #059669);
    color: white;
  }

  .btn.small {
    padding: 0.5rem 1rem;
    font-size: 0.8rem;
  }

  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .install-section {
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
  }
  .install-title {
    margin: 0;
    font-size: 1.15rem;
  }
  .install-intro {
    margin: 0.35rem 0 0.5rem;
    font-size: 0.9rem;
    opacity: 0.75;
  }

  footer {
    text-align: center;
    margin-top: 2rem;
    opacity: 0.7;
    font-size: 0.9rem;
  }

  .build-info {
    margin-top: 0.5rem;
    font-size: 0.8rem;
  }

  .build-info code {
    background: rgba(255, 255, 255, 0.1);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  }



  @media (max-width: 768px) {
    main {
      padding: 1rem;
    }

    h1 {
      font-size: 2rem;
    }

    .control-buttons {
      flex-direction: column;
      align-items: center;
    }

    .btn {
      width: 100%;
      max-width: 300px;
    }

    .device-header {
      flex-direction: column;
      gap: 1rem;
      align-items: stretch;
    }

    .device-actions {
      justify-content: stretch;
    }

    .device-actions .btn {
      flex: 1;
    }

    .status-indicators {
      justify-content: center;
    }


  }
</style>
