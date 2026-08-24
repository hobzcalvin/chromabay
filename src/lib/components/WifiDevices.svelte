<script lang="ts">
  // Finding devices on Wi-Fi — and nothing else.
  //
  // iOS browses `_chromabay._tcp` and adds nearby devices to this list automatically. A
  // browser cannot browse mDNS, so there this is the manual half of discovery: remembered
  // hosts plus a box to add one by name or IP. Once connected, the device appears in the
  // device list above with the SAME card, settings, OTA and LED editor as a Bluetooth device.
  //
  // Chrome 147+ can authorize cleartext ws:// to a .local/private address from the deployed
  // HTTPS site through its Local Network Access permission prompt. Other web engines cannot.
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import {
    wifiDevices,
    wifiStatus,
    connectWifi,
    forgetWifiDevice,
    rememberWifiDevice,
    startWifiDiscovery
  } from '$lib/stores/wifiDeviceStore';
  import { connectedDevices } from '$lib/stores/deviceStore';
  import { wifiIdFor } from '$lib/transport';
  import { canUseWebWifi } from '$lib/localNetworkAccess';

  // Wi-Fi needs the Local Network Privacy keys (NSLocalNetworkUsageDescription +
  // NSBonjourServices) in the native build; iOS silently blocks LAN on builds without them.
  // Those keys shipped in the 1.1.0 store build, so store builds need >= 1.1.0. But LOCAL dev
  // builds carry MARKETING_VERSION 0.0.1 (kept below the hot-update line so they always update)
  // and are always built from current code — so anything BELOW 1.0.0 is a dev build that has
  // the keys. Hide only the genuine pre-1.1.0 STORE builds (the 1.0.x range).
  // On web, local HTTP development works directly. Production HTTPS is available only in a
  // Chromium version that puts local WebSockets behind a user permission instead of blocking
  // them as mixed content.
  const WIFI_MIN_VERSION = '1.1.0';
  let available = $state(false);
  let usesBrowserPermission = $state(false);
  let usesBonjourDiscovery = $state(false);
  let discoveryError = $state('');
  function cmpVer(a: string, b: string) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }
  onMount(() => {
    let disposed = false;
    let stopDiscovery: (() => Promise<void>) | undefined;

    void (async () => {
      const platform = Capacitor.getPlatform();
      if (platform === 'web') {
        const protocol = typeof location === 'undefined' ? '' : location.protocol;
        const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
        available = canUseWebWifi(protocol, userAgent);
        usesBrowserPermission = available && protocol === 'https:';
        return;
      }

      try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        available = cmpVer(info.version, WIFI_MIN_VERSION) >= 0 // store 1.1.0+
          || cmpVer(info.version, '1.0.0') < 0;                // OR a sub-1.0 dev build (has keys)

        // Native code ships in the binary, not a live-update bundle. Keep older 1.1.x
        // installations usable if they receive this web bundle before the new binary.
        if (
          available
          && platform === 'ios'
          && Capacitor.isPluginAvailable('BonjourDiscovery')
        ) {
          usesBonjourDiscovery = true;
          const stop = await startWifiDiscovery((message) => { discoveryError = message; });
          if (disposed) await stop();
          else stopDiscovery = stop;
        }
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error);
      }
    })();

    return () => {
      disposed = true;
      if (stopDiscovery) void stopDiscovery();
    };
  });

  let manualHost = $state('');

  function addManual() {
    // DNS/mDNS hostnames are case-insensitive and the firmware advertises a lowercase name.
    // Canonicalizing also prevents duplicate remembered entries that differ only by case.
    const h = manualHost.trim().toLowerCase();
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
  {#if usesBrowserPermission}
    <p class="wifi-intro lna-note">
      Chrome will ask for Local Network Access the first time you connect. Choose Allow.
    </p>
  {:else if usesBonjourDiscovery}
    <p class="wifi-intro lna-note">
      Nearby ChromaBay devices appear automatically.
    </p>
  {/if}
  {#if discoveryError}
    <p class="err">{discoveryError}</p>
  {/if}

  {#each $wifiDevices as d (d.host)}
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
          {#if d.remembered}
            <button class="btn small" onclick={() => forgetWifiDevice(d.host)}>Forget</button>
          {/if}
        {/if}
      </div>
    </div>
    {#if st?.state === 'error' && !isConnected}
      <p class="err">
        Couldn’t connect: {st.error}. Is the device on Wi-Fi and on this network?
        {#if usesBrowserPermission} Also check that Local Network Access is allowed in Chrome’s site settings.{/if}
      </p>
    {/if}
  {/each}

  <div class="wifi-add">
    <input type="text" inputmode="url" autocapitalize="none" autocomplete="off"
      autocorrect="off" spellcheck={false} enterkeyhint="go"
      placeholder="device.local or 192.168.x.x" bind:value={manualHost}
      onkeydown={(e) => { if (e.key === 'Enter') addManual(); }} />
    <button class="btn small" onclick={addManual}>Connect</button>
  </div>
</section>
{/if}

<style>
  .wifi-section { margin-top: 1.5rem; }
  .wifi-title { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .wifi-intro { font-size: 0.82rem; opacity: 0.7; margin: 0 0 0.75rem; }
  .lna-note { color: #bfdbfe; opacity: 0.9; }
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
