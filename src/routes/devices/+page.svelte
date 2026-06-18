<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { dev } from '$app/environment';
  import { 
    initBle, 
    isBleEnabled, 
    enableBle, 
    startScan, 
    stopScan,
    startBleStateNotifications,
    connectToDevice,
    disconnectFromDevice,
    isDeviceConnected,
    discoverServices,
    // OTA Imports
    getDeviceInfo,
    fetchFirmwareRegistry,
    findLatestFirmware,
    performOTAUpdate,
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
  import LedConfigurationComponent from '$lib/components/LedConfiguration.svelte';

  let bleSupported = $state(false);
  let bleEnabled = $state(false);
  let scanning = $state(false);
  let devices: any[] = $state([]);
  let statusMessage = $state('');
  let isWeb = $state(false);

  // Device states - keyed by deviceId. $state is deeply reactive (proxied), so
  // mutating deviceSettings[id].foo updates the UI in place — no manual reassign.
  let deviceSettings: Record<string, {
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
    buttonPin: number | null;
  }> = $state({});

  // Connected devices from store
  const connectedDevicesList = $derived(getConnectedDevicesList($connectedDevices));

  // Load per-device data as a REACTION to a device being connected, regardless of
  // HOW it connected (native button, web auto-connect, or reconnect after reboot).
  // Previously each connect path initialized state differently, so e.g. web
  // auto-connected devices never loaded their LED config until Settings was opened.
  let initializedDevices = new Set<string>();
  $effect(() => {
    console.log(`[devices] connected list changed → ${connectedDevicesList.length} device(s):`, connectedDevicesList.map(d => d.deviceId));
    for (const d of connectedDevicesList) {
      if (!initializedDevices.has(d.deviceId)) {
        initializedDevices.add(d.deviceId);
        console.log(`[devices] initializing ${d.deviceId}`);
        // untrack: initConnectedDevice reads/writes deviceSettings; we only want this
        // effect to re-run on connectedDevicesList changes, not on every state edit.
        untrack(() => initConnectedDevice(d.deviceId));
      }
    }
  });

  let firmwareRegistry: FirmwareRegistryEntry[] = $state([]);
  let espFirmwareRegistryUrl = "https://hobzcalvin.github.io/chromabay/firmware/esp32/esp32_firmware_registry.json";

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
    statusMessage = isWeb ? 'Opening device picker...' : 'Scanning for devices...';
    
    startScan((result) => {
      const existingDevice = devices.find(d => d.deviceId === result.device.deviceId);
      if (!existingDevice) {
        devices = [...devices, result.device];
      }
      
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

  async function handleConnect(device: any) {
    try {
      statusMessage = `Connecting to ${device.name}...`;
      await connectToDevice(device);
      statusMessage = `Connected to ${device.name}!`;
      // Data loading happens in initConnectedDevice, triggered reactively once the
      // device lands in the connectedDevices store — same path web auto-connect uses.
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
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
    try {
      // Load the LED config FIRST: the always-visible brightness slider depends only
      // on it, so this is what gates the slider appearing. Device info / update check
      // can follow. (Sequential, not parallel — concurrent GATT reads can error.)
      await loadLedConfig(deviceId);
      await loadDeviceInfo(deviceId);
      try { settings.buttonPin = await getButtonPin(deviceId); } catch (e) { console.error('getButtonPin failed', e); }
      await checkForUpdateSilently(deviceId);
      await startOTAStatusNotifications(deviceId, (status) => {
        settings.otaStatus = status;
        if (status.isError || status.isComplete) {
          settings.otaInProgress = false;
        }
      });
    } catch (error: any) {
      console.error(`Failed to initialize connected device ${deviceId}:`, error);
    }
  }

  async function handleDisconnect(deviceId: string) {
    const device = $connectedDevices.get(deviceId);
    if (!device) return;
    
    try {
      const settings = getDeviceSettings(deviceId);
      if (settings.otaInProgress) {
        await stopOTAStatusNotifications(deviceId);
      }
      await disconnectFromDevice(deviceId);
      statusMessage = `Disconnected from ${device.name}`;
      
      // Clear device settings + init marker so a future reconnect re-initializes.
      delete deviceSettings[deviceId];
      initializedDevices.delete(deviceId);
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

  async function handleSetButtonPin(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    const raw = (buttonPinValue[deviceId] ?? '').trim();
    const pin = raw === '' ? null : parseInt(raw, 10);
    if (pin != null && (isNaN(pin) || pin < 0 || pin > 39)) {
      statusMessage = 'Button pin must be 0–39 (or blank for none)';
      return;
    }
    try {
      await setButtonPin(deviceId, pin);
      settings.buttonPin = pin;
      statusMessage = pin == null ? 'Button disabled' : `Button set to GPIO ${pin}`;
    } catch (error: any) {
      statusMessage = `Set button failed: ${error.message ?? error}`;
      console.error('Set button pin error:', error);
    }
  }

  async function handleRename(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    const name = (renameValue[deviceId] ?? settings.deviceInfo?.name ?? '').trim();
    if (!name) { statusMessage = 'Enter a name first'; return; }
    try {
      await setDeviceName(deviceId, name);
      // Reflect immediately: device info + the card's displayed name (no reconnect).
      if (settings.deviceInfo) settings.deviceInfo.name = name;
      connectedDevices.update(devices => {
        const next = new Map(devices);
        const d = next.get(deviceId);
        if (d) next.set(deviceId, { ...d, name });
        return next;
      });
      statusMessage = `Renamed to "${name}"`;
    } catch (error: any) {
      statusMessage = `Rename failed: ${error.message ?? error}`;
      console.error('Rename error:', error);
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

  async function loadLedConfig(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    settings.ledConfigLoading = true;
    console.log(`[devices] loadLedConfig → ${deviceId}`);
    try {
      settings.ledConfig = await getLedConfiguration(deviceId);
      liveBrightness[deviceId] = settings.ledConfig.globalBrightness;
      console.log(`[devices] ✅ config loaded for ${deviceId}: ${settings.ledConfig.strips.length} strip(s), brightness ${settings.ledConfig.globalBrightness}`);
    } catch (error: any) {
      console.error(`[devices] ❌ config load FAILED for ${deviceId}:`, error);
      settings.ledConfig = null;
    } finally {
      settings.ledConfigLoading = false;
    }
  }

  async function saveLedConfig(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;

    // Validate + normalize each strip: every strip needs a LED count, and width/height
    // are derived to cover it (square-ish) if the user left them blank. Guarantees the
    // firmware always receives valid integers.
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

    settings.ledConfigLoading = true;
    console.log(`[devices] 💾 saveLedConfig → ${deviceId}: SENDING ${settings.ledConfig.strips.length} strip(s)`, JSON.parse(JSON.stringify(settings.ledConfig)));
    try {
      await setLedConfiguration(deviceId, settings.ledConfig);
      statusMessage = 'LED configuration updated successfully';
    } catch (error: any) {
      statusMessage = 'Failed to update LED configuration';
      console.error('Set LED config error:', error);
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
  // Slider value lives here, NOT in deviceSettings, so dragging it doesn't churn the
  // shared device-settings object on every input event — the slider updates in place.
  let liveBrightness: Record<string, number> = $state({});

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
      // version we should still surface the latest firmware and offer it.
      settings.latestFirmware = findLatestFirmware(firmwareRegistry, settings.deviceInfo?.hw_ver);
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

    const baseUrl = 'https://hobzcalvin.github.io/chromabay';
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
        }
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

<main>
  <header>
    <h1>🔵 ChromaBay</h1>
    <p class="subtitle">ESP32 Bluetooth Low Energy Monitor</p>
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
      <h2>Connected Devices ({connectedDevicesList.length})</h2>
    {:else}
      <h2>
        {#if connectedDevicesList.length > 0}
          Devices ({devices.length} found, {connectedDevicesList.length} connected)
        {:else}
          Found Devices ({devices.length})
        {/if}
      </h2>
    {/if}

    <div class="device-list">
      <!-- Show connected devices first on mobile -->
      {#if !isWeb}
        {#each connectedDevicesList as device (device.deviceId)}
          {@const settings = deviceSettings[device.deviceId]}
          {#if settings}
            <div class="device-card connected">
              <div class="device-header">
              <div class="device-info">
                <h3>{device.name}</h3>
                <p class="device-id">{device.deviceId}</p>
                {#if settings.deviceInfo}
                  <p class="fw-version">FW: {settings.deviceInfo.fw_ver}</p>
                {/if}
                <span class="status-badge connected">Connected</span>
              </div>
              <div class="device-actions">
                <button class="btn danger small" onclick={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                  Disconnect
                </button>
                <button class="btn secondary small" onclick={() => toggleSettings(device.deviceId)}>
                  {settings.showSettings ? 'Hide Settings' : 'Show Settings'}
                </button>
              </div>
            </div>

            {#if settings.ledConfig}
              <div class="brightness-bar">
                <span class="bri-label">Brightness</span>
                <input type="range" min="0" max="255"
                  value={liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}
                  oninput={(e) => handleBrightnessInput(device.deviceId, parseInt(e.currentTarget.value))} />
                <span class="bri-value">{liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}</span>
              </div>
            {/if}

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
                      <button class="btn primary small" onclick={() => handleRename(device.deviceId)}>Rename</button>
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
                      <button class="btn primary small" onclick={() => handleSetButtonPin(device.deviceId)}>Set</button>
                    </div>
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                      <div><strong>Hardware:</strong> {settings.deviceInfo.hw_ver}</div>
                      {#if settings.deviceInfo.heap !== undefined}
                        <div><strong>Free Heap:</strong> {settings.deviceInfo.heap} bytes</div>
                      {/if}
                    </div>
                    <button class="btn secondary small" onclick={() => loadDeviceInfo(device.deviceId)}>
                      Refresh Info
                    </button>
                  </div>
                {/if}

                <!-- LED Configuration -->
                <LedConfigurationComponent 
                  {settings}
                  deviceId={device.deviceId}
                  idPrefix=""
                  onAddStrip={addLedStrip}
                  onRemoveStrip={removeLedStrip}
                  onSaveConfig={saveLedConfig}
                />

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
                  {:else if settings.latestFirmware && settings.deviceInfo?.fw_ver === settings.latestFirmware.version}
                    <p>Firmware is up to date - Current: {settings.deviceInfo.fw_ver}</p>
                  {:else if settings.latestFirmware}
                    <div class="update-available">
                      <p>Latest firmware: <strong>{settings.latestFirmware.version}</strong> (current: {settings.deviceInfo?.fw_ver || 'unknown'})</p>
                      <div class="update-actions">
                        <button class="btn success" onclick={() => handlePerformOTAUpdate(device.deviceId)}>
                          Update to {settings.latestFirmware.version}
                        </button>
                      </div>
                    </div>
                  {:else}
                    <p>No firmware available in the registry yet.</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
          {/if}
        {/each}
      {/if}

      <!-- Available/Found devices -->
      {#if isWeb}
        <!-- Web: Only show connected devices -->
        {#each connectedDevicesList as device (device.deviceId)}
          {@const settings = deviceSettings[device.deviceId]}
          {#if settings}
            <div class="device-card connected">
              <div class="device-header">
                <div class="device-info">
                  <h3>{device.name}</h3>
                  <p class="device-id">{device.deviceId}</p>
                  {#if settings.deviceInfo}
                    <p class="fw-version">FW: {settings.deviceInfo.fw_ver}</p>
                  {/if}
                  <span class="status-badge connected">Connected</span>
                </div>
                <div class="device-actions">
                  <button class="btn danger small" onclick={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                    Disconnect
                  </button>
                  <button class="btn secondary small" onclick={() => toggleSettings(device.deviceId)}>
                    {settings.showSettings ? 'Hide Settings' : 'Show Settings'}
                  </button>
                </div>
              </div>

            {#if settings.ledConfig}
              <div class="brightness-bar">
                <span class="bri-label">Brightness</span>
                <input type="range" min="0" max="255"
                  value={liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}
                  oninput={(e) => handleBrightnessInput(device.deviceId, parseInt(e.currentTarget.value))} />
                <span class="bri-value">{liveBrightness[device.deviceId] ?? settings.ledConfig.globalBrightness}</span>
              </div>
            {/if}

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
                      <button class="btn primary small" onclick={() => handleRename(device.deviceId)}>Rename</button>
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
                      <button class="btn primary small" onclick={() => handleSetButtonPin(device.deviceId)}>Set</button>
                    </div>
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                      <div><strong>Hardware:</strong> {settings.deviceInfo.hw_ver}</div>
                      {#if settings.deviceInfo.heap !== undefined}
                        <div><strong>Free Heap:</strong> {settings.deviceInfo.heap} bytes</div>
                      {/if}
                    </div>
                    <button class="btn secondary small" onclick={() => loadDeviceInfo(device.deviceId)}>
                      Refresh Info
                    </button>
                  </div>
                {/if}

                <!-- LED Configuration -->
                <LedConfigurationComponent 
                  {settings}
                  deviceId={device.deviceId}
                  idPrefix="web"
                  onAddStrip={addLedStrip}
                  onRemoveStrip={removeLedStrip}
                  onSaveConfig={saveLedConfig}
                />

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
                  {:else if settings.latestFirmware && settings.deviceInfo?.fw_ver === settings.latestFirmware.version}
                    <p>Firmware is up to date - Current: {settings.deviceInfo.fw_ver}</p>
                  {:else if settings.latestFirmware}
                    <div class="update-available">
                      <p>Latest firmware: <strong>{settings.latestFirmware.version}</strong> (current: {settings.deviceInfo?.fw_ver || 'unknown'})</p>
                      <div class="update-actions">
                        <button class="btn success" onclick={() => handlePerformOTAUpdate(device.deviceId)}>
                          Update to {settings.latestFirmware.version}
                        </button>
                      </div>
                    </div>
                  {:else}
                    <p>No firmware available in the registry yet.</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
          {/if}
        {/each}
      {:else}
        <!-- Mobile: Show available devices to connect to -->
        {#each devices as device}
          {@const isConnected = $connectedDevices.has(device.deviceId)}
          
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
      <div class="indicator" class:active={connectedDevicesList.length > 0}>
        <span class="icon">🔗</span>
        <span>Connected ({connectedDevicesList.length})</span>
      </div>
    </div>
    
    <div class="status-message">
      {statusMessage}
    </div>
  </section>

  <footer>
    <p>Built with SvelteKit + Capacitor + Bluetooth LE</p>
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

  .device-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
  }

  /* Always-visible live brightness slider (applies immediately, no Save). */
  .brightness-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 1.5rem 1.25rem;
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

  .fw-version {
    margin: 0.25rem 0;
    font-size: 0.8rem;
    opacity: 0.8;
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

  .status-badge.connected {
    background: rgba(34, 197, 94, 0.2);
    color: #10b981;
    border: 1px solid rgba(34, 197, 94, 0.5);
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

  .settings-section {
    margin-bottom: 2rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .settings-section h4 {
    margin: 0 0 1rem 0;
    font-size: 1.1rem;
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
    font-size: 0.9rem;
    opacity: 0.85;
  }

  .rename-row input {
    min-width: 0;
    padding: 0.4rem 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: white;
    font-size: 0.9rem;
  }

  /* Name: roughly the max allowed length (31), not full width. */
  .rename-row input[type="text"] {
    width: 22ch;
    max-width: 100%;
  }

  /* Button pin: a small number field like the strip Pin input. */
  .rename-row input[type="number"] {
    width: 5em;
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
