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
    type OTAUpdateStatus
    // Removed internal constants like LED_SERVICE_UUID as they are not exported from ble.ts
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
        statusMessage = `Connected to ${device.name}, but no services found. Try "Retry Service Discovery" or check if your ESP32 is advertising services.`;
      } else {
        statusMessage = `Connected! Found ${services.length} service(s). Fetching device info...`;
        await handleGetDeviceInfo(); // Automatically get device info on connect
        await startOTAStatusNotifications(selectedDevice.deviceId, (status) => { // Start listening for OTA status
          otaStatus = status;
          notifications = [`${new Date().toLocaleTimeString()} [OTA]: ${status.statusMessage}${status.progress !== undefined ? ' ('+status.progress+'%)' : ''}`, ...notifications].slice(0,20);
          if (status.isError || status.isComplete) {
            otaInProgress = false;
          }
          if (status.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
            setTimeout(async () => {
                statusMessage = "Device rebooted. Re-fetching info...";
                await handleGetDeviceInfo();
            }, 5000); 
          }
        });
      }
    } catch (error: any) {
      statusMessage = `Failed to connect to ${device.name}`;
      console.error('Connect error:', error);
      selectedDevice = null; 
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
      if (otaInProgress) { 
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
      statusMessage = `Read: "${value}"`;
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
      statusMessage = `Wrote: "${writeData}"`;
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

    const baseUrl = isWeb ? window.location.origin : ''; 

    const firmwareUrl = `${baseUrl}${latestFirmware.path}`;
    const signatureUrl = `${baseUrl}${latestFirmware.signaturePath}`;

    try {
      await performOTAUpdate(
        selectedDevice.deviceId,
        firmwareUrl,
        signatureUrl,
        (statusUpdate) => {
          otaStatus = statusUpdate;
          notifications = [`${new Date().toLocaleTimeString()} [OTA]: ${statusUpdate.statusMessage}${statusUpdate.progress !== undefined ? ' ('+statusUpdate.progress+'%)' : ''}`, ...notifications].slice(0,20);
          if (statusUpdate.isComplete || statusUpdate.isError) {
            otaInProgress = false;
            if (!statusUpdate.isError && statusUpdate.statusMessage.includes("OTA_SUCCESS_REBOOTING")) {
              setTimeout(async () => {
                statusMessage = "OTA complete. Device rebooting. Re-fetching info...";
                await handleGetDeviceInfo(); 
              }, 10000); 
            }
          }
        }
      );
    } catch (error: any) {
      console.error('OTA process error:', error);
      otaStatus = { statusMessage: `OTA Error: ${error.message}`, isError: true, isComplete: true };
      notifications = [`${new Date().toLocaleTimeString()} [OTA ERROR]: ${error.message}`, ...notifications].slice(0,20);
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
          <p><strong>Web Mode:</strong> Uses browser's device picker instead of continuous scanning.</p>
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
          <button class="btn secondary" on:click={handleStopScan}>
            Stop Scanning
          </button>
        {/if}
      {/if}

      {#if selectedDevice}
        <button class="btn danger" on:click={handleDisconnect} disabled={otaInProgress}>
          Disconnect from {selectedDevice.name}
        </button>
        {#if services.length === 0 && !otaInProgress}
          <button class="btn primary" on:click={handleRetryServiceDiscovery}>
            Retry Service Discovery
          </button>
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
        <button class="btn secondary small" on:click={handleGetDeviceInfo} disabled={otaInProgress || checkingForUpdate}>
          Refresh Info
        </button>
      </div>

      <div class="ota-controls">
        {#if !otaInProgress}
          <button class="btn primary" on:click={handleCheckForUpdate} disabled={checkingForUpdate}>
            {checkingForUpdate ? 'Checking...' : 'Check for Updates'}
          </button>
        {/if}

        {#if latestFirmware && latestFirmware.version !== deviceInfo.fw_ver && !otaInProgress && showUpdateConfirmation}
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

  {#if devices.length > 0 && !selectedDevice}
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

  {#if selectedDevice && services.length > 0}
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
      <h2>ESP32 Notifications (TX & OTA Status)</h2>
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
  .device-info-card h3, .ota-controls h3 {
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
  }
</style>
