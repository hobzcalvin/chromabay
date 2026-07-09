<script lang="ts">
  import { browseGallery, publishPattern, importGalleryPattern, type GalleryPattern } from '$lib/gallery';
  import { currentPattern, loadPatterns } from '$lib/stores/patternsStore';
  import { authUser, isConfigured } from '$lib/stores/authStore';

  export let open = false;
  export let onClose: () => void = () => {};

  let items: GalleryPattern[] = [];
  let search = '';
  let loading = false;
  let notice = '';
  let error = '';

  async function refresh() {
    loading = true; error = '';
    try { items = await browseGallery({ search }); }
    catch (e: any) { error = e?.message ?? String(e); }
    finally { loading = false; }
  }

  // Load whenever the modal opens.
  $: if (open) { void refresh(); }

  async function doPublish() {
    notice = ''; error = '';
    const p = $currentPattern;
    if (!p) { error = 'No current pattern to publish.'; return; }
    const res = await publishPattern(p);
    if (res.ok) { notice = `Published “${p.meta?.name}”.`; void refresh(); }
    else error = res.error ?? 'Publish failed';
  }

  async function doImport(g: GalleryPattern) {
    notice = ''; error = '';
    try {
      const { name, collided } = await importGalleryPattern(g);
      await loadPatterns();
      notice = collided ? `Imported as “${name}” (you already had that name).` : `Imported “${name}”.`;
    } catch (e: any) { error = e?.message ?? String(e); }
  }
</script>

{#if open}
  <div class="overlay" onclick={onClose} role="presentation">
    <div class="sheet" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Online patterns">
      <div class="head">
        <h2>🌐 Online Patterns</h2>
        <button class="x" onclick={onClose} aria-label="Close">×</button>
      </div>

      <div class="row">
        <input class="search" placeholder="Search patterns…" bind:value={search} oninput={refresh} />
        <button class="btn" onclick={doPublish} disabled={!$authUser} title={$authUser ? 'Publish the current pattern' : 'Sign in to publish'}>Publish current</button>
      </div>
      {#if !isConfigured}<p class="muted">Cloud not configured.</p>{/if}
      {#if !$authUser}<p class="muted">Browsing works signed-out; sign in (Account tab) to publish or upvote.</p>{/if}
      {#if error}<p class="error">{error}</p>{/if}
      {#if notice}<p class="notice">{notice}</p>{/if}

      <div class="list">
        {#if loading}
          <p class="muted">Loading…</p>
        {:else if items.length === 0}
          <p class="muted">No patterns yet{search ? ' for that search' : ''}.</p>
        {:else}
          {#each items as g (g.id)}
            <div class="item">
              <div class="meta">
                <span class="name">{g.name}</span>
                <span class="by">by {g.handle} · ▲ {g.upvote_count}</span>
              </div>
              <button class="btn small" onclick={() => doImport(g)}>Import</button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: flex; align-items: flex-end; justify-content: center; }
  .sheet { background: #1f2937; color: #fff; width: 100%; max-width: 560px; max-height: 82vh; border-radius: 16px 16px 0 0; padding: 1rem; display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,0.5); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .head h2 { margin: 0; font-size: 1.2rem; }
  .x { background: none; border: none; color: #9ca3af; font-size: 1.5rem; cursor: pointer; line-height: 1; }
  .row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
  .search { flex: 1; padding: 0.55rem; border-radius: 8px; border: 1px solid #374151; background: #111827; color: #fff; }
  .muted { color: rgba(255,255,255,0.7); font-size: 0.85rem; margin: 0.25rem 0; }
  .error { color: #fca5a5; font-size: 0.85rem; margin: 0.25rem 0; }
  .notice { color: #86efac; font-size: 0.85rem; margin: 0.25rem 0; }
  .list { overflow-y: auto; flex: 1; margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .item { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 0.6rem 0.75rem; }
  .meta { display: flex; flex-direction: column; min-width: 0; }
  .name { font-weight: 600; }
  .by { font-size: 0.78rem; color: rgba(255,255,255,0.6); }
  .btn { background: rgba(102,126,234,0.5); border: 1px solid rgba(102,126,234,0.7); color: #fff; border-radius: 8px; padding: 0.5rem 0.8rem; cursor: pointer; font-weight: 600; }
  .btn.small { padding: 0.4rem 0.7rem; font-size: 0.85rem; }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
