<script lang="ts">
  // "Convert a WLED device to ChromaBay." Two paths:
  //  - Automated (NATIVE only): the app POSTs the firmware to WLED's /update over the
  //    device's AP. Web can't (a secure page can't do cleartext HTTP — mixed content).
  //  - Manual (EVERYWHERE): download the .bin and upload it in WLED's own web UI.
  // Both use the same firmware everyone else gets (the automated path from the offline
  // cache so it works with no internet; the manual path via a direct download link).
  // Also documents the REVERSE (ChromaBay -> WLED): grab WLED's own firmware and flash it
  // over USB, or via the app's in-app "Install from a file" (unsigned) OTA — text only.
  import { Capacitor } from '@capacitor/core';
  import { listCachedFirmware, getFirmware } from '$lib/firmwareCache';
  import { flashFirmwareViaWledHttp, WLED_AP_SSID, WLED_AP_PASS } from '$lib/wledOta';
  import { fetchFirmwareRegistry, resolveFirmware, prefetchFirmware } from '$lib/ble';
  import FirmwareDownloads from './FirmwareDownloads.svelte';

  const isNative = Capacitor.getPlatform() !== 'web';
  const REGISTRY_URL = 'https://chromabay.app/firmware/esp32/esp32_firmware_registry.json';

  let open = $state(false);
  let cached = $state<{ key: string; version: string; date: string; cachedAt: number }[]>([]);
  let preparing = $state(false);
  let ready = $derived(cached.length > 0);
  let busy = $state(false);
  let message = $state('');
  let result = $state<'idle' | 'sent' | 'confirmed' | 'error'>('idle');

  async function toggle() {
    open = !open;
    if (open && isNative) prepare();
  }

  // Fetch the ChromaBay firmware and stash it locally so the conversion works once we're
  // joined to the WLED device's Wi-Fi (which has no internet). Needs internet, so we do it
  // the moment this section opens. WLED boards are classic ESP32 with ≥1.4MB app slots, so
  // the no-WiFi build always fits; once it's ChromaBay it can upgrade to the WiFi build OTA.
  async function prepare() {
    preparing = true;
    try {
      cached = await listCachedFirmware();
      const reg = await fetchFirmwareRegistry(REGISTRY_URL);
      const entry = resolveFirmware(reg, 'esp32').recommended;
      if (entry) {
        const base = 'https://chromabay.app';
        await prefetchFirmware(entry.version, entry.date, `${base}/${entry.path}`, `${base}/${entry.signaturePath}`);
      }
      cached = await listCachedFirmware();
    } catch { /* offline / registry unreachable — the readiness note tells the user */ }
    finally { preparing = false; }
  }

  async function convert() {
    const latest = cached[0]; // newest by cachedAt
    if (!latest) { message = 'Firmware not ready. Connect to the internet and reopen this section.'; result = 'error'; return; }
    const fw = await getFirmware(latest.version, latest.key);
    if (!fw) { message = 'Firmware could not be read. Connect to the internet and reopen this section.'; result = 'error'; return; }

    busy = true; result = 'idle'; message = '';
    try {
      const r = await flashFirmwareViaWledHttp(fw.bin, undefined, (m) => (message = m));
      result = r.confirmed ? 'confirmed' : 'sent';
    } catch (e: any) {
      result = 'error';
      message = `Couldn't reach the device. Make sure you're joined to its "${WLED_AP_SSID}" Wi-Fi. (${e?.message ?? e})`;
    } finally {
      busy = false;
    }
  }
</script>

<div class="method">
  <button class="method-head" onclick={toggle} aria-expanded={open}>
    <span>Convert a WLED device</span>
    <span class="chev">{open ? '▾' : '▸'}</span>
  </button>

  {#if open}
    <div class="method-body">

      {#if isNative}
        <!-- Automated path (native app only) -->
        <div class="path">
          <h5>Let the app do it</h5>
          <p class="lead">Flash ChromaBay onto a WLED board over its Wi-Fi — no cable.</p>
          <ol>
            <li>In <strong>Settings → Wi-Fi</strong>, join the WLED device's network
              <code>{WLED_AP_SSID}</code> (password <code>{WLED_AP_PASS}</code>), then come back here.</li>
            <li>Tap <strong>Convert</strong>. The device reboots into ChromaBay when it's done.</li>
          </ol>
          {#if preparing}
            <p class="cached">Getting firmware ready…</p>
          {:else if !ready}
            <p class="warn">Couldn't get the firmware — connect to the internet and reopen this section (it's needed before you join the WLED Wi-Fi).</p>
          {:else}
            <p class="cached">✓ Firmware ready.</p>
          {/if}
          <button class="btn primary" onclick={convert} disabled={busy || !ready}>
            {busy ? 'Uploading…' : 'Convert this device'}
          </button>
          {#if message}
            <p class="msg" class:ok={result === 'confirmed'} class:sent={result === 'sent'} class:err={result === 'error'}>{message}</p>
          {/if}
          <p class="fineprint">Best for classic ESP32 boards; for ESP32-S3/C3 use the manual method below.
            Confirmation is best-effort — WLED reboots mid-reply, so if the board restarts and its
            LEDs change, it worked. (New; unverified on hardware.)</p>
        </div>
      {/if}

      <!-- Manual path (works everywhere) -->
      <div class="path">
        <h5>Or do it yourself</h5>
        <ol>
          <li>Download the ChromaBay <strong>firmware .bin</strong> for your board's chip (below).</li>
          <li>Open the device's WLED web UI (e.g. <code>http://4.3.2.1</code> on its AP, or its IP on your network).</li>
          <li>Go to <strong>Config → Security &amp; Updates</strong>, and under <strong>Manual OTA update</strong> choose the file and upload. WLED reboots into ChromaBay.</li>
        </ol>
        <FirmwareDownloads kind="app" />
      </div>

      <!-- Reverse: ChromaBay → WLED -->
      <div class="path">
        <h5>Going back to WLED</h5>
        <p class="lead">ChromaBay doesn't run a web server, so there's no captive-portal upload to
          reverse. Instead, get WLED's own firmware and flash it — over USB, or with ChromaBay's
          in-app manual update.</p>
        <ol>
          <li><strong>Get WLED firmware for your board.</strong> Easiest is
            <a class="dl" href="https://install.wled.me" target="_blank" rel="noopener">install.wled.me</a>
            (their official web installer). To flash it yourself, download the matching
            <code>.bin</code> from
            <a class="dl" href="https://github.com/wled/WLED/releases" target="_blank" rel="noopener">WLED's releases</a>
            — pick the build for your chip (e.g. <code>ESP32</code>).</li>
          <li><strong>Flash over USB (most reliable).</strong> Plug the board into a computer and use
            install.wled.me, or the <em>Flash a new board over USB</em> option above. This works
            for any chip and can always recover a device.</li>
          <li><strong>Or flash in-app, no cable.</strong> On a connected device open
            <strong>Show Settings → Firmware Update → Install from a file</strong>, pick the WLED
            <code>.bin</code>, leave the signature empty, and flash the <em>unsigned</em> image.</li>
        </ol>
        <p class="fineprint">The image must be built for this device's chip (ESP32) — a mismatched
          image is rejected, and a bad flash may need USB recovery. WLED is unsigned, so the in-app
          update will warn that it's skipping the signature check; that's expected here.</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .method { border-top: 1px solid rgba(255, 255, 255, 0.12); padding-top: 1.25rem; }
  .method-head {
    width: 100%; display: flex; justify-content: space-between; align-items: center;
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1.05rem; font-weight: 600; opacity: 0.95; padding: 0;
  }
  .chev { opacity: 0.7; }
  .method-body { margin-top: 0.75rem; font-size: 0.9rem; }
  .lead { opacity: 0.9; margin: 0 0 0.75rem; }
  .path { padding: 0.75rem 0; }
  .path + .path { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  h5 { margin: 0 0 0.5rem; font-size: 0.95rem; opacity: 0.9; }
  ol { margin: 0 0 0.5rem; padding-left: 1.2rem; line-height: 1.5; }
  code { background: rgba(255, 255, 255, 0.12); padding: 0.05rem 0.3rem; border-radius: 4px; }
  .dl { color: #93c5fd; font-weight: 600; }
  .warn { color: #fbbf24; }
  .cached { opacity: 0.85; }
  .msg { margin-top: 0.6rem; }
  .msg.ok { color: #4ade80; }
  .msg.sent { color: #93c5fd; }
  .msg.err { color: #f87171; }
  .fineprint { margin-top: 0.6rem; font-size: 0.78rem; opacity: 0.6; line-height: 1.4; }
  .btn {
    padding: 0.5rem 1rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
    cursor: pointer; color: white; background: linear-gradient(135deg, #3b82f6, #1d4ed8);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
