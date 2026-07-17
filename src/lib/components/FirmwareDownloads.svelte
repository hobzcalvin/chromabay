<script lang="ts">
  // Lists a download link per ESP32 chip variant, with "which one do I need" guidance.
  // Shared by the USB flasher (kind="factory", the full merged image) and the WLED-convert
  // manual path (kind="app", the app image WLED's OTA / ChromaBay's manual upload expects).
  // The version comes from the same esp-web-tools manifest the USB flasher reads, so there's
  // one source of truth and nothing committed in the repo.
  import { onMount } from 'svelte';
  import { CHIP_VARIANTS, firmwareUrls } from '$lib/firmwareVariants';

  let { kind = 'factory' }: { kind?: 'factory' | 'app' } = $props();

  const MANIFEST_URL = 'https://chromabay.app/firmware/esp32/chromabay-manifest.json';
  let phase = $state<'loading' | 'ready' | 'error'>('loading');
  let version = $state<string | null>(null);

  onMount(async () => {
    try {
      const r = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const m = await r.json();
      version = m?.version ?? null;
      phase = version ? 'ready' : 'error';
    } catch {
      phase = 'error';
    }
  });
</script>

{#if phase === 'loading'}
  <p class="fd-note">Loading firmware list…</p>
{:else if phase === 'error'}
  <p class="fd-note">Downloads become available after the next firmware release.</p>
{:else}
  <p class="fd-lead">Not sure which chip you have? Check the label on the board's main module.
    Flashing the wrong one won't run — match it exactly.</p>
  <ul class="fd-list">
    {#each CHIP_VARIANTS as v}
      {@const urls = firmwareUrls(version ?? '', v.chip)}
      <li>
        <div class="fd-head">
          <span class="fd-name">{v.label}{v.recommended ? ' — most common' : ''}</span>
          <a class="fd-dl" href={kind === 'factory' ? urls.factory : urls.app} download>
            Download {kind === 'factory' ? 'installer .bin' : 'firmware .bin'}
          </a>
        </div>
        <p class="fd-which">{v.which}</p>
        <p class="fd-eg">e.g. {v.examples}</p>
        {#if kind === 'app'}
          <a class="fd-sig" href={urls.sig} download>signature (.sig)</a>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="fd-fine">Version {version}. The “installer .bin” is a full image for USB tools
    (esp-web-tools / esptool at offset 0); the “firmware .bin” is the app image for OTA and
    WLED's manual update.</p>
{/if}

<style>
  .fd-note { font-size: 0.85rem; opacity: 0.75; margin: 0.4rem 0; }
  .fd-lead { font-size: 0.84rem; opacity: 0.85; margin: 0.2rem 0 0.7rem; }
  .fd-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.7rem; }
  .fd-list li { padding: 0.6rem 0.75rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
  .fd-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .fd-name { font-weight: 600; font-size: 0.9rem; }
  .fd-dl { color: #93c5fd; font-weight: 600; font-size: 0.85rem; white-space: nowrap; }
  .fd-which { font-size: 0.8rem; opacity: 0.8; margin: 0.35rem 0 0.15rem; line-height: 1.4; }
  .fd-eg { font-size: 0.75rem; opacity: 0.55; margin: 0; line-height: 1.4; }
  .fd-sig { display: inline-block; margin-top: 0.35rem; font-size: 0.75rem; color: #93c5fd; opacity: 0.85; }
  .fd-fine { font-size: 0.72rem; opacity: 0.55; margin: 0.8rem 0 0; line-height: 1.4; }
</style>
