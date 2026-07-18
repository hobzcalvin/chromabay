<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { patterns, loadPatterns, switchToPattern, currentPatternName, createEmptyPattern, saveAsPattern, patternNameExists, importLibraryPattern } from '$lib/stores/patternsStore';
  import PatternPreview from '$lib/components/PatternPreview.svelte';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { syncPatternToAllDevices, deletePatternOnAllDevices, sendSinglePatternToDevice, deletePatternOnDevice, clearDeviceLibrary } from '$lib/ble';
  import { deviceLibraries, refreshDeviceLibraries, syncedCountFor } from '$lib/stores/deviceLibraryStore';
  import { currentPattern } from '$lib/stores/patternsStore';
  import { connectedDevices, getConnectedDevicesList } from '$lib/stores/deviceStore';
  import GalleryModal from '$lib/components/GalleryModal.svelte';
  import { cycleEnabled, cycleSeconds, applyCycle, exitCycle } from '$lib/stores/cycleStore';
  import { browseGallery, importGalleryPattern, type GalleryPattern } from '$lib/gallery';
  import { get } from 'svelte/store';

  let galleryOpen = false;
  let patternsList: SerializedPattern[] = [];
  let currentName = '';
  
  // Subscribe to patterns and current pattern name
  patterns.subscribe(pats => {
    patternsList = pats;
  });
  currentPatternName.subscribe(name => {
    currentName = name;
  });

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

  // Push a pattern into every connected device's library (and show it there). This is the
  // "N synced" action — after it, the count reflects all devices.
  async function handleSyncTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    if (!pattern.meta?.name) return;
    for (const device of connectedList) {
      try {
        await sendSinglePatternToDevice(device.deviceId, pattern);
      } catch (e) {
        console.error('Sync to device failed:', device.deviceId, e);
      }
    }
    refreshDeviceLibraries({ force: true }); // we changed the libraries → re-dump
  }

  // Sync every My Pattern into every connected device's library (so they all cycle).
  let syncingAll = false;
  async function handleSyncAll() {
    if (syncingAll) return;
    syncingAll = true;
    try {
      for (const device of connectedList) {
        for (const pattern of patternsList) {
          try { await sendSinglePatternToDevice(device.deviceId, pattern); }
          catch (e) { console.error('Sync-all failed for', device.deviceId, pattern.meta?.name, e); }
        }
      }
      refreshDeviceLibraries({ force: true });
    } finally { syncingAll = false; }
  }

  // Wipe one device's entire stored library (empties its cycle).
  async function handleClearDevice(deviceId: string, name: string) {
    if (!confirm(`Delete all patterns stored on ${name}? This empties its cycle. (Your own library isn't touched.)`)) return;
    try { await clearDeviceLibrary(deviceId); } catch (e) { console.error('Clear device failed:', e); }
    refreshDeviceLibraries({ force: true });
  }

  // Swipe state
  let swipeStates: { [key: string]: { isSwipeRevealed: boolean, startX: number, currentX: number } } = {};

  // --- Sections: My Patterns / New From Devices / Per Device / Online ---
  let onlinePatterns: GalleryPattern[] = [];
  let perDeviceOpen = false;

  // Names already in My Patterns (used to filter the other sections so they only show
  // things you don't already have).
  $: myNames = new Set(patternsList.map((p) => p.meta?.name).filter(Boolean) as string[]);
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

  // Online patterns you don't already have, highest-voted first (browseGallery orders them).
  $: onlineNew = onlinePatterns.filter((g) => !myNames.has(g.name));

  onMount(async () => {
    await loadPatterns();
    refreshDeviceLibraries(); // best-effort, non-blocking
    try { onlinePatterns = await browseGallery({ limit: 30 }); } catch (e) { console.warn('gallery browse failed', e); }
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
  const handleImportGallery = (g: GalleryPattern) => importAndSelect(() => importGalleryPattern(g));

  // Remove a pattern from ONE device's library (not from My Patterns).
  async function handleRemoveFromDevice(deviceId: string, name: string) {
    try {
      await deletePatternOnDevice(deviceId, name);
    } catch (e) {
      console.error('Remove from device failed:', e);
    }
    refreshDeviceLibraries({ force: true }); // we changed this device's library → re-dump
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
    await exitCycle();
    await switchToPattern(patternName);
    const { loadSerializedPattern } = await import('$lib/flowStore');
    await loadSerializedPattern(pattern);
    try {
      await syncPatternToAllDevices();
    } catch (error) {
      console.error('Failed to sync pattern to devices:', error);
    }
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
      await exitCycle();
      await switchToPattern(pattern.meta.name);
      // Load the pattern into the flow editor immediately
      const { loadSerializedPattern } = await import('$lib/flowStore');
      await loadSerializedPattern(pattern);
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
    const name = prompt('Enter a name for the new pattern:');
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
    <button class="online-btn" onclick={() => (galleryOpen = true)} title="Browse & publish online patterns">🌐 Online</button>
    <p class="subtitle">Tap to select • 🖐️ to interact • ✏️ to edit • 🗑️ to delete</p>
  </div>

  <GalleryModal open={galleryOpen} onClose={() => (galleryOpen = false)} />

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
    <div class="patterns-grid" class:dimmed={$cycleEnabled}>
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
                  onclick={(e) => handleSyncTap(pattern, e)}
                  aria-label="Sync {patternName} to all connected devices"
                  title="Sync to all connected devices"
                >
                  {synced === connectedList.length ? '✓ ' : ''}{synced}/{connectedList.length} synced
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
                <PatternPreview pattern={p} size={44} />
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

  <!-- Online: top gallery patterns you don't already have. -->
  {#if onlineNew.length > 0}
    <section class="pattern-section">
      <h2 class="section-title">Online</h2>
      {#each onlineNew as g (g.id)}
        <div class="simple-row">
          <PatternPreview pattern={g.blob} size={44} />
          <span class="simple-name">{g.name}{g.handle ? ` · by ${g.handle}` : ''}</span>
          <span class="upvotes">▲ {g.upvote_count}</span>
          <button class="import-btn" onclick={() => handleImportGallery(g)}>Import</button>
        </div>
      {/each}
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
  .online-btn {
    position: absolute;
    top: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #fff;
    border-radius: 10px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .online-btn:hover { background: rgba(0, 0, 0, 0.5); }

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
