<script lang="ts">
  // "Convert a WLED device to ChromaBay over Wi-Fi." Native-only (the parent gates this
  // to non-web, since a secure web page can't do cleartext HTTP). Uses the offline
  // firmware cache: the user prefetches the image while online (Devices → a connected
  // device's update section does this), joins the device's WLED-AP, then converts here
  // with no internet needed.
  import { listCachedFirmware, getFirmware } from '$lib/firmwareCache';
  import { flashFirmwareViaWledHttp, WLED_AP_SSID, WLED_AP_PASS } from '$lib/wledOta';

  let expanded = $state(false);
  let cached = $state<{ version: string; date: string; cachedAt: number }[]>([]);
  let busy = $state(false);
  let message = $state('');
  let result = $state<'idle' | 'sent' | 'confirmed' | 'error'>('idle');

  async function refreshCache() {
    cached = await listCachedFirmware();
  }

  async function toggle() {
    expanded = !expanded;
    if (expanded) await refreshCache();
  }

  async function convert() {
    const latest = cached[0]; // newest by cachedAt
    if (!latest) { message = 'No cached firmware yet — see the note above.'; result = 'error'; return; }
    const fw = await getFirmware(latest.version);
    if (!fw) { message = 'Cached image could not be read. Re-cache it while online.'; result = 'error'; return; }

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

<div class="wled-convert">
  <button class="wled-head" onclick={toggle} aria-expanded={expanded}>
    <span>Convert a WLED device</span>
    <span class="chev">{expanded ? '▾' : '▸'}</span>
  </button>

  {#if expanded}
    <div class="wled-body">
      <p class="lead">Flash ChromaBay onto a device currently running WLED, over its own Wi-Fi — no USB.</p>
      <ol>
        <li>First cache the firmware <strong>while you have internet</strong>: open a connected ChromaBay device's update section once (it prefetches automatically).</li>
        <li>In iOS <strong>Settings → Wi-Fi</strong>, join the device's network
          <code>{WLED_AP_SSID}</code> (password <code>{WLED_AP_PASS}</code>), then return here.</li>
        <li>Tap Convert. The device reboots into ChromaBay when done.</li>
      </ol>

      {#if cached.length === 0}
        <p class="warn">No firmware cached yet — do step 1 first.</p>
      {:else}
        <p class="cached">Will flash cached <strong>{cached[0].version}</strong>.</p>
      {/if}

      <button class="btn primary" onclick={convert} disabled={busy || cached.length === 0}>
        {busy ? 'Uploading…' : 'Convert this device'}
      </button>

      {#if message}
        <p class="msg" class:ok={result === 'confirmed'} class:sent={result === 'sent'} class:err={result === 'error'}>{message}</p>
      {/if}
      <p class="fineprint">Confirmation is best-effort — WLED reboots mid-reply. If the device restarts and its LEDs change, it worked. (This path is new and unverified on hardware.)</p>
    </div>
  {/if}
</div>

<style>
  .wled-convert { border-top: 1px solid rgba(255, 255, 255, 0.12); padding-top: 1.25rem; }
  .wled-head {
    width: 100%; display: flex; justify-content: space-between; align-items: center;
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1.05rem; font-weight: 600; opacity: 0.95; padding: 0;
  }
  .chev { opacity: 0.7; }
  .wled-body { margin-top: 0.75rem; font-size: 0.9rem; }
  .lead { opacity: 0.9; margin: 0 0 0.75rem; }
  ol { margin: 0 0 0.75rem; padding-left: 1.2rem; line-height: 1.5; }
  code { background: rgba(255, 255, 255, 0.12); padding: 0.05rem 0.3rem; border-radius: 4px; }
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
