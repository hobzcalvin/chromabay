<script lang="ts">
  // "Flash a new board over USB" — like install.wled.me. Uses esp-web-tools (Web Serial),
  // desktop-Chromium only. Collapsible: stays a one-line row until the user opens it. Reads
  // the SAME firmware everyone gets, from the published manifest (no committed .bin). The
  // manifest lists a build per chip (ESP32 / S3 / C3); esp-web-tools auto-detects the
  // connected chip and installs the matching one, refusing a mismatch.
  import { Capacitor } from '@capacitor/core';
  import FirmwareDownloads from './FirmwareDownloads.svelte';

  // Single source of truth: the manifest the firmware CI publishes, pointing at the newest
  // merged factory image. No manifest/.bin committed in this repo.
  const MANIFEST_URL = 'https://chromabay.app/firmware/esp32/chromabay-manifest.json';

  let open = $state(false);
  type Phase = 'idle' | 'checking' | 'ready' | 'unavailable' | 'wrongbrowser' | 'native';
  let phase = $state<Phase>('idle');

  async function toggle() {
    open = !open;
    if (!open || phase !== 'idle') return;

    if (Capacitor.getPlatform() !== 'web') { phase = 'native'; return; }
    if (!('serial' in navigator)) { phase = 'wrongbrowser'; return; }

    phase = 'checking';
    try {
      await import('esp-web-tools'); // registers <esp-web-install-button>
      // Confirm the published manifest exists (it appears after the first firmware build
      // that includes the merged image). Same-origin in prod; a dev/CORS failure just
      // falls through to the button, which will surface its own error if truly missing.
      try {
        const r = await fetch(MANIFEST_URL, { method: 'GET', cache: 'no-store' });
        phase = r.ok ? 'ready' : 'unavailable';
      } catch {
        phase = 'ready';
      }
    } catch {
      phase = 'unavailable';
    }
  }
</script>

<div class="method">
  <button class="method-head" onclick={toggle} aria-expanded={open}>
    <span>Flash a new board over USB</span>
    <span class="chev">{open ? '▾' : '▸'}</span>
  </button>

  {#if open}
    <div class="method-body">
      {#if phase === 'checking'}
        <p class="note">Loading…</p>
      {:else if phase === 'native'}
        <p class="note">USB flashing runs in <strong>desktop Chrome or Edge</strong> — open chromabay.app there, plug in the board, and flash.</p>
      {:else if phase === 'wrongbrowser'}
        <p class="note">This browser can't talk to USB. Open ChromaBay in <strong>desktop Chrome or Edge</strong>.</p>
      {:else if phase === 'unavailable'}
        <p class="note">USB flashing becomes available after the next firmware release (it installs the same image as OTA).</p>
      {:else if phase === 'ready'}
        <p class="lead">Install ChromaBay on any ESP32, ESP32-S3, or ESP32-C3 — even a blank
          board, or one running WLED (this erases it). The flasher detects your chip
          automatically and installs the matching build.</p>
        <esp-web-install-button manifest={MANIFEST_URL}>
          <button slot="activate" class="btn">⚡ Flash ChromaBay over USB</button>
          <span slot="unsupported" class="note">This browser can't flash over USB (needs Web Serial).</span>
          <span slot="not-allowed" class="note">Allow the serial device when prompted, then retry.</span>
        </esp-web-install-button>
        <p class="hint">Connect the board with USB, then click to install.</p>
        <details class="dl-details">
          <summary>What's the “Erase device” checkbox?</summary>
          <p class="hint">The install dialog offers an <strong>Erase device</strong> option — it's a full-chip
            wipe before flashing.</p>
          <p class="hint"><strong>Leave it off</strong> to update ChromaBay and keep everything: your stored
            patterns, LED-strip config, Wi-Fi credentials, device name, and settings all survive.</p>
          <p class="hint"><strong>Turn it on</strong> for a clean slate — wipes all of that, so the board comes
            up factory-fresh (Bluetooth, no Wi-Fi, no patterns). Use it when <em>converting from WLED or other
            firmware</em> (their old data would be stale under ChromaBay's layout), or to reset a misbehaving
            device.</p>
        </details>
      {/if}

      <!-- Manual download of the per-chip images (flash with esptool, or when Web Serial
           isn't available — e.g. from the iOS app or a non-Chromium browser). -->
      <details class="dl-details">
        <summary>Download the image and flash it yourself</summary>
        <FirmwareDownloads kind="factory" />
        <p class="hint">Flash with esptool, e.g.
          <code>esptool.py --chip esp32s3 write_flash 0x0 chromabay-factory-esp32s3.bin</code>
          (use your chip's <code>--chip</code> name).</p>
      </details>
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
  .method-body { margin-top: 0.75rem; font-size: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  .lead { opacity: 0.9; margin: 0; }
  .btn { padding: 0.5rem 1rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
    cursor: pointer; background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
  .hint { font-size: 0.78rem; opacity: 0.7; margin: 0; }
  .note { font-size: 0.85rem; opacity: 0.8; margin: 0; }
  .dl-details { width: 100%; margin-top: 0.5rem; }
  .dl-details summary { cursor: pointer; font-weight: 600; font-size: 0.85rem; opacity: 0.9; }
  .dl-details > :global(*) { margin-top: 0.6rem; }
  code { background: rgba(255,255,255,0.12); padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.85em; word-break: break-all; }
</style>
