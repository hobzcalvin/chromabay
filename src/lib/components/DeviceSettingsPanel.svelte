<script lang="ts">
  // Connection & power settings for a connected device (firmware feat>=2): switch between
  // BLE and WiFi transport, provision WiFi credentials, set the sleep timer, and toggle the
  // boot RGB test. Self-contained — reads/writes the COMM_CONFIG characteristic itself over
  // whatever transport the device is currently on. Switching mode (or changing WiFi creds)
  // reboots the device, so we warn and expect the link to drop.
  import { readDeviceSettings, writeDeviceSettings, type DeviceSettings, type DeviceInfo } from '$lib/ble';
  import { rememberWifiDevice } from '$lib/stores/wifiDeviceStore';

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
  // Realtime streaming (Art-Net / sACN)
  let rtProto = $state(0);   // 0 off, 1 artnet, 2 sacn, 3 both
  let rtUni = $state(0);
  let rtTimeout = $state(10);
  let rtLayout = $state(false);
  // Daily on/off schedule
  let schedEnable = $state(false);
  let schedOnStr = $state('20:00');
  let schedOffStr = $state('06:00');
  const minToStr = (m: number) => {
    const h = Math.floor(m / 60) % 24, mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const strToMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (((h || 0) * 60 + (m || 0)) % 1440 + 1440) % 1440;
  };

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
        rtProto = s.rtproto ?? 0;
        rtUni = s.rtuni ?? 0;
        rtTimeout = s.rtto ?? 10;
        rtLayout = (s.rtlayout ?? 0) === 1;
        schedEnable = (s.sen ?? 0) === 1;
        if (s.son != null) schedOnStr = minToStr(s.son);
        if (s.sof != null) schedOffStr = minToStr(s.sof);
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
      // Remember it as a WiFi device so it shows up under "WiFi devices" to reconnect to.
      if (deviceInfo?.name) rememberWifiDevice(deviceInfo.name);
      msg = 'Sent. The device is restarting on Wi-Fi; reconnect from the WiFi devices list once it appears.';
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

  async function saveSchedule() {
    msg = '';
    try {
      // Send the phone's current UTC offset so the device can compute local time. (DST at
      // sync time is baked in; re-saving or reconnecting the app corrects it after a shift.)
      await writeDeviceSettings(deviceId, {
        sen: schedEnable, son: strToMin(schedOnStr), sof: strToMin(schedOffStr),
        tz: -new Date().getTimezoneOffset(),
      });
      msg = 'Schedule saved.';
    } catch (e: any) {
      msg = 'Failed to save: ' + (e?.message ?? e);
    }
  }

  async function saveStreaming() {
    msg = '';
    try {
      await writeDeviceSettings(deviceId, {
        rtproto: rtProto, rtuni: Math.max(0, Math.floor(rtUni)),
        rtto: Math.max(1, Math.floor(rtTimeout)), rtlayout: rtLayout,
      });
      msg = activeMode === 'wifi' ? 'Streaming settings saved.' : 'Saved — takes effect on Wi-Fi.';
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

    <!-- Daily on/off schedule -->
    <div class="power-form">
      <div class="row"><span class="lbl">Daily on/off schedule</span></div>
      <label class="check">
        <input type="checkbox" bind:checked={schedEnable} />
        <span>Turn the lights on/off automatically</span>
      </label>
      {#if schedEnable}
        <label class="inline">
          <span>Turn on at</span>
          <input type="time" bind:value={schedOnStr} />
        </label>
        <label class="inline">
          <span>Turn off at</span>
          <input type="time" bind:value={schedOffStr} />
        </label>
        {#if settings && settings.clk === 0}
          <p class="hint warn">This device doesn't know the current time yet, so the schedule can't run. It learns the time from the app when you connect, or from the internet when it's on Wi-Fi.</p>
        {/if}
        <p class="hint">Uses your phone's time zone. If the device loses power it forgets the time and the schedule pauses until the app connects again — or automatically if it's on Wi-Fi (it fetches the time itself). Note: "off" just blanks the LEDs; it can't cut their power.</p>
      {/if}
      <div class="btn-row">
        <button class="btn secondary small" onclick={saveSchedule}>Save schedule</button>
      </div>
    </div>

    <!-- Realtime streaming (Art-Net / sACN) -->
    <div class="power-form">
      <div class="row"><span class="lbl">Realtime streaming (Art-Net / sACN)</span></div>
      <label class="inline">
        <span>Protocol</span>
        <select bind:value={rtProto}>
          <option value={0}>Off</option>
          <option value={1}>Art-Net</option>
          <option value={2}>sACN (E1.31)</option>
          <option value={3}>Both</option>
        </select>
      </label>
      {#if rtProto !== 0}
        <label class="inline">
          <span>Start universe</span>
          <input type="number" min="0" max="63999" bind:value={rtUni} />
        </label>
        <label class="inline">
          <span>Revert after (s)</span>
          <input type="number" min="1" max="120" bind:value={rtTimeout} />
        </label>
        <label class="inline">
          <span>Pixel mapping</span>
          <select bind:value={rtLayout}>
            <option value={false}>True pixels (physical order)</option>
            <option value={true}>Custom layout (reorder/skip)</option>
          </select>
        </label>
        <p class="hint">Stream DMX to this device's IP{settings?.ip ? ` (${settings.ip})` : ''}. It takes over live and returns to its pattern/cycle {rtTimeout}s after the stream stops. Only active on Wi-Fi.</p>
      {/if}
      <div class="btn-row">
        <button class="btn secondary small" onclick={saveStreaming}>Save streaming settings</button>
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
  .hint.warn { color: #fca5a5; opacity: 0.95; }
  .msg { font-size: 0.82rem; opacity: 0.9; margin-top: 0.4rem; }
</style>
