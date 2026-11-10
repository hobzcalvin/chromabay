<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { patterns, loadPatterns, switchToPattern, currentPatternName, createEmptyPattern, saveAsPattern, patternNameExists, suggestPatternName, importLibraryPattern, forkToLibrary } from '$lib/stores/patternsStore';
  import PatternPreview from '$lib/components/PatternPreview.svelte';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { deletePatternOnAllDevices, sendSinglePatternToDevice, deletePatternOnDevice, clearDeviceLibrary } from '$lib/ble';
  import { deviceLibraries, refreshDeviceLibraries, syncedCountFor, markSyncedLocally, markUnsyncedLocallyOn, clearDeviceLibraryLocally } from '$lib/stores/deviceLibraryStore';
  import { currentPattern } from '$lib/stores/patternsStore';
  import { connectedDevices, getConnectedDevicesList } from '$lib/stores/deviceStore';
  import { authUser } from '$lib/stores/authStore';
  import { cycleEnabled, cycleSeconds, cycleCrossfadeSeconds, applyCycle, exitCycle } from '$lib/stores/cycleStore';
  import { browseGallery, importGalleryPattern, publishPattern, unpublishPattern, type GalleryPattern, type GallerySort } from '$lib/gallery';
  import { isSupabaseConfigured } from '$lib/supabase';
  import { get } from 'svelte/store';
  // Auto-subscriptions ($store) are released when the page unmounts; the manual
  // .subscribe() calls these replace added two more live subscribers on every visit.
  let patternsList: SerializedPattern[] = [];
  let currentName = '';
  $: patternsList = $patterns;
  $: currentName = $currentPatternName;

  // --- Pattern cycling: ONE control for all connected devices. Each device steps
  // through its OWN stored library off its synced clock, so devices with the same
  // patterns switch together. This just toggles cycling on/off + sets the interval —
  // the device's stored patterns are untouched either way.
  $: connectedList = getConnectedDevicesList($connectedDevices);
  // Cycle state is shared (cycleStore) so entering Edit/Interact auto-exits it — see below.

  // Keep the per-device library snapshot fresh so the N-Synced counts are accurate: refresh
  // whenever the set of connected devices changes (and once on mount).
  let prevConnCount = -1;
  $: if (connectedList.length !== prevConnCount) {
    prevConnCount = connectedList.length;
    refreshDeviceLibraries();
  }

  // Which patterns are mid-sync (by name) — drives the button's spinner/disabled state so a
  // tap feels instant instead of dead while the BLE push runs. Plain let (this file is in
  // legacy/`$:` mode); reassigning the object triggers reactivity.
  let syncing: Record<string, boolean> = {};

  // Store a pattern in every connected device's library for cycling — it isn't shown. This is the
  // "N synced" action. Pushes to all devices in PARALLEL and updates the count OPTIMISTICALLY
  // (for devices that succeeded) instead of re-dumping every device's whole library, which is
  // what made this slow/unresponsive.
  async function handleSyncTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    const name = pattern.meta?.name;
    if (!name || syncing[name]) return;
    syncing = { ...syncing, [name]: true };
    try {
      const ids = connectedList.map((d) => d.deviceId);
      const results = await Promise.allSettled(ids.map((id) => sendSinglePatternToDevice(id, pattern)));
      const okIds = ids.filter((_, i) => results[i].status === 'fulfilled');
      results.forEach((r, i) => { if (r.status === 'rejected') console.error('Sync to device failed:', ids[i], r.reason); });
      markSyncedLocally(okIds, pattern); // count updates instantly; no full re-dump
    } finally {
      const s = { ...syncing }; delete s[name]; syncing = s;
    }
  }

  // Sync every My Pattern into every connected device's library (so they all cycle).
  let syncingAll = false;
  async function handleSyncAll() {
    if (syncingAll) return;
    syncingAll = true;
    try {
      for (const device of connectedList) {
        for (const pattern of patternsList) {
          try {
            await sendSinglePatternToDevice(device.deviceId, pattern);
            markSyncedLocally([device.deviceId], pattern); // optimistic, per push
          } catch (e) { console.error('Sync-all failed for', device.deviceId, pattern.meta?.name, e); }
        }
      }
    } finally { syncingAll = false; }
  }

  // 📤 Publish an OWNED pattern to the public gallery (upsert by author+name). Needs sign-in.
  // Re-publishing confirms (it overwrites your existing online version). No unpublish.
  let publishing: Record<string, boolean> = {};
  async function handlePublish(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    const name = pattern.meta?.name;
    if (!name || publishing[name]) return;
    if (!get(authUser)) { alert('Sign in on the Account tab to share patterns online.'); return; }
    const already = publishedNames.has(name);
    const ok = confirm(already
      ? `Update the shared version of “${name}”?`
      : `Share “${name}” to the public gallery?`);
    if (!ok) return;
    publishing = { ...publishing, [name]: true };
    try {
      const res = await publishPattern(pattern);
      if (res.ok) await loadGallery(); // refresh so it shows ✅ shared
      else alert('Share failed: ' + (res.error ?? 'unknown error'));
    } finally {
      const p = { ...publishing }; delete p[name]; publishing = p;
    }
  }

  // 📋 Copy an IMPORTED/foreign pattern to make it your own (fork: fresh id, no author), so
  // you can then Publish it. Local, no sign-in needed.
  async function handleCopy(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    try {
      const { name } = await forkToLibrary(pattern);
      await loadPatterns();
      const forked = get(patterns).find((p) => p.meta?.name === name);
      if (forked) await selectPattern(forked);
    } catch (e) { console.error('Copy failed:', e); }
  }

  // Wipe one device's entire stored library (empties its cycle).
  async function handleClearDevice(deviceId: string, name: string) {
    if (!confirm(`Delete all patterns stored on ${name}? This empties its cycle. (Your own library isn't touched.)`)) return;
    clearDeviceLibraryLocally(deviceId); // instant feedback
    try { await clearDeviceLibrary(deviceId); }
    catch (e) { console.error('Clear device failed:', e); refreshDeviceLibraries({ force: true }); }
  }

  // Swipe state
  let swipeStates: { [key: string]: { isSwipeRevealed: boolean, startX: number, currentX: number } } = {};

  // --- Sections: My Patterns / New From Devices / Per Device / Online ---
  let onlinePatterns: GalleryPattern[] = [];
  let perDeviceOpen = false;

  // Names already in My Patterns (used to filter the other sections so they only show
  // things you don't already have).
  $: myNames = new Set(patternsList.map((p) => p.meta?.name).filter(Boolean) as string[]);
  // Name → my current (possibly just-edited) version. The Per-Device list should preview the
  // CURRENT pattern, not the stale snapshot dumped from the device — otherwise editing a
  // pattern leaves its per-device preview out of date. (Patterns not in My Patterns fall back
  // to the device's copy.)
  $: myByName = new Map(patternsList.map((p) => [p.meta?.name, p] as const));
  $: connectedIds = connectedList.map((d) => d.deviceId);

  // Patterns present on a CONNECTED device but NOT in My Patterns (deduped by name).
  $: newFromDevices = (() => {
    const seen = new Set<string>(); const out: SerializedPattern[] = [];
    for (const id of connectedIds) {
      for (const p of ($deviceLibraries[id] ?? [])) {
        const n = p.meta?.name;
        if (!n || myNames.has(n) || seen.has(n)) continue;
        seen.add(n); out.push(p);
      }
    }
    return out;
  })();

  // Online gallery. Every published pattern is listed, including your own: hiding your own
  // entries (as this used to) meant the section was empty for anyone who had published, which
  // was most of the gallery, so it looked like it never worked. Each row instead says where
  // you stand with it. Content-addressed (git/lockfile-style): `meta.sourceHash` is the remote
  // hash pinned when you imported it, so you "have" an entry when you hold that EXACT version;
  // an author's re-publish has a new content_hash and offers itself again as an update.
  $: myUid = $authUser?.id ?? null;
  $: adoptedHashes = new Set(patternsList.map((p) => p.meta?.sourceHash).filter(Boolean) as string[]);
  $: adoptedNames = new Set(patternsList.filter((p) => p.meta?.sourceHash).map((p) => `${p.meta?.author ?? ''}\u0000${p.meta?.name}`));
  type GalleryState = 'mine' | 'have' | 'update' | 'new';
  function galleryState(g: GalleryPattern): GalleryState {
    if (myUid && g.author === myUid) return 'mine';
    if (g.content_hash && adoptedHashes.has(g.content_hash)) return 'have';
    if (adoptedNames.has(`${g.author ?? ''}\u0000${g.name}`)) return 'update';
    return 'new';
  }
  // Names I've published (gallery entries under my uid). Reactive so the button's ✅ state
  // updates as soon as onlinePatterns refreshes after a publish.
  $: publishedNames = new Set(
    myUid ? onlinePatterns.filter((g) => g.author === myUid).map((g) => g.name) : [],
  );

  const galleryEnabled = isSupabaseConfigured();
  let gallerySort: GallerySort = 'top';
  let gallerySearch = '';
  let galleryLoading = false;
  let galleryError = '';
  let galleryBusy: Record<string, boolean> = {};
  let gallerySeq = 0;
  async function loadGallery() {
    if (!galleryEnabled) return;
    const seq = ++gallerySeq; // drop responses that a newer search/sort has superseded
    galleryLoading = true;
    galleryError = '';
    try {
      const rows = await browseGallery({ limit: 60, sort: gallerySort, search: gallerySearch });
      if (seq === gallerySeq) onlinePatterns = rows;
    } catch (e: any) {
      if (seq === gallerySeq) galleryError = e?.message || 'Could not reach the gallery';
    } finally {
      if (seq === gallerySeq) galleryLoading = false;
    }
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onGallerySearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadGallery, 300);
  }
  function setGallerySort(s: GallerySort) {
    if (s === gallerySort) return;
    gallerySort = s;
    loadGallery();
  }
  async function handleUnpublish(g: GalleryPattern) {
    if (!confirm(`Remove “${g.name}” from the public gallery? Your local copy stays.`)) return;
    galleryBusy = { ...galleryBusy, [g.id]: true };
    try {
      const res = await unpublishPattern(g.id);
      if (!res.ok) alert(`Couldn't unpublish: ${res.error}`);
      await loadGallery();
    } finally {
      const b = { ...galleryBusy }; delete b[g.id]; galleryBusy = b;
    }
  }

  onMount(async () => {
    await loadPatterns();
    refreshDeviceLibraries(); // best-effort, non-blocking
    loadGallery();
  });

  // Import a pattern (from a device or the gallery) into My Patterns, then select it as
  // current + sync to all devices, so it lands where the user expects.
  async function importAndSelect(getName: () => Promise<{ name: string }>) {
    try {
      const { name } = await getName();
      await loadPatterns();
      const imported = get(patterns).find((p) => p.meta?.name === name);
      if (imported) await selectPattern(imported);
      refreshDeviceLibraries({ force: true }); // import synced it to devices → re-dump
    } catch (e) {
      console.error('Import failed:', e);
    }
  }
  const handleImportDevicePattern = (p: SerializedPattern) => importAndSelect(() => importLibraryPattern(p));
  async function handleImportGallery(g: GalleryPattern) {
    if (galleryBusy[g.id]) return;
    galleryBusy = { ...galleryBusy, [g.id]: true };
    try {
      await importAndSelect(() => importGalleryPattern(g));
      await loadGallery(); // the import upvoted it: refresh the count
    } finally {
      const b = { ...galleryBusy }; delete b[g.id]; galleryBusy = b;
    }
  }

  // Remove a pattern from ONE device's library (not from My Patterns). Optimistic: the row
  // disappears immediately. We do NOT re-dump on success — the BLE dump is lossy (drops
  // patterns), so a re-dump here would wrongly collapse the whole list. Only re-dump to
  // recover if the delete actually failed.
  async function handleRemoveFromDevice(deviceId: string, name: string) {
    markUnsyncedLocallyOn(deviceId, name); // instant feedback
    try {
      await deletePatternOnDevice(deviceId, name);
    } catch (e) {
      console.error('Remove from device failed:', e);
      refreshDeviceLibraries({ force: true }); // reconcile only on failure
    }
  }

  // Bring the current pattern into view when landing on this page (it may be far down a
  // long list). Fires once, when the item mounts as current or first becomes current.
  function scrollToCurrent(node: HTMLElement, isCurrent: boolean) {
    let done = false;
    const maybe = (v: boolean) => {
      if (v && !done) {
        done = true;
        requestAnimationFrame(() => node.scrollIntoView({ block: 'center', behavior: 'auto' }));
      }
    };
    maybe(isCurrent);
    return { update: maybe };
  }
  
  // Make a pattern the current one: load it into the flow store (used by Interact and
  // the Editor) and push it to all connected devices. No navigation.
  async function selectPattern(pattern: SerializedPattern) {
    const patternName = pattern.meta?.name;
    if (!patternName) return;
    console.log('Setting pattern as current:', patternName);
    // Selecting a single pattern is a Live action → leave Cycle so devices show it (WYSIWYG).
    // Queued, latest tap wins (see selectPattern in flowStore); loading pushes to devices.
    const { selectPattern: select } = await import('$lib/flowStore');
    await select(pattern, exitCycle);
  }

  async function handlePatternItemClick(pattern: SerializedPattern, event: Event) {
    const patternName = pattern.meta?.name;
    if (!patternName) return;

    // If delete area is revealed, close it instead of selecting
    if (swipeStates[patternName]?.isSwipeRevealed) {
      swipeStates[patternName].isSwipeRevealed = false;
      swipeStates = { ...swipeStates }; // Trigger reactivity
      return;
    }

    // Tapping a pattern just selects it as current (no navigation).
    await selectPattern(pattern);
  }

  // Hand button: select the pattern AND open the Interact page for it.
  async function handleInteractTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    if (!pattern.meta?.name) return;
    await selectPattern(pattern);
    goto(`${base}/interact`);
  }
  
  async function handleEditTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    // Set as current pattern and load into editor
    if (pattern.meta?.name) {
      console.log('Setting pattern as current for editing:', pattern.meta?.name);
      // Load the pattern into the flow editor (queued with any other selection in flight)
      const { selectPattern: select } = await import('$lib/flowStore');
      await select(pattern, exitCycle);
      goto(`${base}/editor`);
    }
  }
  
  async function handleDeleteTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    
    if (!pattern.meta?.name) return;
    
    // First tap: reveal the swipe delete area (same as left swipe)
    if (!swipeStates[pattern.meta.name]) {
      swipeStates[pattern.meta.name] = { isSwipeRevealed: false, startX: 0, currentX: 0 };
    }
    swipeStates[pattern.meta.name].isSwipeRevealed = true;
    swipeStates = { ...swipeStates }; // Trigger reactivity
  }
  
  async function handleConfirmDelete(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    
    if (!pattern.meta?.name) return;
    
    // Second tap: actually delete (no confirm dialog)
    const name = pattern.meta.name;
    const { deletePatternByName } = await import('$lib/stores/patternsStore');
    await deletePatternByName(name);
    // Propagate the delete to any connected devices so it leaves their cycle too.
    deletePatternOnAllDevices(name).then(() => refreshDeviceLibraries({ force: true })).catch((e) => console.error('Device pattern delete failed:', e));
    // Hide swipe state after deletion
    if (swipeStates[pattern.meta.name]) {
      swipeStates[pattern.meta.name].isSwipeRevealed = false;
    }
  }
  
  // Touch/swipe handling
  function handleTouchStart(event: TouchEvent, patternName: string) {
    if (!swipeStates[patternName]) {
      swipeStates[patternName] = { isSwipeRevealed: false, startX: 0, currentX: 0 };
    }
    
    swipeStates[patternName].startX = event.touches[0].clientX;
    swipeStates[patternName].currentX = event.touches[0].clientX;
  }
  
  function handleTouchMove(event: TouchEvent, patternName: string) {
    if (!swipeStates[patternName]) return;
    
    swipeStates[patternName].currentX = event.touches[0].clientX;
    const deltaX = swipeStates[patternName].startX - swipeStates[patternName].currentX;
    
    // Show delete button if swiped left more than 60px
    if (deltaX > 60) {
      swipeStates[patternName].isSwipeRevealed = true;
    } else if (deltaX < 20) {
      swipeStates[patternName].isSwipeRevealed = false;
    }
    
    // Update swipe states to trigger reactivity
    swipeStates = { ...swipeStates };
  }
  
  function handleTouchEnd(event: TouchEvent, patternName: string) {
    // Touch end logic if needed
  }
  
  // Close any open swipe reveals when clicking elsewhere
  function handleDocumentClick() {
    let hasChanges = false;
    for (const key in swipeStates) {
      if (swipeStates[key].isSwipeRevealed) {
        swipeStates[key].isSwipeRevealed = false;
        hasChanges = true;
      }
    }
    if (hasChanges) {
      swipeStates = { ...swipeStates };
    }
  }
  
  async function handleNewPattern() {
    const name = prompt('Name the new pattern:', suggestPatternName()); // pre-filled and selected
    if (!name?.trim()) return;

    try {
      // Keep names unique: a colliding name would otherwise overwrite the existing
      // pattern (savePattern matches by name), silently destroying it. Auto-suffix
      // instead — the same behaviour as importing a duplicate.
      let finalName = name.trim();
      if (patternNameExists(finalName)) {
        let i = 2;
        while (patternNameExists(`${finalName} ${i}`)) i++;
        finalName = `${finalName} ${i}`;
        alert(`A pattern named “${name.trim()}” already exists — created “${finalName}” instead.`);
      }

      // Create and save empty pattern
      const emptyPattern = createEmptyPattern(finalName);
      await saveAsPattern(emptyPattern, finalName);

      // Load it into the editor and navigate there
      const { loadSerializedPattern } = await import('$lib/flowStore');
      await loadSerializedPattern(emptyPattern);
      
      goto(`${base}/editor`);
    } catch (error) {
      console.error('Failed to create new pattern:', error);
      alert('Failed to create new pattern. Please try again.');
    }
  }
</script>

<main class="patterns-page" onclick={handleDocumentClick}>
  <div class="header">
    <h1>Patterns</h1>
    <p class="subtitle">Tap to select • 🖐️ interact • ✏️ edit • 🔗 share • 🗑️ delete</p>
    <p class="subtitle">Import patterns from the “New From Devices” and “Online” sections below.</p>
  </div>

  <!-- Cycle control: always shown. When ON, each connected device plays its own stored
       library autonomously; the pattern list below dims because selecting/editing a single
       pattern doesn't apply — but tapping one still works and just turns Cycle off. -->
  <div class="cycle-bar" class:on={$cycleEnabled}>
    <label class="cycle-control">
      <input type="checkbox" bind:checked={$cycleEnabled} onchange={applyCycle} />
      <span class="cycle-text">Cycle synced patterns</span>
      <span class="cycle-sub">every</span>
      <input class="cycle-secs" type="number" min="1" step="1" bind:value={$cycleSeconds} disabled={!$cycleEnabled} onchange={applyCycle} />
      <span class="cycle-sub">seconds</span>
    </label>
    <!-- Separate label: inside the one above, clicking "crossfading" would toggle Cycle.
         Capped at half the interval — the device clamps it there anyway, because a fade
         longer than that would still be running when the next one starts. 0 = hard cut. -->
    <label class="cycle-control">
      <span class="cycle-sub">crossfading</span>
      <input class="cycle-secs" type="number" min="0" max={$cycleSeconds / 2} step="0.5" bind:value={$cycleCrossfadeSeconds} disabled={!$cycleEnabled} onchange={applyCycle} />
      <span class="cycle-sub">seconds</span>
    </label>
    {#if $cycleEnabled}
      <span class="cycle-hint">{connectedList.length > 0 ? `${connectedList.length} device${connectedList.length === 1 ? '' : 's'} playing` : 'no devices connected'}</span>
    {/if}
  </div>

  {#if connectedList.length > 0 && patternsList.length > 0}
    <button class="sync-all-btn" onclick={handleSyncAll} disabled={syncingAll}>
      {syncingAll ? 'Syncing…' : `Sync all ${patternsList.length} patterns to ${connectedList.length} device${connectedList.length === 1 ? '' : 's'}`}
    </button>
  {/if}

  <section class="pattern-section">
    <h2 class="section-title">My Patterns</h2>
    {#if patternsList.length === 0}
      <p class="section-empty">No patterns yet — create one below, or import from your devices or online.</p>
    {/if}
    <div class="patterns-grid" class:dimmed={$cycleEnabled} data-tour-target="pattern-list">
      {#each patternsList as pattern (pattern.meta?.id ?? pattern.meta?.name)}
        {@const patternName = pattern.meta?.name || 'Unnamed'}
        {@const isCurrentPattern = patternName === currentName}
        {@const swipeState = swipeStates[patternName]}
        
        <div
          class="pattern-item"
          class:current={isCurrentPattern}
          class:swiped={swipeState?.isSwipeRevealed}
          use:scrollToCurrent={isCurrentPattern}
          onclick={(e) => handlePatternItemClick(pattern, e)}
          ontouchstart={(e) => handleTouchStart(e, patternName)}
          ontouchmove={(e) => handleTouchMove(e, patternName)}
          ontouchend={(e) => handleTouchEnd(e, patternName)}
        >
          <div class="pattern-content">
            <div class="preview-container">
              <PatternPreview {pattern} size={64} />
              {#if isCurrentPattern}
                <div class="current-badge">Current</div>
              {/if}
            </div>
            
            <div class="pattern-details">
              <h3 class="pattern-name">{patternName}</h3>
            </div>
            
            <div class="action-buttons">
              {#if connectedList.length > 0}
                {@const synced = syncedCountFor($deviceLibraries, patternName, connectedIds)}
                <button
                  class="sync-button"
                  class:allsynced={synced === connectedList.length}
                  class:syncing={syncing[patternName]}
                  disabled={syncing[patternName]}
                  onclick={(e) => handleSyncTap(pattern, e)}
                  aria-label="Sync {patternName} to all connected devices"
                  title="Sync to all connected devices"
                >
                  {#if syncing[patternName]}Syncing…{:else}{synced === connectedList.length ? '✓ ' : ''}{synced}/{connectedList.length} synced{/if}
                </button>
              {/if}
              <div class="icon-row">
                <button
                  class="interact-button"
                  onclick={(e) => handleInteractTap(pattern, e)}
                  aria-label="Interact with {patternName}"
                  title="Interact"
                >🖐️</button>
                <button
                  class="edit-button"
                  onclick={(e) => handleEditTap(pattern, e)}
                  aria-label="Edit {patternName}"
                  title="Edit pattern"
                >✏️</button>
                {#if pattern.meta?.author}
                  <!-- Imported/foreign pattern → Copy to make it yours (then it can be published). -->
                  <button
                    class="edit-button"
                    onclick={(e) => handleCopy(pattern, e)}
                    aria-label="Copy {patternName} to make it yours"
                    title="Copy to make it yours"
                  >📋</button>
                {:else}
                  <!-- Owned pattern → Publish (or re-publish) to the online gallery. -->
                  <button
                    class="edit-button"
                    class:published={publishedNames.has(patternName)}
                    disabled={publishing[patternName]}
                    onclick={(e) => handlePublish(pattern, e)}
                    aria-label="Share {patternName} online"
                    title={publishedNames.has(patternName) ? "Shared online — tap to update" : "Share online"}
                  >{publishing[patternName] ? "⏳" : (publishedNames.has(patternName) ? "✅" : "🔗")}</button>
                {/if}
                <button
                  class="delete-button-visible"
                  onclick={(e) => handleDeleteTap(pattern, e)}
                  aria-label="Delete {patternName}"
                  title="Delete pattern"
                >🗑️</button>
              </div>
            </div>
          </div>
          
          <div class="delete-area">
            <button 
              class="delete-button"
              onclick={(e) => handleConfirmDelete(pattern, e)}
              aria-label="Confirm delete {patternName}"
            >
              🗑️ Delete
            </button>
          </div>
        </div>
      {/each}

      <button class="new-pattern-button" onclick={handleNewPattern}>➕ New Pattern</button>
    </div>
  </section>

  <!-- New From Devices: on a connected device but not in My Patterns. Import to adopt. -->
  {#if newFromDevices.length > 0}
    <section class="pattern-section">
      <h2 class="section-title">New From Devices</h2>
      {#each newFromDevices as p (p.meta?.name)}
        <div class="simple-row">
          <PatternPreview pattern={p} size={44} />
          <span class="simple-name">{p.meta?.name || 'Unnamed'}</span>
          <button class="import-btn" onclick={() => handleImportDevicePattern(p)}>Import</button>
        </div>
      {/each}
    </section>
  {/if}

  <!-- Per Device: what's stored on each connected device; remove individually here. -->
  {#if connectedList.length > 0}
    <section class="pattern-section">
      <details bind:open={perDeviceOpen}>
        <summary class="section-title section-summary">Per Device</summary>
        {#each connectedList as device (device.deviceId)}
          <div class="device-group">
            <div class="device-group-head">
              <h3 class="device-group-name">{device.name}</h3>
              {#if ($deviceLibraries[device.deviceId] ?? []).length > 0}
                <button class="del-all-btn" onclick={() => handleClearDevice(device.deviceId, device.name)}>Delete all</button>
              {/if}
            </div>
            {#each ($deviceLibraries[device.deviceId] ?? []) as p (p.meta?.name)}
              {@const nm = p.meta?.name ?? ''}
              <div class="simple-row">
                <PatternPreview pattern={myByName.get(nm) ?? p} size={44} />
                <span class="simple-name">{nm || 'Unnamed'}</span>
                {#if nm && !myNames.has(nm)}
                  <button class="import-btn" onclick={() => handleImportDevicePattern(p)}>Import</button>
                {/if}
                <button class="mini-btn" title="Remove from {device.name}" onclick={() => handleRemoveFromDevice(device.deviceId, nm)}>🗑️</button>
              </div>
            {:else}
              <p class="section-empty">No stored patterns.</p>
            {/each}
          </div>
        {/each}
      </details>
    </section>
  {/if}

  <!-- Online gallery: everything published, with where you stand on each entry. -->
  {#if galleryEnabled}
    <section class="pattern-section" data-tour-target="gallery">
      <div class="gallery-head">
        <h2 class="section-title">Online Gallery</h2>
        <div class="gallery-sort" role="group" aria-label="Sort gallery">
          <button class:active={gallerySort === 'top'} onclick={() => setGallerySort('top')}>Top</button>
          <button class:active={gallerySort === 'new'} onclick={() => setGallerySort('new')}>New</button>
        </div>
      </div>
      <input
        class="gallery-search"
        type="search"
        placeholder="Search the gallery"
        bind:value={gallerySearch}
        oninput={onGallerySearch}
      />
      {#if galleryError}
        <p class="section-empty">Couldn't load the gallery ({galleryError}). <button class="link-btn" onclick={loadGallery}>Retry</button></p>
      {:else if galleryLoading && onlinePatterns.length === 0}
        <p class="section-empty">Loading…</p>
      {:else if onlinePatterns.length === 0}
        <p class="section-empty">{gallerySearch.trim() ? 'No patterns match that search.' : 'Nothing published yet. Share one of yours with 🔗 above.'}</p>
      {/if}
      {#each onlinePatterns as g (g.id)}
        {@const st = galleryState(g)}
        <div class="simple-row" class:dim={galleryLoading}>
          <PatternPreview pattern={g.blob} size={44} />
          <span class="simple-name">{g.name}<span class="by">{st === 'mine' ? ' · yours' : g.handle ? ` · by ${g.handle}` : ''}</span></span>
          <span class="upvotes" title="Upvotes (importing a pattern upvotes it)">▲ {g.upvote_count}</span>
          {#if st === 'mine'}
            <button class="mini-btn" disabled={galleryBusy[g.id]} onclick={() => handleUnpublish(g)} title="Remove from the gallery" aria-label="Unpublish">🗑</button>
          {:else if st === 'have'}
            <span class="have-tag" title="This exact version is in My Patterns">✓ Have it</span>
          {:else}
            <button class="import-btn" disabled={galleryBusy[g.id]} onclick={() => handleImportGallery(g)}>{galleryBusy[g.id] ? '…' : st === 'update' ? 'Update' : 'Import'}</button>
          {/if}
        </div>
      {/each}
      {#if !$authUser}
        <p class="section-empty small">Sign in under Settings to publish your own patterns.</p>
      {/if}
    </section>
  {/if}
</main>

<style>
  .patterns-page {
    padding: 1rem;
    max-width: 600px;
    margin: 0 auto;
    min-height: 100vh;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }
  
  .header {
    margin-bottom: 2rem;
    position: relative;
  }
  .header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    font-weight: 700;
    color: white;
  }
  
  .subtitle {
    margin: 0;
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.9rem;
  }
  
  .patterns-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: opacity 0.2s ease;
  }
  /* While Cycle is on, the list is de-emphasized (selecting a single pattern doesn't apply).
     Still fully interactive — tapping any pattern just exits Cycle and selects it. */
  .patterns-grid.dimmed {
    opacity: 0.45;
  }

  /* Sections: My Patterns / New From Devices / Per Device / Online */
  .pattern-section { margin: 0 0 1.5rem; }
  .section-title {
    margin: 0 0 0.6rem; font-size: 1.1rem; font-weight: 700; color: #fff;
  }
  .section-summary { cursor: pointer; user-select: none; }
  .section-empty { color: rgba(255, 255, 255, 0.7); font-size: 0.9rem; margin: 0 0 0.75rem; }
  .simple-row {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.5rem 0.6rem; margin-bottom: 0.5rem;
    background: rgba(0, 0, 0, 0.25); border-radius: 10px;
  }
  .simple-name {
    flex: 1; min-width: 0; color: #f9fafb; font-size: 0.95rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .upvotes { color: #cbd5e1; font-size: 0.8rem; white-space: nowrap; }
  .simple-name .by { color: rgba(255, 255, 255, 0.65); }
  .simple-row.dim { opacity: 0.6; }
  .have-tag { color: #bbf7d0; font-size: 0.8rem; font-weight: 600; white-space: nowrap; padding: 0 0.3rem; }
  .gallery-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .gallery-sort { display: flex; gap: 0.25rem; }
  .gallery-sort button {
    background: rgba(0, 0, 0, 0.25); color: rgba(255, 255, 255, 0.8); border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px; padding: 0.2rem 0.6rem; font-size: 0.8rem; cursor: pointer;
  }
  .gallery-sort button.active { background: rgba(255, 255, 255, 0.9); color: #312e81; font-weight: 600; }
  .gallery-search {
    width: 100%; box-sizing: border-box; margin: 0.25rem 0 0.75rem; padding: 0.45rem 0.7rem;
    border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(0, 0, 0, 0.25);
    color: #fff; font-size: 0.9rem;
  }
  .gallery-search::placeholder { color: rgba(255, 255, 255, 0.55); }
  .section-empty.small { font-size: 0.8rem; margin-top: 0.5rem; }
  .link-btn { background: none; border: none; color: #fff; text-decoration: underline; cursor: pointer; padding: 0; font: inherit; }
  .import-btn:disabled, .mini-btn:disabled { opacity: 0.5; cursor: default; }
  .import-btn {
    background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: #fff; border: none;
    padding: 0.35rem 0.8rem; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    white-space: nowrap;
  }
  .import-btn:hover { filter: brightness(1.1); }
  .mini-btn {
    background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4);
    color: #fff; border-radius: 8px; padding: 0.3rem 0.5rem; cursor: pointer; font-size: 0.95rem;
  }
  .device-group { margin: 0.5rem 0 1rem; }
  .device-group-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin: 0.5rem 0 0.4rem; }
  .device-group-name {
    margin: 0; font-size: 0.95rem; font-weight: 600; color: rgba(255, 255, 255, 0.85);
  }
  .del-all-btn {
    background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4);
    color: #fecaca; border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 0.78rem; cursor: pointer;
  }
  .sync-all-btn {
    width: 100%; margin: 0 0 16px; padding: 0.6rem 1rem;
    background: rgba(59, 130, 246, 0.25); border: 1px solid rgba(59, 130, 246, 0.5);
    color: #dbeafe; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .sync-all-btn:hover { background: rgba(59, 130, 246, 0.35); }
  .sync-all-btn:disabled { opacity: 0.6; cursor: default; }

  .cycle-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    margin: 0 0 16px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.2);
    color: #fff;
  }
  .cycle-bar.on {
    border-color: rgba(52, 211, 153, 0.6);
    background: rgba(16, 185, 129, 0.14);
  }
  .cycle-control { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .cycle-control input[type="checkbox"] { width: 18px; height: 18px; }
  .cycle-text { font-weight: 600; }
  .cycle-sub { opacity: 0.8; font-size: 0.9rem; }
  .cycle-secs {
    width: 56px; padding: 4px 6px; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.1); color: #fff;
  }
  .cycle-secs:disabled { opacity: 0.5; }
  .cycle-hint { font-size: 0.85rem; opacity: 0.85; color: #6ee7b7; }
  
  .pattern-item {
    position: relative;
    background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: all 0.3s ease;
    cursor: pointer;
  }
  
  .pattern-item:nth-child(2n) {
    background: linear-gradient(135deg, #374151 0%, #1f2937 100%);
  }
  
  .pattern-item:nth-child(3n) {
    background: linear-gradient(135deg, #4b5563 0%, #374151 100%);
  }
  
  .pattern-item:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    transform: translateY(-1px);
  }
  
  .pattern-item.current {
    border: 2px solid #3b82f6;
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%);
  }
  
  .pattern-item.swiped .pattern-content {
    transform: translateX(-80px);
  }
  
  .pattern-item.swiped .delete-area {
    opacity: 1;
    visibility: visible;
  }
  
  .pattern-content {
    display: flex;
    align-items: center;
    padding: 1rem;
    gap: 1rem;
    transition: transform 0.3s ease;
    background: transparent;
    position: relative;
    z-index: 2;
  }
  
  .preview-container {
    position: relative;
    flex-shrink: 0;
    /* Size to the PatternPreview's box (set by its `size` prop) so it can't overflow
       and cover the name — the old mobile rule forced this to 60px while the preview
       was 80px, which is what shoved/covered the text. */
    width: 64px;
    height: 64px;
  }
  
  .current-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    background: #3b82f6;
    color: white;
    font-size: 0.6rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .pattern-details {
    flex: 1;
    min-width: 0;
  }
  
  .pattern-name {
    margin: 0 0 0.25rem 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #f9fafb;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  /* Removed .pattern-info as we no longer show node counts */
  
  /* Two rows: the N-Synced pill on top, the icon actions below. Tighter than before to
     keep the (now busier) row compact. */
  .action-buttons {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
    flex-shrink: 0;
  }
  .icon-row {
    display: flex;
    gap: 0.35rem;
    justify-content: flex-end;
  }

  .sync-button {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: #e5e7eb;
    padding: 0.25rem 0.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.2s ease;
  }
  .sync-button:hover { background: rgba(255, 255, 255, 0.2); }
  .sync-button.allsynced {
    background: rgba(16, 185, 129, 0.2);
    border-color: rgba(52, 211, 153, 0.5);
    color: #6ee7b7;
  }
  .sync-button.syncing { opacity: 0.6; cursor: default; }
  .sync-button:disabled { cursor: default; }

  .interact-button, .edit-button, .delete-button-visible {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 0.35rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(8px);
  }

  .interact-button:hover, .edit-button:hover, .delete-button-visible:hover {
    background: rgba(255, 255, 255, 0.2);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }
  .edit-button.published {
    background: rgba(16, 185, 129, 0.25);
    border-color: rgba(52, 211, 153, 0.5);
  }

  .delete-button-visible {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.4);
  }
  
  .delete-button-visible:hover {
    background: rgba(239, 68, 68, 0.3);
    border-color: rgba(239, 68, 68, 0.6);
  }
  
  .delete-area {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ef4444;
    z-index: 1;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }
  
  .delete-button {
    background: none;
    border: none;
    color: white;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 4px;
    transition: background 0.2s ease;
  }
  
  .delete-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .new-pattern-button {
    margin-top: 1rem;
    padding: 1rem;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
    border: none;
    border-radius: 12px;
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
    width: 100%;
  }
  
  .new-pattern-button:hover {
    background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    transform: translateY(-1px);
  }
  
  /* Mobile-specific styles */
  @media (max-width: 640px) {
    .patterns-page {
      padding: 0.5rem;
    }
    
    .header {
      margin-bottom: 1.5rem;
    }
    
    .pattern-content {
      padding: 0.75rem;
    }
  }
</style>
