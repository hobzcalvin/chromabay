<script lang="ts">
  // "Flash ChromaBay over USB" — like install.wled.me. Uses esp-web-tools (Web Serial), so it only
  // works in a Chromium desktop browser; we hide it everywhere else (iOS app, Safari, Firefox).
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import { base } from '$app/paths';

  let ready = $state(false);     // esp-web-tools loaded + Web Serial available
  let note = $state('');         // why it's unavailable (when it is)
  const manifest = `${base}/firmware/chromabay-manifest.json`;

  onMount(async () => {
    if (Capacitor.getPlatform() !== 'web') return;            // native app: hide entirely
    if (!('serial' in navigator)) { note = 'To flash a board over USB, open ChromaBay in desktop Chrome or Edge.'; return; }
    try { await import('esp-web-tools'); ready = true; }       // registers <esp-web-install-button>
    catch { note = 'Could not load the USB flasher.'; }
  });
</script>

{#if ready}
  <div class="usb-flash">
    <!-- esp-web-tools custom element; slots style the trigger + messages -->
    <esp-web-install-button {manifest}>
      <button slot="activate" class="btn">⚡ Flash ChromaBay over USB</button>
      <span slot="unsupported" class="usb-note">This browser can't flash over USB (needs Web Serial).</span>
      <span slot="not-allowed" class="usb-note">Allow the serial device when prompted, then retry.</span>
    </esp-web-install-button>
    <p class="usb-hint">Connect a blank/any ESP32 by USB to install ChromaBay firmware.</p>
  </div>
{:else if note}
  <p class="usb-note">{note}</p>
{/if}

<style>
  .usb-flash { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; }
  .usb-flash .btn { padding: 0.75rem 1.25rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
    cursor: pointer; background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
  .usb-hint { font-size: 0.78rem; opacity: 0.7; margin: 0; text-align: center; }
  .usb-note { font-size: 0.82rem; opacity: 0.75; text-align: center; }
</style>
