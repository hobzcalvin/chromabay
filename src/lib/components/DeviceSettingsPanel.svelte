<script lang="ts">
  // All settings for a connected device (firmware feat>=2), organized into tabs. Reads/writes
  // the COMM_CONFIG characteristic over whatever transport the device is currently on. ONE
  // Save button writes everything in a single patch; picking a different transport (the
  // Bluetooth/Wi-Fi radio) and saving reboots the device into it, so the link drops — we show
  // clear feedback for that.
  import { readDeviceSettings, writeDeviceSettings, type DeviceSettings, type DeviceSettingsPatch, type DeviceInfo } from '$lib/ble';
  import { rememberWifiDevice } from '$lib/stores/wifiDeviceStore';
  import type { WifiDevice } from '$lib/wifiTransport';

  // Works over either transport: pass a BLE `deviceId`, OR a `wifi` handle for a device reached
  // over Wi-Fi. The panel is identical either way — same tabs, same single Save.
  let { deviceId, deviceInfo, wifi }: { deviceId?: string; deviceInfo: DeviceInfo | null; wifi?: WifiDevice } =
    $props();

  const readSettingsFn = (): Promise<DeviceSettings | null> =>
    wifi ? wifi.readSettings() : readDeviceSettings(deviceId!);
  const writeSettingsFn = (patch: DeviceSettingsPatch): Promise<void> =>
    wifi ? Promise.resolve(wifi.writeSettings(patch)) : writeDeviceSettings(deviceId!, patch);
  const key = $derived(deviceId ?? `wifi:${deviceInfo?.name ?? ''}`);

  // Wi-Fi only exists on feat>=2 firmware, so a wifi handle implies supported.
  const supported = $derived(!!wifi || (deviceInfo?.feat ?? 1) >= 2);

  let settings = $state<DeviceSettings | null>(null);
  let loading = $state(false);
  let loadedFor = $state<string | null>(null);
  let saving = $state(false);
  let msg = $state('');
  let msgKind = $state<'ok' | 'err' | 'info'>('info');
  let tab = $state<'connection' | 'schedule' | 'advanced'>('connection');

  // Form state
  let transport = $state<'ble' | 'wifi'>('ble');
  let ssid = $state('');
  let pass = $state('');
  let fallback = $state(0);
  let sleepMin = $state(0);
  let rgbTest = $state(true);
  let rtProto = $state(0);
  let rtUni = $state(0);
  let rtTimeout = $state(10);
  let rtLayout = $state(false);
  let schedEnable = $state(false);
  let schedOnStr = $state('20:00');
  let schedOffStr = $state('06:00');
  let schedDays = $state(0x7F); // bit0=Sun..bit6=Sat
  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const toggleDay = (d: number) => { schedDays ^= (1 << d); };
  const minToStr = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const strToMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (((h || 0) * 60 + (m || 0)) % 1440 + 1440) % 1440; };

  const activeMode = $derived(settings?.mode_active ?? deviceInfo?.mode ?? (wifi ? 'wifi' : 'ble'));

  function applySnapshot(s: DeviceSettings) {
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
    if (s.sdw != null) schedDays = s.sdw;
    transport = s.mode_active ?? deviceInfo?.mode ?? 'ble';
  }

  async function load() {
    if (!supported || loading || loadedFor === key) return;
    loading = true;
    try {
      const s = await readSettingsFn();
      settings = s;
      if (s) { applySnapshot(s); loadedFor = key; }
    } finally {
      loading = false;
    }
  }
  $effect(() => { if (supported && (deviceId || wifi)) load(); });

  function setMsg(text: string, kind: 'ok' | 'err' | 'info' = 'info') { msg = text; msgKind = kind; }

  async function save() {
    if (saving) return;
    if (transport === 'wifi' && !ssid.trim()) {
      tab = 'connection';
      setMsg('Enter a Wi-Fi network name to use Wi-Fi.', 'err');
      return;
    }
    const patch: DeviceSettingsPatch = {
      mode: transport,
      ssid: ssid.trim(),
      fallback,
      sleep: Math.max(0, Math.floor(sleepMin)),
      rgbtest: rgbTest,
      sen: schedEnable, son: strToMin(schedOnStr), sof: strToMin(schedOffStr),
      sdw: schedDays & 0x7F, tz: -new Date().getTimezoneOffset(),
      rtproto: rtProto, rtuni: Math.max(0, Math.floor(rtUni)),
      rtto: Math.max(1, Math.floor(rtTimeout)), rtlayout: rtLayout,
    };
    if (pass) patch.pass = pass; // password left blank = unchanged

    const switching = transport !== activeMode;
    const dest = transport === 'wifi' ? 'Wi-Fi' : 'Bluetooth';
    saving = true;
    setMsg(switching ? `Switching to ${dest}…` : 'Saving…', 'info');
    try {
      await writeSettingsFn(patch);
      if (switching) {
        if (transport === 'wifi' && deviceInfo?.name) rememberWifiDevice(deviceInfo.name);
        setMsg(transport === 'wifi'
          ? 'Restarting on Wi-Fi — it will reappear under Wi-Fi devices in a moment.'
          : 'Restarting on Bluetooth — reconnect from the device list.', 'ok');
      } else {
        pass = '';
        setMsg('Saved ✓', 'ok');
        const s2 = await readSettingsFn().catch(() => null); // refresh pill / hasPass / clock
        if (s2) settings = s2;
      }
    } catch (e: any) {
      if (switching) {
        // A dropped link right after the write is expected — the device rebooted.
        if (transport === 'wifi' && deviceInfo?.name) rememberWifiDevice(deviceInfo.name);
        setMsg(`Restarting on ${dest} — reconnect from the device list.`, 'ok');
      } else {
        setMsg('Couldn’t save: ' + (e?.message ?? e), 'err');
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="settings-section">
  {#if !supported}
    <p class="hint">Update this device's firmware to unlock Wi-Fi, the sleep timer, the on/off schedule, and streaming.</p>
  {:else if loading && !settings}
    <p class="hint">Reading settings…</p>
  {:else}
    <div class="tabs" role="tablist">
      <button role="tab" class:active={tab === 'connection'} aria-selected={tab === 'connection'} onclick={() => (tab = 'connection')}>Connection</button>
      <button role="tab" class:active={tab === 'schedule'} aria-selected={tab === 'schedule'} onclick={() => (tab = 'schedule')}>Schedule</button>
      <button role="tab" class:active={tab === 'advanced'} aria-selected={tab === 'advanced'} onclick={() => (tab = 'advanced')}>Advanced</button>
    </div>

    <div class="tab-body">
      {#if tab === 'connection'}
        <div class="field">
          <span class="lbl">Connect over</span>
          <div class="seg" role="group" aria-label="Transport">
            <button type="button" class:on={transport === 'ble'} aria-pressed={transport === 'ble'} onclick={() => (transport = 'ble')}>Bluetooth</button>
            <button type="button" class:on={transport === 'wifi'} aria-pressed={transport === 'wifi'} onclick={() => (transport = 'wifi')}>Wi-Fi</button>
          </div>
        </div>
        <p class="hint">
          Now on <strong>{activeMode === 'wifi' ? `Wi-Fi${settings?.ip ? ` · ${settings.ip}` : ''}` : 'Bluetooth'}</strong>.
          {#if transport !== activeMode}Saving restarts the device onto {transport === 'wifi' ? 'Wi-Fi' : 'Bluetooth'} — the current connection will drop.{/if}
        </p>

        {#if transport === 'wifi'}
          <label class="field">
            <span>Wi-Fi network</span>
            <input type="text" bind:value={ssid} placeholder="SSID" autocomplete="off" />
          </label>
          <label class="field">
            <span>Password</span>
            <input type="password" bind:value={pass} placeholder={settings?.hasPass ? '•••••• (unchanged)' : ''} autocomplete="off" />
          </label>
          <label class="field row">
            <span>If Wi-Fi fails</span>
            <select bind:value={fallback}>
              <option value={0}>Return to Bluetooth</option>
              <option value={1}>Start own hotspot</option>
            </select>
          </label>
        {/if}
      {:else if tab === 'schedule'}
        <label class="field check">
          <input type="checkbox" bind:checked={schedEnable} />
          <span>Turn the lights on/off automatically</span>
        </label>
        {#if schedEnable}
          <label class="field row">
            <span>Turn on at</span>
            <input type="time" bind:value={schedOnStr} />
          </label>
          <label class="field row">
            <span>Turn off at</span>
            <input type="time" bind:value={schedOffStr} />
          </label>
          <div class="field row">
            <span>On these days</span>
            <div class="seg" role="group" aria-label="Days of week">
              {#each DAY_LABELS as label, d}
                <button type="button" class="sq" class:on={(schedDays >> d) & 1}
                  aria-pressed={((schedDays >> d) & 1) === 1} onclick={() => toggleDay(d)}>{label}</button>
              {/each}
            </div>
          </div>
          {#if settings && settings.clk === 0}
            <p class="hint warn">This device doesn't know the time yet, so the schedule can't run. It learns the time from the app on connect, or from the internet on Wi-Fi.</p>
          {/if}
          <p class="hint">Uses your phone's time zone. On power loss it forgets the time and the schedule pauses until the app connects (or automatically on Wi-Fi). "Off" means brightness 0 — turn brightness up any time to override until the next scheduled change.</p>
        {/if}
      {:else}
        <label class="field row">
          <span>Sleep after (min, 0 = never)</span>
          <input type="number" min="0" max="1440" bind:value={sleepMin} />
        </label>
        <label class="field check">
          <input type="checkbox" bind:checked={rgbTest} />
          <span>Startup R/G/B test flash</span>
        </label>

        <div class="field row"><span class="lbl">Realtime streaming (Art-Net / sACN)</span></div>
        <label class="field row">
          <span>Protocol</span>
          <select bind:value={rtProto}>
            <option value={0}>Off</option>
            <option value={1}>Art-Net</option>
            <option value={2}>sACN (E1.31)</option>
            <option value={3}>Both</option>
          </select>
        </label>
        {#if rtProto !== 0}
          <label class="field row">
            <span>Start universe</span>
            <input type="number" min="0" max="63999" bind:value={rtUni} />
          </label>
          <label class="field row">
            <span>Revert after (s)</span>
            <input type="number" min="1" max="120" bind:value={rtTimeout} />
          </label>
          <label class="field row">
            <span>Pixel mapping</span>
            <select bind:value={rtLayout}>
              <option value={false}>True pixels (physical order)</option>
              <option value={true}>Custom layout (reorder/skip)</option>
            </select>
          </label>
          <p class="hint">Stream DMX to this device's IP{settings?.ip ? ` (${settings.ip})` : ''}. Takes over live and returns to the pattern {rtTimeout}s after the stream stops. Wi-Fi only.</p>
        {/if}
      {/if}
    </div>

    <div class="save-bar">
      <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
      {#if msg}<span class="msg {msgKind}">{msg}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .settings-section { display: flex; flex-direction: column; gap: 0.6rem; }

  /* Tabs */
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid rgba(255,255,255,0.12); }
  .tabs button {
    flex: 1; padding: 0.5rem 0.4rem; background: none; border: none; color: rgba(255,255,255,0.6);
    font-size: 0.85rem; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent;
  }
  .tabs button.active { color: #fff; border-bottom-color: #4f8cff; }

  .tab-body { display: flex; flex-direction: column; gap: 0.6rem; min-height: 3rem; }

  /* Fields */
  .field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; }
  .field.row { flex-direction: row; align-items: center; justify-content: space-between; gap: 0.6rem; }
  .field.check { flex-direction: row; align-items: center; gap: 0.5rem; }
  .field > span, .lbl { opacity: 0.8; }
  .lbl { font-size: 0.85rem; }
  input[type=text], input[type=password], input[type=number], input[type=time], select {
    padding: 0.4rem 0.55rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.06); color: inherit; font-size: 0.9rem;
  }
  input[type=number] { max-width: 6rem; }

  /* Segmented control — shared by the transport radio and the day toggles */
  .seg { display: inline-flex; }
  .seg button {
    padding: 0.4rem 0.9rem; border: 1px solid rgba(255,255,255,0.25); border-left-width: 0;
    background: rgba(255,255,255,0.06); color: #fff; font-size: 0.85rem; font-weight: 600; cursor: pointer;
  }
  .seg button.sq { width: 2rem; padding: 0.4rem 0; text-align: center; }
  .seg button:first-child { border-left-width: 1px; border-radius: 8px 0 0 8px; }
  .seg button:last-child { border-radius: 0 8px 8px 0; }
  .seg button.on { background: #4f8cff; border-color: #4f8cff; }
  .seg button.on + button { border-left-color: #4f8cff; }

  /* One button style */
  .btn {
    padding: 0.5rem 1.4rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.08); color: #fff; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .btn.primary { background: #4f8cff; border-color: #4f8cff; }
  .btn:disabled { opacity: 0.55; cursor: default; }

  .save-bar { display: flex; align-items: center; gap: 0.75rem; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 0.6rem; }
  .msg { font-size: 0.82rem; }
  .msg.ok { color: #86efac; }
  .msg.err { color: #fca5a5; }
  .msg.info { opacity: 0.85; }

  .hint { font-size: 0.82rem; opacity: 0.7; margin: 0; }
  .hint.warn { color: #fca5a5; opacity: 0.95; }
</style>
