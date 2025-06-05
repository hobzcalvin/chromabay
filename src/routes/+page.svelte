<script lang="ts">
  import { onMount } from 'svelte';
  import { initBle, isBleEnabled, enableBle, startScan, stopScan } from '$lib/ble';

  let bleSupported = false;
  let bleEnabled = false;
  let scanning = false;
  let devices: any[] = [];
  let statusMessage = '';

  onMount(async () => {
    try {
      await initBle();
      bleSupported = true;
      bleEnabled = await isBleEnabled();
      statusMessage = bleEnabled ? 'Bluetooth is ready!' : 'Bluetooth is not enabled';
    } catch (error) {
      console.error('BLE initialization failed:', error);
      statusMessage = 'BLE not supported on this platform';
    }
  });

  async function handleEnableBle() {
    try {
      await enableBle();
      bleEnabled = await isBleEnabled();
      statusMessage = 'Bluetooth enabled successfully!';
    } catch (error) {
      statusMessage = 'Failed to enable Bluetooth';
      console.error('Enable BLE error:', error);
    }
  }

  async function handleStartScan() {
    if (!bleEnabled) {
      statusMessage = 'Please enable Bluetooth first';
      return;
    }

    try {
      scanning = true;
      devices = [];
      statusMessage = 'Scanning for devices...';
      
      await startScan((result) => {
        // Add unique devices to the list
        const existingDevice = devices.find(d => d.deviceId === result.device.deviceId);
        if (!existingDevice) {
          devices = [...devices, result.device];
        }
      });
    } catch (error) {
      scanning = false;
      statusMessage = 'Failed to start scanning';
      console.error('Scan error:', error);
    }
  }

  async function handleStopScan() {
    try {
      await stopScan();
      scanning = false;
      statusMessage = `Scan stopped. Found ${devices.length} devices.`;
    } catch (error) {
      scanning = false;
      statusMessage = 'Error stopping scan';
      console.error('Stop scan error:', error);
    }
  }
</script>

<main>
  <header>
    <h1>🔵 Blumon</h1>
    <p class="subtitle">Bluetooth Low Energy Monitor</p>
    <p class="company">by ReVolt Labs</p>
  </header>

  <section class="status">
    <div class="status-card">
      <h2>Status</h2>
      <p class="status-message" class:error={!bleSupported} class:success={bleEnabled}>
        {statusMessage}
      </p>
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
          <span>Scanning</span>
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
      
      {#if bleEnabled}
        {#if !scanning}
          <button class="btn primary" on:click={handleStartScan}>
            Start Scanning
          </button>
        {:else}
          <button class="btn secondary" on:click={handleStopScan}>
            Stop Scanning
          </button>
        {/if}
      {/if}
    </div>
  </section>

  {#if devices.length > 0}
    <section class="devices">
      <h2>Discovered Devices ({devices.length})</h2>
      <div class="device-list">
        {#each devices as device}
          <div class="device-card">
            <div class="device-name">
              {device.name || 'Unknown Device'}
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

  <footer>
    <p>Built with SvelteKit + Capacitor + Bluetooth LE</p>
    <p>Ready for iOS, Android, and Web deployment</p>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
  }

  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    color: white;
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

  .devices h2 {
    margin-bottom: 1rem;
  }

  .device-list {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }

  .device-card {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    padding: 1.5rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .device-name {
    font-size: 1.2rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
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

  footer {
    text-align: center;
    margin-top: 3rem;
    opacity: 0.7;
  }

  footer p {
    margin: 0.5rem 0;
  }

  @media (max-width: 640px) {
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
  }
</style>
