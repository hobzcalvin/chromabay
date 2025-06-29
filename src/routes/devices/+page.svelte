<script lang="ts">
  import { onMount } from 'svelte';
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
    readCharacteristic,
    writeCharacteristic,
    startNotifications,
    stopNotifications,
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
    // Removed internal constants like LED_SERVICE_UUID as they are not exported from ble.ts
  } from '$lib/ble';
  import { Capacitor } from '@capacitor/core';
  import { connectedDevices, activeDeviceId, setActiveDevice, getActiveDevice, getConnectedDevicesList, type ConnectedDevice } from '$lib/stores/deviceStore';

  let bleSupported = false;
  let bleEnabled = false;
  let scanning = false;
  let devices: any[] = [];
  let statusMessage = '';
  let isWeb = false;
  let services: any[] = [];
  let notifications: string[] = [];
  let writeData = '';

  // Device state from store
  $: activeDevice = getActiveDevice($connectedDevices, $activeDeviceId);
  $: connectedDevicesList = getConnectedDevicesList($connectedDevices);
  
  // OTA State
  let firmwareRegistry: FirmwareRegistryEntry[] = [];
  let latestFirmware: FirmwareRegistryEntry | null = null;
  let otaStatus: OTAUpdateStatus | null = null;
  let otaInProgress = false;
  let checkingForUpdate = false;
  let showUpdateConfirmation = false;
  let espFirmwareRegistryUrl = "https://hobzcalvin.github.io/blumon/firmware/esp32/esp32_firmware_registry.json"; // Always use production GitHub Pages

  // LED Configuration State
  let ledConfig: LedConfiguration | null = null;
  let showLedConfig = false;
  let ledConfigLoading = false;

  // Build information from environment variables
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
  });

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
        setActiveDevice(result.device.deviceId);
        statusMessage = `Connected to ${result.device.name}! Discovering services...`;
        handleServiceDiscoveryAfterConnection(result.device.deviceId);
      } else if (isWeb && result.connectError) {
        statusMessage = `Device selected but connection failed: ${result.connectError.message}`;
      }
    }).then(() => {
      scanning = false;
      if (isWeb && !activeDevice) {
        statusMessage = `Device selection completed.`;
      } else if (!isWeb) {
        statusMessage = `Scan complete. Found ${devices.length} device(s). Select one to connect.`;
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
  
  async function handleServiceDiscoveryAfterConnection(deviceId: string) {
    try {
      const discoveredServices = await discoverServices(deviceId);
      services = discoveredServices;
      
      if (services.length === 0) {
        statusMessage = `Connected, but no services found. Try "Retry Service Discovery" or check if your ESP32 is advertising services.`;
      } else {
        statusMessage = `Connected! Found ${services.length} service(s). Fetching device info...`;
        await handleGetDeviceInfo();
        await startOTAStatusNotifications(deviceId, (status) => {
          otaStatus = status;
          if (status.isError || status.isComplete) {
            otaInProgress = false;
          }
          if (status.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
            otaStatus = { statusMessage: 'Update successful! Device is rebooting with new firmware...', isComplete: true };
            otaInProgress = false;
            statusMessage = "OTA complete! Device rebooted with new firmware. Please reconnect to see updated info.";
          } else if (status.statusMessage.includes("OTA_VALIDATING")) {
            otaStatus = { statusMessage: 'Validating firmware signature...', progress: 95 };
          }
        });
      }
    } catch (error: any) {
      statusMessage = 'Service discovery failed after connection';
      console.error('Service discovery error:', error);
    }
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
      setActiveDevice(device.deviceId);
      statusMessage = `Connected to ${device.name}. Discovering services...`;
      
      const discoveredServices = await discoverServices(device.deviceId);
      services = discoveredServices;
      
      if (services.length === 0) {
        statusMessage = `Connected to ${device.name}, but no services found. Try "Retry Service Discovery" or check if your ESP32 is advertising services.`;
      } else {
        statusMessage = `Connected! Found ${services.length} service(s). Fetching device info...`;
        await handleGetDeviceInfo(); // Automatically get device info on connect
        await handleGetLedConfig(); // Automatically get LED config on connect
        await startOTAStatusNotifications(device.deviceId, (status) => { // Start listening for OTA status
          otaStatus = status;
          if (status.isError || status.isComplete) {
            otaInProgress = false;
          }
          // Handle ESP32 reboot notification
          if (status.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
            otaStatus = { statusMessage: 'Update successful! Device is rebooting with new firmware...', isComplete: true };
            otaInProgress = false;
            statusMessage = "OTA complete! Device rebooted with new firmware. Please reconnect to see updated info.";
          } else if (status.statusMessage.includes("OTA_VALIDATING")) {
            otaStatus = { statusMessage: 'Validating firmware signature...', progress: 95 };
          }
        });
      }
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
    }
  }

  async function handleRetryServiceDiscovery() {
    if (!activeDevice) return;
    
    try {
      statusMessage = 'Retrying service discovery...';
      const discoveredServices = await discoverServices(activeDevice.deviceId);
      services = discoveredServices;
      
      if (services.length === 0) {
        statusMessage = `Still no services found. Check your ESP32's service advertising.`;
      } else {
        statusMessage = `Success! Found ${services.length} service(s). Fetching device info...`;
        await handleGetDeviceInfo();
      }
    } catch (error: any) {
      statusMessage = 'Service discovery failed again';
      console.error('Service discovery error:', error);
    }
  }

  async function handleDisconnect() {
    if (!activeDevice) return;
    
    try {
      if (otaInProgress) { 
        await stopOTAStatusNotifications(activeDevice.deviceId);
      }
      await disconnectFromDevice(activeDevice.deviceId);
      statusMessage = `Disconnected from ${activeDevice.name}`;
      setActiveDevice(null);
      services = [];
      notifications = [];
      latestFirmware = null;
      otaStatus = null;
      otaInProgress = false;
      showUpdateConfirmation = false;
    } catch (error: any) {
      statusMessage = 'Failed to disconnect';
      console.error('Disconnect error:', error);
    }
  }

  async function handleDisconnectDevice(deviceId: string) {
    const device = $connectedDevices.get(deviceId);
    if (!device) return;
    
    try {
      await disconnectFromDevice(deviceId);
      statusMessage = `Disconnected from ${device.name}`;
      
      // If this was the active device, clear active selection
      if ($activeDeviceId === deviceId) {
        setActiveDevice(null);
      }
    } catch (error: any) {
      statusMessage = 'Failed to disconnect';
      console.error('Disconnect error:', error);
    }
  }

  function toggleDeviceActive(deviceId: string) {
    if ($activeDeviceId === deviceId) {
      setActiveDevice(null); // Collapse if already active
    } else {
      setActiveDevice(deviceId); // Make this device active
    }
  }

  async function handleRead(serviceUuid: string, charUuid: string) {
    if (!activeDevice) return;
    
    try {
      const value = await readCharacteristic(activeDevice.deviceId, serviceUuid, charUuid);
      statusMessage = `Read: "${value}"`;
      console.log('Read value:', value);
    } catch (error: any) {
      statusMessage = 'Failed to read characteristic';
      console.error('Read error:', error);
    }
  }

  async function handleWrite(serviceUuid: string, charUuid: string) {
    if (!activeDevice || !writeData.trim()) return;
    
    try {
      await writeCharacteristic(activeDevice.deviceId, serviceUuid, charUuid, writeData);
      statusMessage = `Wrote: "${writeData}"`;
      writeData = '';
    } catch (error: any) {
      statusMessage = 'Failed to write characteristic';
      console.error('Write error:', error);
    }
  }

  async function handleStartNotifications(serviceUuid: string, charUuid: string) {
    if (!activeDevice) return;
    
    try {
      await startNotifications(activeDevice.deviceId, serviceUuid, charUuid, (data) => {
        notifications = [`${new Date().toLocaleTimeString()}: ${data}`, ...notifications].slice(0, 20);
      });
      statusMessage = 'Notifications started';
    } catch (error: any) {
      statusMessage = 'Failed to start notifications';
      console.error('Notifications error:', error);
    }
  }

  async function handleStopNotifications(serviceUuid: string, charUuid: string) {
    if (!activeDevice) return;
    
    try {
      await stopNotifications(activeDevice.deviceId, serviceUuid, charUuid);
      statusMessage = 'Notifications stopped';
    } catch (error: any) {
      statusMessage = 'Failed to stop notifications';
      console.error('Stop notifications error:', error);
    }
  }

  // --- OTA Functions ---
  async function handleGetDeviceInfo() {
    if (!activeDevice) return;
    statusMessage = 'Fetching device info...';
    try {
      const info = await getDeviceInfo(activeDevice.deviceId);
      statusMessage = `Device info received: FW ${info.fw_ver}, HW ${info.hw_ver}`;
    } catch (error: any) {
      statusMessage = 'Failed to get device info.';
      console.error('Get device info error:', error);
    }
  }

  // --- LED Configuration Functions ---
  async function handleGetLedConfig() {
    if (!activeDevice) return;
    ledConfigLoading = true;
    try {
      ledConfig = await getLedConfiguration(activeDevice.deviceId);
      console.log('LED config received:', ledConfig);
    } catch (error: any) {
      console.error('Get LED config error:', error);
      ledConfig = null;
    } finally {
      ledConfigLoading = false;
    }
  }

  async function handleSetLedConfig() {
    if (!activeDevice || !ledConfig) return;
    ledConfigLoading = true;
    try {
      await setLedConfiguration(activeDevice.deviceId, ledConfig);
      statusMessage = 'LED configuration updated successfully';
    } catch (error: any) {
      statusMessage = 'Failed to update LED configuration';
      console.error('Set LED config error:', error);
    } finally {
      ledConfigLoading = false;
    }
  }

  function addLedStrip() {
    if (!ledConfig) return;
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
    ledConfig.strips = [...ledConfig.strips, newStrip];
  }

  function removeLedStrip(index: number) {
    if (!ledConfig) return;
    ledConfig.strips = ledConfig.strips.filter((_, i) => i !== index);
  }

  function updateStripOrientation(stripIndex: number, field: 'rotation' | 'flipH' | 'serpentine', value: number | boolean) {
    if (!ledConfig) return;
    const strip = ledConfig.strips[stripIndex];
    if (!strip) return;
    
    if (field === 'rotation' && typeof value === 'number') {
      strip.orientation = setRotation(strip.orientation, value);
    } else if (field === 'flipH' && typeof value === 'boolean') {
      strip.orientation = setFlipH(strip.orientation, value);
    } else if (field === 'serpentine' && typeof value === 'boolean') {
      strip.orientation = setSerpentine(strip.orientation, value);
    }
  }

  async function handleCheckForUpdate() {
    if (!activeDevice || !activeDevice.deviceInfo) {
      statusMessage = 'Connect to a device and get info first.';
      return;
    }
    checkingForUpdate = true;
    statusMessage = 'Checking for firmware updates...';
    latestFirmware = null;
    showUpdateConfirmation = false;
    try {
      firmwareRegistry = await fetchFirmwareRegistry(espFirmwareRegistryUrl);
      if (firmwareRegistry.length > 0) {
        latestFirmware = findLatestFirmware(firmwareRegistry, activeDevice.deviceInfo.hw_ver);
        if (latestFirmware) {
          if (latestFirmware.version !== activeDevice.deviceInfo.fw_ver) {
            statusMessage = `Update available: ${latestFirmware.version}`;
            showUpdateConfirmation = true;
          } else {
            statusMessage = `Firmware is up to date (${activeDevice.deviceInfo.fw_ver}).`;
          }
        } else {
          statusMessage = `No compatible firmware found for HW ${activeDevice.deviceInfo.hw_ver}.`;
        }
      } else {
        statusMessage = 'Firmware registry is empty or could not be fetched.';
      }
    } catch (error: any) {
      statusMessage = 'Failed to check for updates.';
      console.error('Check for update error:', error);
    } finally {
      checkingForUpdate = false;
    }
  }

  async function handlePerformOTAUpdate() {
    if (!activeDevice || !latestFirmware) return;
    
    otaInProgress = true;
    showUpdateConfirmation = false;
    otaStatus = { statusMessage: 'Starting OTA update...', progress: 0 };
    statusMessage = 'OTA update in progress...';

    // Always use GitHub Pages for firmware downloads, even during local development
    const baseUrl = 'https://hobzcalvin.github.io/blumon'; 

    const firmwareUrl = `${baseUrl}/${latestFirmware.path}`;
    const signatureUrl = `${baseUrl}/${latestFirmware.signaturePath}`;

    try {
      await performOTAUpdate(
        activeDevice.deviceId,
        firmwareUrl,
        signatureUrl,
        (statusUpdate) => {
          otaStatus = statusUpdate;
          if (statusUpdate.isComplete || statusUpdate.isError) {
            otaInProgress = false;
            if (!statusUpdate.isError && (statusUpdate.statusMessage.includes("OTA_SUCCESS_REBOOTING") || statusUpdate.statusMessage.includes("Device rebooted"))) {
              statusMessage = "OTA complete. Device rebooted with new firmware. Please reconnect to see updated info.";
            }
          }
        }
      );
    } catch (error: any) {
      console.error('OTA process error:', error);
      // Check if the error is a write timeout after ESP32 started rebooting
      if (error.message && error.message.includes('Write timeout') && otaStatus?.statusMessage?.includes('VALIDATING')) {
        // This is expected - ESP32 rebooted during signature verification
        otaStatus = { statusMessage: 'Update successful! Device rebooted with new firmware.', isComplete: true };
        statusMessage = "OTA complete! Device rebooted with new firmware. Please reconnect to see updated info.";
      } else {
        otaStatus = { statusMessage: `OTA Error: ${error.message}`, isError: true, isComplete: true };
        statusMessage = `OTA failed: ${error.message}`;
      }
      otaInProgress = false;
    }
  }

</script>

<main>
  <header>
    <h1>🔵 Blumon</h1>
    <p class="subtitle">ESP32 Bluetooth Low Energy Monitor</p>
    <p class="company">by ReVolt Labs</p>
  </header>

  <section class="status">
    <div class="status-card">
      <h2>Status</h2>
      <p class="status-message" class:error={!bleSupported || (otaStatus?.isError === true)} class:success={bleEnabled && activeDevice && (otaStatus?.isComplete === true && otaStatus?.isError !== true)}>
        {#if otaStatus && otaStatus.statusMessage}
          {otaStatus.statusMessage}
          {#if otaStatus.progress !== undefined}
            ({otaStatus.progress}%)
          {/if}
        {:else}
          {statusMessage}
        {/if}
      </p>
      {#if otaInProgress && otaStatus?.progress !== undefined}
        <div class="progress-bar-container">
          <div class="progress-bar" style="width: {otaStatus.progress}%"></div>
        </div>
      {/if}

      {#if isWeb}
        <div class="web-info">
          <p><strong>Web Mode:</strong> Uses browser's device picker instead of continuous scanning.</p>
          <p>Requires HTTPS and works best in Chrome/Edge browsers.</p>
          
          {#if activeDevice && services.length === 0}
            <div class="troubleshooting">
              <h4>🔧 Service Discovery Issues?</h4>
              <p><strong>Common causes on web:</strong></p>
              <ul>
                <li>ESP32 firmware may need 2-3 seconds to initialize services after connection</li>
                <li>Custom service UUIDs must be known in advance for Web Bluetooth</li>
                <li>Some ESP32 devices require bonding/pairing first</li>
                <li>Check browser console (F12) for detailed error messages</li>
              </ul>
              <p><strong>💡 Tips:</strong></p>
              <ul>
                <li>Try the "Retry Service Discovery" button after waiting a few seconds</li>
                <li>If you know your ESP32's service UUIDs, contact the developer to add them</li>
                <li>Test with a different ESP32 sketch that uses standard services</li>
              </ul>
            </div>
          {/if}
        </div>
      {/if}
      <div class="indicators">
        <div class="indicator" class:active={bleSupported}>
          <span class="icon">📡</span>
          <span>BLE Supported</span>
        </div>
        <div class="indicator" class:active={bleEnabled}>
          <span class="icon">🔘</span>
          <span>Bluetooth Enabled</span>
        </div>
        <div class="indicator" class:active={scanning}>
          <span class="icon">🔍</span>
          <span>{isWeb ? 'Selecting Device' : 'Scanning'}</span>
        </div>
        <div class="indicator" class:active={activeDevice}>
          <span class="icon">🔗</span>
          <span>Connected</span>
        </div>
      </div>
    </div>
  </section>

  <section class="controls">
    <div class="control-buttons">
      {#if !bleEnabled && bleSupported}
        <button class="btn primary" on:click={handleEnableBle}>
          Enable Bluetooth
        </button>
      {/if}
      
      {#if bleEnabled && !activeDevice}
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

      {#if activeDevice}
        <button class="btn danger" on:click={handleDisconnect} disabled={otaInProgress}>
          Disconnect from {activeDevice.name}
        </button>
        {#if services.length === 0 && !otaInProgress}
          <button class="btn primary" on:click={handleRetryServiceDiscovery}>
            Retry Service Discovery
          </button>
        {/if}
      {/if}
    </div>
  </section>

  <!-- Connected Devices Section -->
  {#if connectedDevicesList.length > 0}
    <section class="connected-devices">
      <h2>Connected Devices ({connectedDevicesList.length})</h2>
      <div class="devices-grid">
        {#each connectedDevicesList as device (device.deviceId)}
          {@const isActive = $activeDeviceId === device.deviceId}
          
          <div class="device-card" class:active={isActive}>
            <div class="device-header" on:click={() => toggleDeviceActive(device.deviceId)}>
              <div class="device-info">
                <h3>{device.name}</h3>
                <p class="device-id">{device.deviceId}</p>
                {#if device.deviceInfo}
                  <p class="fw-version">FW: {device.deviceInfo.fw_ver}</p>
                {/if}
              </div>
              <div class="device-status">
                <span class="connection-badge">Connected</span>
                {#if isActive}
                  <span class="active-badge">Active</span>
                {/if}
              </div>
            </div>
            
            <div class="device-actions">
              <button class="btn secondary small" on:click|stopPropagation={() => handleDisconnectDevice(device.deviceId)}>
                Disconnect
              </button>
              {#if !isActive}
                <button class="btn primary small" on:click|stopPropagation={() => setActiveDevice(device.deviceId)}>
                  Make Active
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if activeDevice && activeDevice.deviceInfo}
    <section class="ota-section">
      <div class="device-info-card">
        <h3>Device Information</h3>
        <p><strong>Firmware Version:</strong> {activeDevice.deviceInfo.fw_ver}</p>
        <p><strong>Hardware Version:</strong> {activeDevice.deviceInfo.hw_ver}</p>
        {#if activeDevice.deviceInfo.heap !== undefined}
          <p><strong>Free Heap:</strong> {activeDevice.deviceInfo.heap} bytes</p>
        {/if}
        <button class="btn secondary small" on:click={handleGetDeviceInfo} disabled={otaInProgress || checkingForUpdate}>
          Refresh Info
        </button>
      </div>

      <div class="led-config-section">
        <h3>LED Strip Configuration</h3>
        {#if ledConfigLoading}
          <p>Loading LED configuration...</p>
        {:else if ledConfig}
          <div class="config-section">
            <label>
              Global Brightness:
              <input type="range" min="0" max="255" bind:value={ledConfig.globalBrightness} />
              <span>{ledConfig.globalBrightness}</span>
            </label>
          </div>

          <div class="strips-section">
            <div class="section-header">
              <h4>LED Strips ({ledConfig.strips.length})</h4>
              <button class="btn primary small" on:click={addLedStrip} disabled={otaInProgress}>Add Strip</button>
            </div>

            {#each ledConfig.strips as strip, index}
              <div class="strip-card">
                <div class="strip-header">
                  <h5>Strip {index + 1}</h5>
                  <button class="btn danger small" on:click={() => removeLedStrip(index)} disabled={otaInProgress || ledConfig.strips.length <= 1}>Remove</button>
                </div>

                <div class="strip-controls">
                  <div class="control-row">
                    <label>
                      Chipset:
                      <select bind:value={strip.chipset}>
                        <option value={LedChipsets.WS2812_RGB}>WS2812 RGB</option>
                        <option value={LedChipsets.SK6812_RGBW}>SK6812 RGBW</option>
                        <option value={LedChipsets.TM1814_RGBW}>TM1814 RGBW</option>
                        <option value={LedChipsets.WS2811_400KHZ}>WS2811 400KHz</option>
                        <option value={LedChipsets.APA106_RGB}>APA106 RGB</option>
                      </select>
                    </label>

                    <label>
                      Pin:
                      <input type="number" min="0" max="39" bind:value={strip.pin} />
                    </label>

                    <label>
                      LEDs:
                      <input type="number" min="1" max="1000" bind:value={strip.numLeds} />
                    </label>

                    <label>
                      Color Order:
                      <select bind:value={strip.colorOrder}>
                        <option value={ColorOrders.RGB}>RGB</option>
                        <option value={ColorOrders.RBG}>RBG</option>
                        <option value={ColorOrders.GRB}>GRB</option>
                        <option value={ColorOrders.GBR}>GBR</option>
                        <option value={ColorOrders.BRG}>BRG</option>
                        <option value={ColorOrders.BGR}>BGR</option>
                      </select>
                    </label>
                  </div>

                  <div class="control-row">
                    <label>
                      Width (0 = linear):
                      <input type="number" min="0" max="500" bind:value={strip.width} />
                    </label>

                    <label>
                      Height (0 = linear):
                      <input type="number" min="0" max="500" bind:value={strip.height} />
                    </label>

                    <label>
                      RMT Channel:
                      <input type="number" min="0" max="7" bind:value={strip.rmtChannel} />
                    </label>
                  </div>

                  {#if strip.width > 0 && strip.height > 0}
                    <div class="matrix-controls">
                      <h6>Matrix Layout Settings</h6>
                      <div class="control-row">
                        <label>
                          Rotation:
                          <select value={getRotation(strip.orientation)} on:change={(e) => updateStripOrientation(index, 'rotation', parseInt(e.currentTarget.value))}>
                            <option value="0">0° (No rotation)</option>
                            <option value="1">90° Clockwise</option>
                            <option value="2">180°</option>
                            <option value="3">270° Clockwise</option>
                          </select>
                        </label>

                        <label>
                          <input type="checkbox" checked={getFlipH(strip.orientation)} on:change={(e) => updateStripOrientation(index, 'flipH', e.currentTarget.checked)} />
                          Flip Horizontally
                        </label>

                        <label>
                          <input type="checkbox" checked={getSerpentine(strip.orientation)} on:change={(e) => updateStripOrientation(index, 'serpentine', e.currentTarget.checked)} />
                          Serpentine Layout
                        </label>
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          <div class="config-actions">
            <button class="btn primary" on:click={handleSetLedConfig} disabled={otaInProgress || ledConfigLoading}>
              Save Configuration
            </button>
            <button class="btn secondary" on:click={handleGetLedConfig} disabled={otaInProgress || ledConfigLoading}>
              Reload from Device
            </button>
          </div>
        {:else}
          <p>No LED configuration available. Connect to a device to see configuration.</p>
        {/if}
      </div>

      <div class="ota-controls">
        {#if !otaInProgress}
          <button class="btn primary" on:click={handleCheckForUpdate} disabled={checkingForUpdate}>
            {checkingForUpdate ? 'Checking...' : 'Check for Updates'}
          </button>
        {/if}

        {#if latestFirmware && latestFirmware.version !== activeDevice.deviceInfo.fw_ver && !otaInProgress && showUpdateConfirmation}
          <div class="update-available">
            <p>New firmware available: <strong>{latestFirmware.version}</strong></p>
            <button class="btn success" on:click={handlePerformOTAUpdate}>
              Update to {latestFirmware.version}
            </button>
            <button class="btn secondary small" on:click={() => showUpdateConfirmation = false}>Dismiss</button>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#if devices.length > 0 && !activeDevice}
    <section class="devices">
      <h2>{isWeb ? 'Selected Devices' : 'Discovered Devices'} ({devices.length})</h2>
      <div class="device-list">
        {#each devices as device}
          <div class="device-card">
            <div class="device-header">
              <div class="device-name">
                {device.name || 'Unknown Device'}
              </div>
              <button class="btn primary small" on:click={() => handleConnect(device)}>
                Connect
              </button>
            </div>
            <div class="device-id">
              {device.deviceId}
            </div>
            {#if device.rssi}
              <div class="device-rssi">
                Signal: {device.rssi} dBm
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if activeDevice && services.length > 0}
    <section class="services">
      <h2>ESP32 Services & Characteristics (Debug)</h2>
      <div class="write-section">
        <input 
          bind:value={writeData} 
          placeholder="Enter data to send to ESP32 (RX char)" 
          class="write-input"
          disabled={otaInProgress}
        />
      </div>
      
      <div class="services-list">
        {#each services as service}
          <div class="service-card">
            <h3>Service: {service.uuid}</h3>
            <div class="characteristics">
              {#each service.characteristics as characteristic}
                <div class="characteristic-card">
                  <div class="char-header">
                    <span class="char-uuid">{characteristic.uuid}</span>
                    <div class="char-properties">
                      {#if characteristic.properties.read}
                        <span class="property read">R</span>
                      {/if}
                      {#if characteristic.properties.write || characteristic.properties.writeWithoutResponse}
                        <span class="property write">W</span>
                      {/if}
                      {#if characteristic.properties.notify}
                        <span class="property notify">N</span>
                      {/if}
                    </div>
                  </div>
                  <div class="char-actions">
                    {#if characteristic.properties.read}
                      <button class="btn secondary small" on:click={() => handleRead(service.uuid, characteristic.uuid)} disabled={otaInProgress}>
                        Read
                      </button>
                    {/if}
                    {#if characteristic.properties.write || characteristic.properties.writeWithoutResponse}
                      <button class="btn primary small" on:click={() => handleWrite(service.uuid, characteristic.uuid)} disabled={otaInProgress}>
                        Write
                      </button>
                    {/if}
                    {#if characteristic.properties.notify}
                      <button class="btn info small" on:click={() => handleStartNotifications(service.uuid, characteristic.uuid)} disabled={otaInProgress}>
                        Notify
                      </button>
                      <button class="btn secondary small" on:click={() => handleStopNotifications(service.uuid, characteristic.uuid)} disabled={otaInProgress}>
                        Stop
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if notifications.length > 0}
    <section class="notifications">
      <h2>ESP32 Notifications</h2>
      <div class="notifications-list">
        {#each notifications as notification}
          <div class="notification-item">
            {notification}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <footer>
    <p>Built with SvelteKit + Capacitor + Bluetooth LE</p>
    <p>Ready for ESP32 communication on iOS, Android, and Web</p>
    <div class="build-info">
      <p><strong>Build Info:</strong></p>
      <p>📦 Version: <code>{buildInfo.version}</code></p>
      <p>📦 Commit: <code>{buildInfo.commitHash}</code></p>
      <p>🕒 Built: {buildInfo.buildDate}</p>
      <p>💬 {buildInfo.commitMessage}</p>
    </div>
  </footer>
</main>

<style>
  .progress-bar-container {
    width: 100%;
    background-color: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .progress-bar {
    width: 0%;
    height: 10px;
    background-color: #22c55e; /* green-500 */
    border-radius: 4px;
    transition: width 0.3s ease-in-out;
  }
  .ota-section {
    margin-top: 2rem;
    margin-bottom: 2rem;
  }
  .device-info-card, .ota-controls {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  .device-info-card h3 { /* Removed .ota-controls h3 as it's not used */
    margin-top: 0;
  }
  .update-available {
    margin-top: 1rem;
    padding: 1rem;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: 8px;
  }
  .update-available p {
    margin: 0 0 0.5rem 0;
  }
  .btn.success {
    background: linear-gradient(135deg, #10b981, #059669);
    color: white;
  }
  .btn.success:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(16, 185, 129, 0.3);
  }

  header {
    text-align: center;
    margin-bottom: 3rem;
  }

  h1 {
    font-size: 3rem;
    margin: 0;
    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
  }

  .subtitle {
    font-size: 1.2rem;
    margin: 0.5rem 0;
    opacity: 0.9;
  }

  .company {
    font-size: 1rem;
    opacity: 0.7;
    margin: 0;
  }

  .status-card {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 16px;
    padding: 2rem;
    margin-bottom: 2rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .status-card h2 {
    margin-top: 0;
    margin-bottom: 1rem;
  }

  .status-message {
    font-size: 1.1rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
  }

  .status-message.success {
    background: rgba(34, 197, 94, 0.2);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-message.error {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .web-info {
    background: rgba(59, 130, 246, 0.2);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }

  .web-info p {
    margin: 0.5rem 0;
  }

  .troubleshooting {
    background: rgba(245, 158, 11, 0.2);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: 8px;
    padding: 1rem;
    margin-top: 1rem;
  }

  .troubleshooting h4 {
    margin: 0 0 0.5rem 0;
    color: #fbbf24;
  }

  .troubleshooting ul {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  .troubleshooting li {
    margin: 0.25rem 0;
    font-size: 0.85rem;
  }

  .indicators {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    opacity: 0.5;
    transition: opacity 0.3s ease;
  }

  .indicator.active {
    opacity: 1;
    background: rgba(34, 197, 94, 0.2);
  }

  .control-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
  }

  .btn {
    padding: 1rem 2rem;
    border: none;
    border-radius: 12px;
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .btn.small {
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
  }

  .btn.primary {
    background: linear-gradient(135deg, #22c55e, #16a34a);
    color: white;
  }

  .btn.primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(34, 197, 94, 0.3);
  }

  .btn.secondary {
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: white;
  }

  .btn.secondary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(245, 158, 11, 0.3);
  }

  .btn.danger {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    color: white;
  }

  .btn.danger:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(239, 68, 68, 0.3);
  }

  .btn.info {
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    color: white;
  }

  .btn.info:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 16px rgba(59, 130, 246, 0.3);
  }

  .devices h2, .services h2, .notifications h2 {
    margin-bottom: 1rem;
  }

  .device-list, .services-list {
    display: grid;
    gap: 1rem;
  }

  .device-card, .service-card {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    padding: 1.5rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .device-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .device-name {
    font-size: 1.2rem;
    font-weight: 600;
  }

  .device-id {
    font-family: monospace;
    font-size: 0.9rem;
    opacity: 0.7;
    margin-bottom: 0.5rem;
  }

  .device-rssi {
    font-size: 0.9rem;
    color: #22c55e;
  }

  .write-section {
    margin-bottom: 2rem;
  }

  .write-input {
    width: 100%;
    padding: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 1rem;
  }

  .write-input::placeholder {
    color: rgba(255, 255, 255, 0.7);
  }

  .service-card h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    opacity: 0.9;
  }

  .characteristics {
    display: grid;
    gap: 1rem;
  }

  .characteristic-card {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 1rem;
  }

  .char-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .char-uuid {
    font-family: monospace;
    font-size: 0.8rem;
    opacity: 0.8;
  }

  .char-properties {
    display: flex;
    gap: 0.25rem;
  }

  .property {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: bold;
  }

  .property.read {
    background: rgba(34, 197, 94, 0.3);
  }

  .property.write {
    background: rgba(59, 130, 246, 0.3);
  }

  .property.notify {
    background: rgba(245, 158, 11, 0.3);
  }

  .char-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .notifications-list {
    max-height: 300px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    padding: 1rem;
  }

  .notification-item {
    padding: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    font-family: monospace;
    font-size: 0.9rem;
  }

  .notification-item:last-child {
    border-bottom: none;
  }

  footer {
    text-align: center;
    margin-top: 3rem;
    opacity: 0.7;
  }

  footer p {
    margin: 0.5rem 0;
  }

  .build-info {
    margin-top: 1.5rem;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    font-size: 0.85rem;
  }

  .build-info code {
    background: rgba(255, 255, 255, 0.2);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  }

  .led-config-section {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .led-config-section h3 {
    margin-top: 0;
    margin-bottom: 1rem;
  }

  .config-section {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .config-section label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .config-section input[type="range"] {
    flex: 1;
    margin: 0 0.5rem;
  }

  .strips-section {
    margin-bottom: 1.5rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-header h4 {
    margin: 0;
  }

  .strip-card {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .strip-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .strip-header h5 {
    margin: 0;
  }

  .strip-controls {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .control-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .control-row label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9rem;
  }

  .control-row input,
  .control-row select {
    padding: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 0.9rem;
  }

  .control-row input[type="checkbox"] {
    width: auto;
    margin-right: 0.5rem;
  }

  .matrix-controls {
    margin-top: 1rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .matrix-controls h6 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    opacity: 0.9;
  }

  .config-actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
  }

  @media (max-width: 768px) {    
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
      align-items: flex-start;
      gap: 1rem;
    }

    .char-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .devices-grid {
      grid-template-columns: 1fr;
    }

    .device-header {
      flex-direction: column;
      gap: 1rem;
    }

    .device-status {
      align-items: flex-start;
      flex-direction: row;
    }

    .device-actions {
      justify-content: stretch;
    }

    .device-actions .btn {
      flex: 1;
    }
  }

  /* Multi-device UI styles */
  .connected-devices {
    margin: 2rem 0;
  }

  .devices-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }

  .device-card {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    overflow: hidden;
    transition: all 0.3s ease;
  }

  .device-card.active {
    border-color: rgba(34, 197, 94, 0.5);
    box-shadow: 0 0 20px rgba(34, 197, 94, 0.2);
    transform: translateY(-2px);
  }

  .device-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 1.5rem;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .device-header:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .device-info h3 {
    margin: 0 0 0.5rem 0;
    color: white;
    font-size: 1.1rem;
  }

  .device-id, .fw-version {
    margin: 0.25rem 0;
    font-size: 0.8rem;
    opacity: 0.7;
    font-family: monospace;
  }

  .device-status {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .connection-badge, .active-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .connection-badge {
    background: rgba(34, 197, 94, 0.2);
    color: #10b981;
    border: 1px solid rgba(34, 197, 94, 0.5);
  }

  .active-badge {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.5);
  }

  .device-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0 1.5rem 1.5rem 1.5rem;
    justify-content: flex-end;
  }
</style>
