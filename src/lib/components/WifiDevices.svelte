<script lang="ts">
  // Control ChromaBay devices over WiFi (WebSocket). Lists devices you've switched to WiFi
  // (or add one by host/IP), connects to ws://<host>:8080/, and drives brightness / pushes
  // the current pattern / cycle — the WiFi equivalent of the BLE device cards. Only works
  // where cleartext ws:// to a LAN device is allowed: the native app + local dev (not the
  // deployed https site — mixed content).
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Capacitor } from '@capacitor/core';
  import { knownWifi, wifiConns, connectWifi, disconnectWifi, forgetWifiDevice, rememberWifiDevice, hostForName } from '$lib/stores/wifiDeviceStore';
  import { currentPattern } from '$lib/stores/patternsStore';

  // First native build that carries the Local Network Privacy keys (NSLocalNetworkUsage-
  // Description + NSBonjourServices). Older installed builds can't reach LAN devices — iOS
  // silently blocks it — so we hide the whole WiFi section on them. On web we only show it in
  // local dev (http); the deployed https site can't do cleartext ws:// (mixed content).
  const WIFI_MIN_VERSION = '0.1.0';
  let available = $state(false);
  function cmpVer(a: string, b: string) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  onMount(async () => {
    if (Capacitor.getPlatform() === 'web') {
      available = typeof location !== 'undefined' && location.protocol === 'http:'; // local dev only
      return;
    }
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      available = cmpVer(info.version, WIFI_MIN_VERSION) >= 0;
    } catch { available = false; }
  });

  let manualHost = $state('');
  let bri = $state<Record<string, number>>({});
  let cycleOn = $state<Record<string, boolean>>({});
  let msg = $state<Record<string, string>>({});

  function addManual() {
    const h = manualHost.trim();
    if (!h) return;
    const name = h.replace(/\.local$/i, '');
    rememberWifiDevice(name, h);
    manualHost = '';
    connectWifi(name, h);
  }

  function pushCurrent(name: string) {
    const c = $wifiConns[name]; const p = get(currentPattern);
    if (c?.dev && p) { c.dev.sendPattern(p); msg[name] = `Pushed “${p.meta?.name ?? 'pattern'}”`; }
    else msg[name] = p ? 'Not connected' : 'No current pattern';
  }
  function onBri(name: string, v: number) {
    bri[name] = v; $wifiConns[name]?.dev?.setBrightness(v);
  }
  function toggleCycle(name: string) {
    const on = !(cycleOn[name] ?? false); cycleOn[name] = on;
    $wifiConns[name]?.dev?.setCycle(30000, on);
  }
</script>

{#if available}
<section class="wifi-section">
  <h2 class="wifi-title">WiFi devices</h2>
  <p class="wifi-intro">Devices switched to WiFi. Control them over your network (works in the app + local dev).</p>

  {#each $knownWifi as d (d.name)}
    {@const c = $wifiConns[d.name]}
    <div class="wifi-card">
      <div class="wifi-head">
        <div class="wifi-id">
          <strong>{d.name}</strong>
          <span class="wifi-host">{c?.info?.ip ? c.info.ip : d.host}</span>
        </div>
        <div class="wifi-actions">
          {#if c?.state === 'ready'}
            <button class="btn danger small" onclick={() => disconnectWifi(d.name)}>Disconnect</button>
          {:else if c?.state === 'connecting'}
            <span class="pill">Connecting…</span>
          {:else}
            <button class="btn primary small" onclick={() => connectWifi(d.name, d.host)}>Connect</button>
            <button class="btn small" onclick={() => forgetWifiDevice(d.name)}>Forget</button>
          {/if}
        </div>
      </div>

      {#if c?.state === 'error'}
        <p class="err">Couldn’t connect: {c.error}. Is the device on WiFi and on this network?</p>
      {/if}

      {#if c?.state === 'ready' && c.dev}
        <div class="wifi-body">
          <div class="row"><span class="lbl">Chip</span><span>{c.info?.chip ?? '—'} · fw {c.info?.fw_ver ?? '—'}</span></div>
          <label class="row">
            <span class="lbl">Brightness</span>
            <input type="range" min="0" max="255" value={bri[d.name] ?? 128}
              oninput={(e) => onBri(d.name, parseInt(e.currentTarget.value))} />
            <span class="val">{bri[d.name] ?? 128}</span>
          </label>
          <div class="btn-row">
            <button class="btn small" onclick={() => pushCurrent(d.name)}>Push current pattern</button>
            <button class="btn small" class:on={cycleOn[d.name]} onclick={() => toggleCycle(d.name)}>
              {cycleOn[d.name] ? '⏸ Cycle on' : '▶ Cycle'}
            </button>
          </div>
          {#if msg[d.name]}<p class="ok">{msg[d.name]}</p>{/if}
        </div>
      {/if}
    </div>
  {/each}

  <div class="wifi-add">
    <input type="text" placeholder="device.local or 192.168.x.x" bind:value={manualHost}
      onkeydown={(e) => { if (e.key === 'Enter') addManual(); }} />
    <button class="btn small" onclick={addManual}>Add / connect</button>
  </div>
</section>
{/if}

<style>
  .wifi-section { margin-top: 1.5rem; }
  .wifi-title { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .wifi-intro { font-size: 0.82rem; opacity: 0.7; margin: 0 0 0.75rem; }
  .wifi-card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 0.75rem 1rem; margin-bottom: 0.6rem; }
  .wifi-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .wifi-id strong { font-size: 1rem; } .wifi-host { display: block; font-size: 0.75rem; opacity: 0.6; }
  .wifi-actions { display: flex; gap: 0.4rem; align-items: center; }
  .wifi-body { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .row { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
  .lbl { opacity: 0.7; min-width: 5.5rem; }
  .row input[type=range] { flex: 1; }
  .val { min-width: 2.2rem; text-align: right; font-variant-numeric: tabular-nums; }
  .btn-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .btn { padding: 0.4rem 0.8rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-size: 0.85rem; }
  .btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  .btn.primary { background: rgba(59,130,246,0.5); border-color: rgba(59,130,246,0.7); }
  .btn.danger { background: rgba(239,68,68,0.4); }
  .btn.on { background: rgba(16,185,129,0.35); border-color: rgba(52,211,153,0.6); }
  .pill { font-size: 0.8rem; opacity: 0.8; }
  .err { color: #fca5a5; font-size: 0.82rem; margin: 0.4rem 0 0; }
  .ok { color: #86efac; font-size: 0.8rem; margin: 0.3rem 0 0; }
  .wifi-add { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .wifi-add input { flex: 1; padding: 0.4rem 0.6rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: #fff; }
</style>
