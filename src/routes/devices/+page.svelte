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
    LED_SERVICE_UUID, // Import if needed for direct calls, though OTA functions encapsulate this
    CHARACTERISTIC_UUID_DEVICE_INFO, // For direct read if needed, though getDeviceInfo handles it
    CHARACTERISTIC_UUID_OTA_STATUS // For direct notification start if needed
  } from '$lib/ble';
  import { Capacitor } from '@capacitor/core';

  let bleSupported = false;
  let bleEnabled = false;
  let scanning = false;
  let devices: any[] = [];
  let statusMessage = '';
  let isWeb = false;
  let selectedDevice: any = null;
  let services: any[] = [];
  let notifications: string[] = [];
  let writeData = '';

  // OTA State
  let deviceInfo: DeviceInfo | null = null;
  let firmwareRegistry: FirmwareRegistryEntry[] = [];
  let latestFirmware: FirmwareRegistryEntry | null = null;
  let otaStatus: OTAUpdateStatus | null = null;
  let otaInProgress = false;
  let checkingForUpdate = false;
  let showUpdateConfirmation = false;
  let espFirmwareRegistryUrl = "/firmware/esp32/esp32_firmware_registry.json"; // Default path on gh-pages

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
    }).then(() => {
      if (isWeb) {
        scanning = false;
        statusMessage = `Device selected. Found ${devices.length} device(s).`;
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
      selectedDevice = device;
      statusMessage = `Connected to ${device.name}. Discovering services...`;
      
      const discoveredServices = await discoverServices(device.deviceId);
      services = discoveredServices;
      
      if (services.length === 0) {
        statusMessage = `Connected to ${device.name}, but no services found. Try \"Retry Service Discovery\" or check if your ESP32 is advertising services.`;
      } else {
        statusMessage = `Connected! Found ${services.length} service(s). Fetching device info...`;
        await handleGetDeviceInfo(); // Automatically get device info on connect
        await startOTAStatusNotifications(selectedDevice.deviceId, (status) => { // Start listening for OTA status
          otaStatus = status;
          if (status.isError || status.isComplete) {
            otaInProgress = false;
          }
          if (status.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
            // Device will reboot, might disconnect.
            // Optionally, try to re-fetch device info after a delay.
            setTimeout(async () => {
                statusMessage = "Device rebooted. Re-fetching info...";
                await handleGetDeviceInfo();
            }, 5000); // Wait 5s for reboot
          }
        });
      }
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
      selectedDevice = null; // Clear selected device on connection error
    }
  }

  async function handleRetryServiceDiscovery() {
    if (!selectedDevice) return;
    
    try {
      statusMessage = 'Retrying service discovery...';
      const discoveredServices = await discoverServices(selectedDevice.deviceId);
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
    if (!selectedDevice) return;
    
    try {
      if (otaInProgress) { // Stop OTA status notifications if OTA was in progress
        await stopOTAStatusNotifications(selectedDevice.deviceId);
      }
      await disconnectFromDevice(selectedDevice.deviceId);
      statusMessage = `Disconnected from ${selectedDevice.name}`;
      selectedDevice = null;
      services = [];
      notifications = [];
      deviceInfo = null;
      latestFirmware = null;
      otaStatus = null;
      otaInProgress = false;
      showUpdateConfirmation = false;
    } catch (error: any) {
      statusMessage = 'Failed to disconnect';
      console.error('Disconnect error:', error);
    }
  }

  async function handleRead(serviceUuid: string, charUuid: string) {
    if (!selectedDevice) return;
    
    try {
      const value = await readCharacteristic(selectedDevice.deviceId, serviceUuid, charUuid);
      statusMessage = `Read: \"${value}\"`;
      console.log('Read value:', value);
    } catch (error: any) {
      statusMessage = 'Failed to read characteristic';
      console.error('Read error:', error);
    }
  }

  async function handleWrite(serviceUuid: string, charUuid: string) {
    if (!selectedDevice || !writeData.trim()) return;
    
    try {
      await writeCharacteristic(selectedDevice.deviceId, serviceUuid, charUuid, writeData);
      statusMessage = `Wrote: \"${writeData}\"`;
      writeData = '';
    } catch (error: any) {
      statusMessage = 'Failed to write characteristic';
      console.error('Write error:', error);
    }
  }

  async function handleStartNotifications(serviceUuid: string, charUuid: string) {
    if (!selectedDevice) return;
    
    try {
      await startNotifications(selectedDevice.deviceId, serviceUuid, charUuid, (data) => {
        notifications = [`${new Date().toLocaleTimeString()}: ${data}`, ...notifications].slice(0, 20);
      });
      statusMessage = 'Notifications started';
    } catch (error: any) {
      statusMessage = 'Failed to start notifications';
      console.error('Notifications error:', error);
    }
  }

  async function handleStopNotifications(serviceUuid: string, charUuid: string) {
    if (!selectedDevice) return;
    
    try {
      await stopNotifications(selectedDevice.deviceId, serviceUuid, charUuid);
      statusMessage = 'Notifications stopped';
    } catch (error: any) {
      statusMessage = 'Failed to stop notifications';
      console.error('Stop notifications error:', error);
    }
  }

  // --- OTA Functions ---
  async function handleGetDeviceInfo() {
    if (!selectedDevice) return;
    statusMessage = 'Fetching device info...';
    try {
      deviceInfo = await getDeviceInfo(selectedDevice.deviceId);
      statusMessage = `Device info received: FW ${deviceInfo.fw_ver}, HW ${deviceInfo.hw_ver}`;
    } catch (error: any) {
      statusMessage = 'Failed to get device info.';
      console.error('Get device info error:', error);
      deviceInfo = null;
    }
  }

  async function handleCheckForUpdate() {
    if (!selectedDevice || !deviceInfo) {
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
        latestFirmware = findLatestFirmware(firmwareRegistry, deviceInfo.hw_ver);
        if (latestFirmware) {
          if (latestFirmware.version !== deviceInfo.fw_ver) {
            statusMessage = `Update available: ${latestFirmware.version}`;
            showUpdateConfirmation = true;
          } else {
            statusMessage = `Firmware is up to date (${deviceInfo.fw_ver}).`;
          }
        } else {
          statusMessage = `No compatible firmware found for HW ${deviceInfo.hw_ver}.`;
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
    if (!selectedDevice || !latestFirmware) return;
    
    otaInProgress = true;
    showUpdateConfirmation = false;
    otaStatus = { statusMessage: 'Starting OTA update...', progress: 0 };

    // Construct full URLs for firmware and signature if paths are relative
    // Assuming gh-pages serves from root. Adjust if your setup is different.
    const baseUrl = isWeb ? window.location.origin : ''; // For native, might need full URL if not bundled

    const firmwareUrl = `${baseUrl}${latestFirmware.path}`;
    const signatureUrl = `${baseUrl}${latestFirmware.signaturePath}`;

    try {
      await performOTAUpdate(
        selectedDevice.deviceId,
        firmwareUrl,
        signatureUrl,
        (statusUpdate) => {
          otaStatus = statusUpdate;
          if (statusUpdate.isComplete || statusUpdate.isError) {
            otaInProgress = false;
            // Optionally re-fetch device info after a successful update and reboot
            if (!statusUpdate.isError && statusUpdate.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
              setTimeout(async () => {
                statusMessage = "OTA complete. Device rebooting. Re-fetching info...";
                await handleGetDeviceInfo(); // Attempt to get new info
              }, 10000); // Wait 10s for reboot and reconnection
            }
          }
        }
      );
    } catch (error: any) {
      console.error('OTA process error:', error);
      otaStatus = { statusMessage: `OTA Error: ${error.message}`, isError: true, isComplete: true };
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
      <p class="status-message" class:error={!bleSupported || (otaStatus?.isError === true)} class:success={bleEnabled && selectedDevice && (otaStatus?.isComplete === true && otaStatus?.isError !== true)}>
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
          <p><strong>Web Mode:</strong> Uses browser\'s device picker instead of continuous scanning.</p>
          <p>Requires HTTPS and works best in Chrome/Edge browsers.</p>
          
          {#if selectedDevice && services.length === 0}
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
                <li>If you know your ESP32\'s service UUIDs, contact the developer to add them</li>
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
        <div class="indicator" class:active={selectedDevice}>
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
      
      {#if bleEnabled && !selectedDevice}
        {#if !scanning}
          <button class="btn primary" on:click={handleStartScan}>
            {isWeb ? 'Select ESP32 Device' : 'Scan for ESP32s'}
          </button>
        {:else if !isWeb}
          <button class="btn secondary" on:click={handleStopScan}>\n            Stop Scanning\n          </button>
        {/if}
      {/if}

      {#if selectedDevice}
        <button class="btn danger" on:click={handleDisconnect} disabled={otaInProgress}>\n          Disconnect from {selectedDevice.name}\n        </button>
        {#if services.length === 0 && !otaInProgress}\n          <button class="btn primary" on:click={handleRetryServiceDiscovery}>\n            Retry Service Discovery\n          </button>
        {/if}
      {/if}
    </div>
  </section>

  {#if selectedDevice && deviceInfo}
    <section class="ota-section">
      <div class="device-info-card">
        <h3>Device Information</h3>
        <p><strong>Firmware Version:</strong> {deviceInfo.fw_ver}</p>
        <p><strong>Hardware Version:</strong> {deviceInfo.hw_ver}</p>
        {#if deviceInfo.heap !== undefined}
          <p><strong>Free Heap:</strong> {deviceInfo.heap} bytes</p>
        {/if}
        <button class="btn secondary small" on:click={handleGetDeviceInfo} disabled={otaInProgress || checkingForUpdate}>\n          Refresh Info\n        </button>
      </div>

      <div class="ota-controls">
        {#if !otaInProgress}
          <button class="btn primary" on:click={handleCheckForUpdate} disabled={checkingForUpdate}>\n            {checkingForUpdate ? 'Checking...' : 'Check for Updates'}\n          </button>
        {/if}

        {#if latestFirmware && latestFirmware.version !== deviceInfo.fw_ver && !otaInProgress && showUpdateConfirmation}
          <div class="update-available">
            <p>New firmware available: <strong>{latestFirmware.version}</strong></p>
            <button class="btn success" on:click={handlePerformOTAUpdate}>\n              Update to {latestFirmware.version}\n            </button>
            <button class="btn secondary small" on:click={() => showUpdateConfirmation = false}>Dismiss</button>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#if devices.length > 0 && !selectedDevice}\n    <section class="devices">\n      <h2>{isWeb ? 'Selected Devices' : 'Discovered Devices'} ({devices.length})</h2>\n      <div class="device-list">\n        {#each devices as device}\n          <div class="device-card">\n            <div class="device-header">\n              <div class="device-name">\n                {device.name || 'Unknown Device'}\n              </div>\n              <button class="btn primary small" on:click={() => handleConnect(device)}>\n                Connect\n              </button>\n            </div>\n            <div class="device-id">\n              {device.deviceId}\n            </div>\n            {#if device.rssi}\n              <div class="device-rssi">\n                Signal: {device.rssi} dBm\n              </div>\n            {/if}\n          </div>\n        {/each}\n      </div>\n    </section>\n  {/if}\n\n  {#if selectedDevice && services.length > 0}\n    <section class="services">\n      <h2>ESP32 Services & Characteristics (Debug)</h2>\n      <div class="write-section">\n        <input \n          bind:value={writeData} \n          placeholder="Enter data to send to ESP32 (RX char)" \n          class="write-input"\n          disabled={otaInProgress}\n        />\n      </div>\n      \n      <div class="services-list">\n        {#each services as service}\n          <div class="service-card">\n            <h3>Service: {service.uuid}</h3>\n            <div class="characteristics">\n              {#each service.characteristics as characteristic}\n                <div class="characteristic-card">\n                  <div class="char-header">\n                    <span class="char-uuid">{characteristic.uuid}</span>\n                    <div class="char-properties">\n                      {#if characteristic.properties.read}\n                        <span class="property read">R</span>\n                      {/if}\n                      {#if characteristic.properties.write || characteristic.properties.writeWithoutResponse}\n                        <span class="property write">W</span>\n                      {/if}\n                      {#if characteristic.properties.notify}\n                        <span class="property notify">N</span>\n                      {/if}\n                    </div>\n                  </div>\n                  <div class="char-actions">\n                    {#if characteristic.properties.read}\n                      <button class="btn secondary small" on:click={() => handleRead(service.uuid, characteristic.uuid)} disabled={otaInProgress}>\n                        Read\n                      </button>\n                    {/if}\n                    {#if characteristic.properties.write || characteristic.properties.writeWithoutResponse}\n                      <button class="btn primary small" on:click={() => handleWrite(service.uuid, characteristic.uuid)} disabled={otaInProgress}>\n                        Write\n                      </button>\n                    {/if}\n                    {#if characteristic.properties.notify}\n                      <button class="btn info small" on:click={() => handleStartNotifications(service.uuid, characteristic.uuid)} disabled={otaInProgress}>\n                        Notify\n                      </button>\n                      <button class="btn secondary small" on:click={() => handleStopNotifications(service.uuid, characteristic.uuid)} disabled={otaInProgress}>\n                        Stop\n                      </button>\n                    {/if}\n                  </div>\n                </div>\n              {/each}\n            </div>\n          </div>\n        {/each}\n      </div>\n    </section>\n  {/if}\n\n  {#if notifications.length > 0}\n    <section class="notifications">\n      <h2>ESP32 Notifications (TX & OTA Status)</h2>\n      <div class="notifications-list">\n        {#each notifications as notification}\n          <div class="notification-item">\n            {notification}\n          </div>\n        {/each}\n      </div>\n    </section>\n  {/if}\n\n  <footer>\n    <p>Built with SvelteKit + Capacitor + Bluetooth LE</p>\n    <p>Ready for ESP32 communication on iOS, Android, and Web</p>\n    <div class="build-info">\n      <p><strong>Build Info:</strong></p>\n      <p>📦 Version: <code>{buildInfo.version}</code></p>\n      <p>📦 Commit: <code>{buildInfo.commitHash}</code></p>\n      <p>🕒 Built: {buildInfo.buildDate}</p>\n      <p>💬 {buildInfo.commitMessage}</p>\n    </div>\n  </footer>\n</main>\n\n<style>\n  .progress-bar-container {\n    width: 100%;\n    background-color: rgba(255, 255, 255, 0.2);\n    border-radius: 4px;\n    margin-bottom: 1rem;\n    overflow: hidden;\n  }\n  .progress-bar {\n    width: 0%;\n    height: 10px;\n    background-color: #22c55e; /* green-500 */\n    border-radius: 4px;\n    transition: width 0.3s ease-in-out;\n  }\n  .ota-section {\n    margin-top: 2rem;\n    margin-bottom: 2rem;\n  }\n  .device-info-card, .ota-controls {\n    background: rgba(255, 255, 255, 0.1);\n    backdrop-filter: blur(10px);\n    border-radius: 12px;\n    padding: 1.5rem;\n    margin-bottom: 1rem;\n    border: 1px solid rgba(255, 255, 255, 0.2);\n  }\n  .device-info-card h3, .ota-controls h3 {\n    margin-top: 0;\n  }\n  .update-available {\n    margin-top: 1rem;\n    padding: 1rem;\n    background: rgba(34, 197, 94, 0.1);\n    border: 1px solid rgba(34, 197, 94, 0.2);\n    border-radius: 8px;\n  }\n  .update-available p {\n    margin: 0 0 0.5rem 0;\n  }\n  .btn.success {\n    background: linear-gradient(135deg, #10b981, #059669);\n    color: white;\n  }\n  .btn.success:hover {\n    transform: translateY(-2px);\n    box-shadow: 0 8px 16px rgba(16, 185, 129, 0.3);\n  }\n\n  header {\n    text-align: center;\n    margin-bottom: 3rem;\n  }\n\n  h1 {\n    font-size: 3rem;\n    margin: 0;\n    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);\n  }\n\n  .subtitle {\n    font-size: 1.2rem;\n    margin: 0.5rem 0;\n    opacity: 0.9;\n  }\n\n  .company {\n    font-size: 1rem;\n    opacity: 0.7;\n    margin: 0;\n  }\n\n  .status-card {\n    background: rgba(255, 255, 255, 0.1);\n    backdrop-filter: blur(10px);\n    border-radius: 16px;\n    padding: 2rem;\n    margin-bottom: 2rem;\n    border: 1px solid rgba(255, 255, 255, 0.2);\n  }\n\n  .status-card h2 {\n    margin-top: 0;\n    margin-bottom: 1rem;\n  }\n\n  .status-message {\n    font-size: 1.1rem;\n    margin-bottom: 1.5rem;\n    padding: 1rem;\n    border-radius: 8px;\n    background: rgba(255, 255, 255, 0.1);\n  }\n\n  .status-message.success {\n    background: rgba(34, 197, 94, 0.2);\n    border: 1px solid rgba(34, 197, 94, 0.3);\n  }\n\n  .status-message.error {\n    background: rgba(239, 68, 68, 0.2);\n    border: 1px solid rgba(239, 68, 68, 0.3);\n  }\n\n  .web-info {\n    background: rgba(59, 130, 246, 0.2);\n    border: 1px solid rgba(59, 130, 246, 0.3);\n    border-radius: 8px;\n    padding: 1rem;\n    margin-bottom: 1.5rem;\n    font-size: 0.9rem;\n  }\n\n  .web-info p {\n    margin: 0.5rem 0;\n  }\n\n  .troubleshooting {\n    background: rgba(245, 158, 11, 0.2);\n    border: 1px solid rgba(245, 158, 11, 0.3);\n    border-radius: 8px;\n    padding: 1rem;\n    margin-top: 1rem;\n  }\n\n  .troubleshooting h4 {\n    margin: 0 0 0.5rem 0;\n    color: #fbbf24;\n  }\n\n  .troubleshooting ul {\n    margin: 0.5rem 0;\n    padding-left: 1.5rem;\n  }\n\n  .troubleshooting li {\n    margin: 0.25rem 0;\n    font-size: 0.85rem;\n  }\n\n  .indicators {\n    display: flex;\n    gap: 1rem;\n    flex-wrap: wrap;\n  }\n\n  .indicator {\n    display: flex;\n    align-items: center;\n    gap: 0.5rem;\n    padding: 0.5rem 1rem;\n    border-radius: 8px;\n    background: rgba(255, 255, 255, 0.1);\n    opacity: 0.5;\n    transition: opacity 0.3s ease;\n  }\n\n  .indicator.active {\n    opacity: 1;\n    background: rgba(34, 197, 94, 0.2);\n  }\n\n  .control-buttons {\n    display: flex;\n    gap: 1rem;\n    justify-content: center;\n    margin-bottom: 2rem;\n    flex-wrap: wrap;\n  }\n\n  .btn {\n    padding: 1rem 2rem;\n    border: none;\n    border-radius: 12px;\n    font-size: 1.1rem;\n    font-weight: 600;\n    cursor: pointer;\n    transition: all 0.3s ease;\n    text-transform: uppercase;\n    letter-spacing: 0.5px;\n  }\n\n  .btn.small {\n    padding: 0.5rem 1rem;\n    font-size: 0.9rem;\n  }\n\n  .btn.primary {\n    background: linear-gradient(135deg, #22c55e, #16a34a);\n    color: white;\n  }\n\n  .btn.primary:hover {\n    transform: translateY(-2px);\n    box-shadow: 0 8px 16px rgba(34, 197, 94, 0.3);\n  }\n\n  .btn.secondary {\n    background: linear-gradient(135deg, #f59e0b, #d97706);\n    color: white;\n  }\n\n  .btn.secondary:hover {\n    transform: translateY(-2px);\n    box-shadow: 0 8px 16px rgba(245, 158, 11, 0.3);\n  }\n\n  .btn.danger {\n    background: linear-gradient(135deg, #ef4444, #dc2626);\n    color: white;\n  }\n\n  .btn.danger:hover {\n    transform: translateY(-2px);\n    box-shadow: 0 8px 16px rgba(239, 68, 68, 0.3);\n  }\n\n  .btn.info {\n    background: linear-gradient(135deg, #3b82f6, #2563eb);\n    color: white;\n  }\n\n  .btn.info:hover {\n    transform: translateY(-2px);\n    box-shadow: 0 8px 16px rgba(59, 130, 246, 0.3);\n  }\n\n  .devices h2, .services h2, .notifications h2 {\n    margin-bottom: 1rem;\n  }\n\n  .device-list, .services-list {\n    display: grid;\n    gap: 1rem;\n  }\n\n  .device-card, .service-card {\n    background: rgba(255, 255, 255, 0.1);\n    backdrop-filter: blur(10px);\n    border-radius: 12px;\n    padding: 1.5rem;\n    border: 1px solid rgba(255, 255, 255, 0.2);\n  }\n\n  .device-header {\n    display: flex;\n    justify-content: space-between;\n    align-items: center;\n    margin-bottom: 0.5rem;\n  }\n\n  .device-name {\n    font-size: 1.2rem;\n    font-weight: 600;\n  }\n\n  .device-id {\n    font-family: monospace;\n    font-size: 0.9rem;\n    opacity: 0.7;\n    margin-bottom: 0.5rem;\n  }\n\n  .device-rssi {\n    font-size: 0.9rem;\n    color: #22c55e;\n  }\n\n  .write-section {\n    margin-bottom: 2rem;\n  }\n\n  .write-input {\n    width: 100%;\n    padding: 1rem;\n    border: 1px solid rgba(255, 255, 255, 0.3);\n    border-radius: 8px;\n    background: rgba(255, 255, 255, 0.1);\n    color: white;\n    font-size: 1rem;\n  }\n\n  .write-input::placeholder {\n    color: rgba(255, 255, 255, 0.7);\n  }\n\n  .service-card h3 {\n    margin: 0 0 1rem 0;\n    font-size: 1rem;\n    opacity: 0.9;\n  }\n\n  .characteristics {\n    display: grid;\n    gap: 1rem;\n  }\n\n  .characteristic-card {\n    background: rgba(255, 255, 255, 0.05);\n    border-radius: 8px;\n    padding: 1rem;\n  }\n\n  .char-header {\n    display: flex;\n    justify-content: space-between;\n    align-items: center;\n    margin-bottom: 1rem;\n  }\n\n  .char-uuid {\n    font-family: monospace;\n    font-size: 0.8rem;\n    opacity: 0.8;\n  }\n\n  .char-properties {\n    display: flex;\n    gap: 0.25rem;\n  }\n\n  .property {\n    padding: 0.25rem 0.5rem;\n    border-radius: 4px;\n    font-size: 0.7rem;\n    font-weight: bold;\n  }\n\n  .property.read {\n    background: rgba(34, 197, 94, 0.3);\n  }\n\n  .property.write {\n    background: rgba(59, 130, 246, 0.3);\n  }\n\n  .property.notify {\n    background: rgba(245, 158, 11, 0.3);\n  }\n\n  .char-actions {\n    display: flex;\n    gap: 0.5rem;\n    flex-wrap: wrap;\n  }\n\n  .notifications-list {\n    max-height: 300px;\n    overflow-y: auto;\n    background: rgba(0, 0, 0, 0.2);\n    border-radius: 8px;\n    padding: 1rem;\n  }\n\n  .notification-item {\n    padding: 0.5rem;\n    border-bottom: 1px solid rgba(255, 255, 255, 0.1);\n    font-family: monospace;\n    font-size: 0.9rem;\n  }\n\n  .notification-item:last-child {\n    border-bottom: none;\n  }\n\n  footer {\n    text-align: center;\n    margin-top: 3rem;\n    opacity: 0.7;\n  }\n\n  footer p {\n    margin: 0.5rem 0;\n  }\n\n  .build-info {\n    margin-top: 1.5rem;\n    padding: 1rem;\n    background: rgba(0, 0, 0, 0.2);\n    border-radius: 8px;\n    font-size: 0.85rem;\n  }\n\n  .build-info code {\n    background: rgba(255, 255, 255, 0.2);\n    padding: 0.2rem 0.4rem;\n    border-radius: 4px;\n    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;\n  }\n\n  @media (max-width: 768px) {\n    /* Removed main padding override to be consistent with global layout */\n    \n    h1 {\n      font-size: 2rem;\n    }\n    \n    .control-buttons {\n      flex-direction: column;\n      align-items: center;\n    }\n    \n    .btn {\n      width: 100%;\n      max-width: 300px;\n    }\n\n    .device-header {\n      flex-direction: column;\n      align-items: flex-start;\n      gap: 1rem;\n    }\n\n    .char-header {\n      flex-direction: column;\n      align-items: flex-start;\n      gap: 0.5rem;\n    }\n  }\n</style>
