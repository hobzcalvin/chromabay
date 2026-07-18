<script lang="ts">
  // Connection & power settings for a connected device (firmware feat>=2): switch between
  // BLE and WiFi transport, provision WiFi credentials, set the sleep timer, and toggle the
  // boot RGB test. Self-contained — reads/writes the COMM_CONFIG characteristic itself over
  // whatever transport the device is currently on. Switching mode (or changing WiFi creds)
  // reboots the device, so we warn and expect the link to drop.
  import { readDeviceSettings, writeDeviceSettings, type DeviceSettings, type DeviceInfo } from '$lib/ble';

  let { deviceId, deviceInfo }: { deviceId: string; deviceInfo: DeviceInfo | null } = $props();

  // feat>=2 firmware exposes COMM_CONFIG. Older firmware: show an upgrade hint instead.
  const supported = $derived((deviceInfo?.feat ?? 1) >= 2);

  let settings = $state<DeviceSettings | null>(null);
  let loading = $state(false);
  let loadedFor = $state<string | null>(null); // deviceId we loaded for (avoid re-loading)
  let msg = $state('');

  // Form state
  let ssid = $state('');
  let pass = $state('');
  let fallback = $state(0); // 0 = revert to BLE, 1 = SoftAP
  let sleepMin = $state(0);
  let rgbTest = $state(true);

  async function load() {
    if (!supported || loading || loadedFor === deviceId) return;
    loading = true;
    try {
      const s = await readDeviceSettings(deviceId);
      settings = s;
      if (s) {
        ssid = s.ssid || '';
        fallback = s.fallback ?? 0;
        sleepMin = s.sleep ?? 0;
        rgbTest = (s.rgbtest ?? 1) === 1;
        loadedFor = deviceId;
      }
    } finally {
      loading = false;
    }
  }
  // Load once the device (and its feat level) is known.
  $effect(() => { if (supported && deviceId) load(); });

  const activeMode = $derived(settings?.mode_active ?? deviceInfo?.mode ?? 'ble');

  async function switchToWifi() {
    if (!ssid.trim()) { msg = 'Enter a Wi-Fi network name.'; return; }
    msg = 'Switching to Wi-Fi — the device will restart and leave Bluetooth…';
    try {
      await writeDeviceSettings(deviceId, {
        mode: 'wifi', ssid: ssid.trim(), pass: pass, fallback,
      });
      msg = 'Sent. The device is restarting on Wi-Fi; reconnect from the device list once it appears.';
    } catch (e: any) {
      // A dropped link right after the write is expected (device rebooted) — treat as success.
      msg = 'Device is restarting on Wi-Fi. Reconnect from the device list once it appears.';
    }
  }

  async function switchToBle() {
    msg = 'Switching back to Bluetooth — the device will restart…';
    try {
      await writeDeviceSettings(deviceId, { mode: 'ble' });
      msg = 'Sent. The device is restarting on Bluetooth.';
    } catch {
      msg = 'Device is restarting on Bluetooth.';
    }
  }

  async function savePower() {
    msg = '';
    try {
      await writeDeviceSettings(deviceId, { sleep: Math.max(0, Math.floor(sleepMin)), rgbtest: rgbTest });
      msg = 'Saved.';
    } catch (e: any) {
      msg = 'Failed to save: ' + (e?.message ?? e);
    }
  }
</script>

<div class="settings-section">
  <h4>Connection &amp; Power</h4>

  {#if !supported}
    <p class="hint">Update this device's firmware to enable Wi-Fi mode, the sleep timer, and the startup-test toggle.</p>
  {:else if loading && !settings}
    <p class="hint">Reading settings…</p>
  {:else}
    <!-- Transport -->
    <div class="row">
      <span class="lbl">Transport</span>
      <span class="pill {activeMode === 'wifi' ? 'wifi' : 'ble'}">
        {activeMode === 'wifi' ? `Wi-Fi${settings?.ip ? ' · ' + settings.ip : ''}` : 'Bluetooth'}
      </span>
    </div>

    {#if activeMode === 'wifi'}
      <p class="hint">This device is on Wi-Fi. You can update its credentials, or switch it back to Bluetooth.</p>
    {/if}

    <div class="wifi-form">
      <label>
        <span>Wi-Fi network</span>
        <input type="text" bind:value={ssid} placeholder="SSID" autocomplete="off" />
      </label>
      <label>
        <span>Password</span>
        <input type="password" bind:value={pass} placeholder={settings?.hasPass ? '•••••• (unchanged)' : ''} autocomplete="off" />
      </label>
      <label class="inline">
        <span>If Wi-Fi fails</span>
        <select bind:value={fallback}>
          <option value={0}>Return to Bluetooth</option>
          <option value={1}>Start own hotspot</option>
        </select>
      </label>
      <div class="btn-row">
        <button class="btn primary small" onclick={switchToWifi}>
          {activeMode === 'wifi' ? 'Update Wi-Fi' : 'Switch to Wi-Fi'}
        </button>
        {#if activeMode === 'wifi'}
          <button class="btn secondary small" onclick={switchToBle}>Back to Bluetooth</button>
        {/if}
      </div>
    </div>

    <!-- Power / boot -->
    <div class="power-form">
      <label class="inline">
        <span>Sleep after (min, 0 = never)</span>
        <input type="number" min="0" max="1440" bind:value={sleepMin} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={rgbTest} />
        <span>Startup R/G/B test flash</span>
      </label>
      <div class="btn-row">
        <button class="btn secondary small" onclick={savePower}>Save power settings</button>
      </div>
    </div>
  {/if}

  {#if msg}<p class="msg">{msg}</p>{/if}
</div>

<style>
  .row { display: flex; align-items: center; gap: 0.5rem; margin: 0.25rem 0 0.5rem; }
  .lbl { opacity: 0.7; font-size: 0.85rem; }
  .pill { font-size: 0.8rem; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; }
  .pill.ble { background: rgba(59,130,246,0.2); color: #93c5fd; }
  .pill.wifi { background: rgba(34,197,94,0.2); color: #86efac; }
  .wifi-form, .power-form { display: flex; flex-direction: column; gap: 0.5rem; margin: 0.5rem 0; }
  .power-form { border-top: 1px solid rgba(255,255,255,0.1); padding-top: 0.6rem; }
  label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
  label.inline { flex-direction: row; align-items: center; justify-content: space-between; }
  label.check { flex-direction: row; align-items: center; gap: 0.5rem; }
  label span { opacity: 0.8; }
  input[type=text], input[type=password], input[type=number], select {
    padding: 0.35rem 0.5rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.06); color: inherit; font-size: 0.9rem;
  }
  input[type=number] { max-width: 6rem; }
  .btn-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .hint { font-size: 0.82rem; opacity: 0.7; }
  .msg { font-size: 0.82rem; opacity: 0.9; margin-top: 0.4rem; }
</style>
