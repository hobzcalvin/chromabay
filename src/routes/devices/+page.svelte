<script lang="ts">
  import { onMount } from 'svelte';
  import { dev } from '$app/environment';
  import { 
    initBle, 
    isBleEnabled, 
    enableBle, 
    startScan, 
    stopScan,
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

  let bleSupported = false;
  let bleEnabled = false;
  let scanning = false;
  let devices: any[] = [];
  let statusMessage = '';
  let isWeb = false;

  // Device states - keyed by deviceId
  let deviceSettings: Record<string, {
    showSettings: boolean;
    ledConfig: LedConfiguration | null;
    ledConfigLoading: boolean;
    deviceInfo: DeviceInfo | null;
    otaStatus: OTAUpdateStatus | null;
    otaInProgress: boolean;
    checkingForUpdate: boolean;
    showUpdateConfirmation: boolean;
    latestFirmware: FirmwareRegistryEntry | null;
  }> = {};

  // Connected devices from store
  $: connectedDevicesList = getConnectedDevicesList($connectedDevices);

  let firmwareRegistry: FirmwareRegistryEntry[] = [];
  let espFirmwareRegistryUrl = "https://hobzcalvin.github.io/blumon/firmware/esp32/esp32_firmware_registry.json";

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
    buildDate: import.meta.env.VITE_BUILD_DATE || new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
    commitMessage: import.meta.env.VITE_COMMIT_MESSAGE || 'Development build'
  };

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
    
    // Initialize firmware registry
    await initializeFirmwareRegistry();
    
    // CREATE FAKE DEVICE FOR TESTING (dev mode only)
    if (dev) {
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
          otaStatus: null
        };
        
        deviceSettings[fakeDeviceId] = fakeSettings;
        deviceSettings = { ...deviceSettings };
        
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
        checkingForUpdate: false,
        showUpdateConfirmation: false,
        latestFirmware: null
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
      scanning = false;
      if (!isWeb) {
        statusMessage = `Scan complete. Found ${devices.length} device(s).`;
      }
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
      
      // Auto-load device info and LED config
      const settings = getDeviceSettings(device.deviceId);
      await loadDeviceInfo(device.deviceId);
      await loadLedConfig(device.deviceId);
      // Auto-check for firmware updates
      await checkForUpdateSilently(device.deviceId);
      
      await startOTAStatusNotifications(device.deviceId, (status) => {
        settings.otaStatus = status;
        if (status.isError || status.isComplete) {
          settings.otaInProgress = false;
        }
        deviceSettings = { ...deviceSettings };
      });
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
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
      
      // Clear device settings
      delete deviceSettings[deviceId];
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
    
    deviceSettings = { ...deviceSettings };
  }

  async function loadDeviceInfo(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    try {
      settings.deviceInfo = await getDeviceInfo(deviceId);
      // Force reactivity update
      deviceSettings = { ...deviceSettings };
    } catch (error: any) {
      console.error('Get device info error:', error);
    }
  }

  async function loadLedConfig(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    settings.ledConfigLoading = true;
    try {
      settings.ledConfig = await getLedConfiguration(deviceId);
      // Force reactivity update
      deviceSettings = { ...deviceSettings };
    } catch (error: any) {
      console.error('Get LED config error:', error);
      settings.ledConfig = null;
    } finally {
      settings.ledConfigLoading = false;
      // Force reactivity update
      deviceSettings = { ...deviceSettings };
    }
  }

  async function saveLedConfig(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    
    settings.ledConfigLoading = true;
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

  async function checkForUpdateSilently(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.deviceInfo || firmwareRegistry.length === 0) return;
    
    try {
      settings.latestFirmware = findLatestFirmware(firmwareRegistry, settings.deviceInfo.hw_ver);
      if (settings.latestFirmware && settings.latestFirmware.version !== settings.deviceInfo.fw_ver) {
        settings.showUpdateConfirmation = true;
      }
      deviceSettings = { ...deviceSettings };
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
    settings.showUpdateConfirmation = false;
    settings.otaStatus = { statusMessage: 'Starting OTA update...', progress: 0 };
    
    const baseUrl = 'https://hobzcalvin.github.io/blumon';
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
        }
      );
      statusMessage = 'OTA update completed successfully!';
    } catch (error: any) {
      statusMessage = 'OTA update failed';
      console.error('OTA update error:', error);
      settings.otaInProgress = false;
    }
  }

  function addLedStrip(deviceId: string) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    
    const newStrip: LedStripConfig = {
      chipset: LedChipsets.WS2812_RGB,
      pin: 13,
      numLeds: 100,
      colorOrder: ColorOrders.GRB,
      rmtChannel: 0,
      width: 0,
      height: 0,
      orientation: 0
    };
    settings.ledConfig.strips = [...settings.ledConfig.strips, newStrip];
    deviceSettings = { ...deviceSettings };
  }

  function removeLedStrip(deviceId: string, index: number) {
    const settings = getDeviceSettings(deviceId);
    if (!settings.ledConfig) return;
    settings.ledConfig.strips = settings.ledConfig.strips.filter((_: any, i: number) => i !== index);
    deviceSettings = { ...deviceSettings };
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
    deviceSettings = { ...deviceSettings };
  }
</script>

<main>
  <header>
    <h1>🔵 Blumon</h1>
    <p class="subtitle">ESP32 Bluetooth Low Energy Monitor</p>
    <p class="company">by ReVolt Labs</p>
  </header>

  <section class="controls">
    <div class="control-buttons">
      {#if !bleEnabled && bleSupported}
        <button class="btn primary" on:click={handleEnableBle}>
          Enable Bluetooth
        </button>
      {/if}
      
      {#if bleEnabled}
        {#if !scanning}
          <button class="btn primary" on:click={handleStartScan}>
            {isWeb ? 'Select ESP32 Device' : 'Scan for ESP32s'}
          </button>
        {:else if !isWeb}
          <button class="btn secondary" on:click={handleStopScan}>
            Stop Scanning
          </button>
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
          {#key deviceSettings}
            {@const settings = getDeviceSettings(device.deviceId)}
            
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
                <button class="btn danger small" on:click={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                  Disconnect
                </button>
                <button class="btn secondary small" on:click={() => toggleSettings(device.deviceId)}>
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
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                      <div><strong>Hardware:</strong> {settings.deviceInfo.hw_ver}</div>
                      {#if settings.deviceInfo.heap !== undefined}
                        <div><strong>Free Heap:</strong> {settings.deviceInfo.heap} bytes</div>
                      {/if}
                    </div>
                    <button class="btn secondary small" on:click={() => loadDeviceInfo(device.deviceId)}>
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
                  onReactivityUpdate={() => { deviceSettings = { ...deviceSettings }; }}
                />

                <!-- Firmware Update -->
                <div class="settings-section">
                  <h4>Firmware Update</h4>
                  {#if settings.otaInProgress}
                    <div class="ota-progress">
                      <p>{settings.otaStatus?.statusMessage || 'Updating...'}</p>
                      {#if settings.otaStatus?.progress !== undefined}
                        <div class="progress-bar">
                          <div class="progress-fill" style="width: {settings.otaStatus.progress}%"></div>
                        </div>
                      {/if}
                    </div>
                  {:else if settings.showUpdateConfirmation && settings.latestFirmware}
                    <div class="update-available">
                      <p>New firmware available: <strong>{settings.latestFirmware.version}</strong></p>
                      <div class="update-actions">
                        <button class="btn success" on:click={() => handlePerformOTAUpdate(device.deviceId)}>
                          Update to {settings.latestFirmware.version}
                        </button>
                        <button class="btn secondary small" on:click={() => settings.showUpdateConfirmation = false}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  {:else}
                    <p>Firmware is up to date - Current: {settings.deviceInfo?.fw_ver || 'Unknown'}</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
          {/key}
        {/each}
      {/if}

      <!-- Available/Found devices -->
      {#if isWeb}
        <!-- Web: Only show connected devices -->
        {#each connectedDevicesList as device (device.deviceId)}
          {#key deviceSettings}
            {@const settings = getDeviceSettings(device.deviceId)}
            
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
                  <button class="btn danger small" on:click={() => handleDisconnect(device.deviceId)} disabled={settings.otaInProgress}>
                    Disconnect
                  </button>
                  <button class="btn secondary small" on:click={() => toggleSettings(device.deviceId)}>
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
                    <div class="info-grid">
                      <div><strong>Firmware:</strong> {settings.deviceInfo.fw_ver}</div>
                      <div><strong>Hardware:</strong> {settings.deviceInfo.hw_ver}</div>
                      {#if settings.deviceInfo.heap !== undefined}
                        <div><strong>Free Heap:</strong> {settings.deviceInfo.heap} bytes</div>
                      {/if}
                    </div>
                    <button class="btn secondary small" on:click={() => loadDeviceInfo(device.deviceId)}>
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
                  onReactivityUpdate={() => { deviceSettings = { ...deviceSettings }; }}
                />

                <!-- Firmware Update -->
                <div class="settings-section">
                  <h4>Firmware Update</h4>
                  {#if settings.otaInProgress}
                    <div class="ota-progress">
                      <p>{settings.otaStatus?.statusMessage || 'Updating...'}</p>
                      {#if settings.otaStatus?.progress !== undefined}
                        <div class="progress-bar">
                          <div class="progress-fill" style="width: {settings.otaStatus.progress}%"></div>
                        </div>
                      {/if}
                    </div>
                  {:else if settings.showUpdateConfirmation && settings.latestFirmware}
                    <div class="update-available">
                      <p>New firmware available: <strong>{settings.latestFirmware.version}</strong></p>
                      <div class="update-actions">
                        <button class="btn success" on:click={() => handlePerformOTAUpdate(device.deviceId)}>
                          Update to {settings.latestFirmware.version}
                        </button>
                        <button class="btn secondary small" on:click={() => settings.showUpdateConfirmation = false}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  {:else}
                    <p>Firmware is up to date - Current: {settings.deviceInfo?.fw_ver || 'Unknown'}</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
          {/key}
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
                  <button class="btn primary small" on:click={() => handleConnect(device)}>
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
      <p>📦 Version: <code>{buildInfo.version}</code> • 🕒 {buildInfo.buildDate}</p>
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
