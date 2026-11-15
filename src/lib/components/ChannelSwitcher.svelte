<script lang="ts">
  // Pick which build of the app runs: the main line or one of the live experimental branches
  // (see $lib/channel.ts). Firmware is chosen separately, per install, on the Devices page.
  import { onMount } from 'svelte';
  import { BUILD_CHANNEL, MAIN_CHANNEL, fetchChannels, switchAppChannel, type Channel } from '$lib/channel';

  let channels = $state<Channel[]>([]);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let offline = $state(false);

  onMount(async () => {
    const list = await fetchChannels();
    offline = list === null;
    channels = list ?? [];
    loading = false;
  });

  const all = $derived([MAIN_CHANNEL, ...channels]);
  const fmtDate = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  async function pick(id: string) {
    if (busy || id === BUILD_CHANNEL) return;
    busy = id || 'main'; error = '';
    const err = await switchAppChannel(id);
    if (err) { error = `Couldn’t switch: ${err}`; busy = ''; }
  }
</script>

<div class="channels">
  {#each all as c (c.id)}
    <div class="ch" class:current={c.id === BUILD_CHANNEL}>
      <div class="meta">
        <div class="title">{c.title}{#if c.id}<span class="tag">experimental</span>{/if}</div>
        {#if c.description}<div class="desc">{c.description}</div>{/if}
        {#if c.id}<div class="desc small">{c.branch ?? ''}{c.appVersion ? ` · ${c.appVersion}` : ''}{c.updated ? ` · ${fmtDate(c.updated)}` : ''}</div>{/if}
      </div>
      {#if c.id === BUILD_CHANNEL}
        <span class="here">Running</span>
      {:else}
        <button class="btn" disabled={!!busy} onclick={() => pick(c.id)}>{busy === (c.id || 'main') ? 'Switching…' : 'Switch'}</button>
      {/if}
    </div>
  {/each}
  {#if loading}<p class="muted">Looking for experimental builds…</p>
  {:else if offline}<p class="muted">Couldn’t reach chromabay.app to list experimental builds.</p>
  {:else if !channels.length}<p class="muted">No experimental builds right now.</p>{/if}
  {#if error}<p class="err">{error}</p>{/if}
  <p class="muted">Your patterns and settings stay where they are. An experimental build can save things the main app doesn't understand yet, so keep an eye on patterns you edit there. Device firmware is switched separately, on each device's Firmware Update.</p>
</div>

<style>
  .channels { display: flex; flex-direction: column; gap: 0.5rem; }
  .ch { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.6rem 0.75rem; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
  .ch.current { border-color: #4f8cff; }
  .title { font-weight: 600; font-size: 0.95rem; }
  .tag { margin-left: 0.5rem; font-size: 0.7rem; padding: 1px 6px; border-radius: 6px; background: #f59e0b33; color: #fbbf24; font-weight: 600; }
  .desc { font-size: 0.8rem; opacity: 0.75; margin-top: 2px; }
  .desc.small { font-size: 0.72rem; opacity: 0.6; }
  .here { font-size: 0.8rem; color: #93c5fd; white-space: nowrap; }
  .btn { padding: 0.4rem 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #fff; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .muted { font-size: 0.8rem; opacity: 0.65; margin: 0; }
  .err { font-size: 0.82rem; color: #fca5a5; margin: 0; }
</style>
