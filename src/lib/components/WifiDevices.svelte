<script lang="ts">
  // Finding devices on Wi-Fi — and nothing else.
  //
  // A browser cannot browse mDNS, so this is the manual half of discovery: the remembered
  // list of hosts, plus a box to add one by name or IP. Once connected, the device appears in
  // the device list above with the SAME card, the same settings, the same OTA and the same
  // LED editor as a Bluetooth device. There is deliberately no per-device control here — a
  // second, lesser copy of the device card is exactly what this component used to be.
  //
  // Only works where cleartext ws:// to a LAN device is allowed: the native app + local dev
  // (not the deployed https site — mixed content).
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import { knownWifi, wifiStatus, connectWifi, forgetWifiDevice, rememberWifiDevice } from '$lib/stores/wifiDeviceStore';
  import { connectedDevices } from '$lib/stores/deviceStore';
  import { wifiIdFor } from '$lib/transport';

  // Wi-Fi needs the Local Network Privacy keys (NSLocalNetworkUsageDescription +
  // NSBonjourServices) in the native build; iOS silently blocks LAN on builds without them.
  // Those keys shipped in the 1.1.0 store build, so store builds need >= 1.1.0. But LOCAL dev
  // builds carry MARKETING_VERSION 0.0.1 (kept below the hot-update line so they always update)
  // and are always built from current code — so anything BELOW 1.0.0 is a dev build that has
  // the keys. Hide only the genuine pre-1.1.0 STORE builds (the 1.0.x range).
  // On web we only show it in local dev (http); deployed https can't do cleartext ws://.
  const WIFI_MIN_VERSION = '1.1.0';
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
      available = cmpVer(info.version, WIFI_MIN_VERSION) >= 0 // store 1.1.0+
        || cmpVer(info.version, '1.0.0') < 0;                // OR a sub-1.0 dev build (has keys)
    } catch { available = false; }
  });

  let manualHost = $state('');

  function addManual() {
    const h = manualHost.trim();
    if (!h) return;
    const name = h.replace(/\.local$/i, '');
    rememberWifiDevice(name, h);
    manualHost = '';
    void connectWifi(name, h).catch(() => { /* status store carries the error */ });
  }
</script>

{#if available}
<section class="wifi-section">
  <h2 class="wifi-title">Wi-Fi devices</h2>
  <p class="wifi-intro">
    Connect one and it joins the list above — same card, same settings as Bluetooth.
  </p>

  {#each $knownWifi as d (d.name)}
    {@const st = $wifiStatus[d.host]}
    {@const isConnected = $connectedDevices.has(wifiIdFor(d.host))}
    <div class="wifi-row">
      <div class="wifi-id">
        <strong>{d.name}</strong>
        <span class="wifi-host">{d.host}</span>
      </div>
      <div class="wifi-actions">
        {#if isConnected}
          <span class="pill on">Connected ↑</span>
        {:else if st?.state === 'connecting'}
          <span class="pill">Connecting…</span>
        {:else}
          <button class="btn primary small" onclick={() => connectWifi(d.name, d.host).catch(() => {})}>Connect</button>
          <button class="btn small" onclick={() => forgetWifiDevice(d.name)}>Forget</button>
        {/if}
      </div>
    </div>
    {#if st?.state === 'error' && !isConnected}
      <p class="err">Couldn’t connect: {st.error}. Is the device on Wi-Fi and on this network?</p>
    {/if}
  {/each}

  <div class="wifi-add">
    <input type="text" placeholder="device.local or 192.168.x.x" bind:value={manualHost}
      onkeydown={(e) => { if (e.key === 'Enter') addManual(); }} />
    <button class="btn small" onclick={addManual}>Connect</button>
  </div>
</section>
{/if}

<style>
  .wifi-section { margin-top: 1.5rem; }
  .wifi-title { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .wifi-intro { font-size: 0.82rem; opacity: 0.7; margin: 0 0 0.75rem; }
  .wifi-row {
    display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px; padding: 0.6rem 1rem; margin-bottom: 0.5rem;
  }
  .wifi-id strong { font-size: 1rem; } .wifi-host { display: block; font-size: 0.75rem; opacity: 0.6; }
  .wifi-actions { display: flex; gap: 0.4rem; align-items: center; }
  .btn { padding: 0.4rem 0.8rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-size: 0.85rem; }
  .btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  .btn.primary { background: rgba(59,130,246,0.5); border-color: rgba(59,130,246,0.7); }
  .pill { font-size: 0.8rem; opacity: 0.8; }
  .pill.on { color: #86efac; opacity: 1; }
  .err { color: #fca5a5; font-size: 0.82rem; margin: 0 0 0.5rem; }
  .wifi-add { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .wifi-add input { flex: 1; padding: 0.4rem 0.6rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: #fff; }
</style>
