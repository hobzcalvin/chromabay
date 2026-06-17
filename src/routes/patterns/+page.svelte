<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { patterns, loadPatterns, switchToPattern, currentPatternName, createEmptyPattern, saveAsPattern } from '$lib/stores/patternsStore';
  import PatternPreview from '$lib/components/PatternPreview.svelte';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { syncPatternToAllDevices, sendPlaylistToDevice, sendSinglePatternToDevice } from '$lib/ble';
  import { currentPattern } from '$lib/stores/patternsStore';
  import { connectedDevices, getConnectedDevicesList } from '$lib/stores/deviceStore';
  import { get } from 'svelte/store';
  
  let patternsList: SerializedPattern[] = [];
  let currentName = '';
  
  // Subscribe to patterns and current pattern name
  patterns.subscribe(pats => {
    patternsList = pats;
  });
  currentPatternName.subscribe(name => {
    currentName = name;
  });

  // --- Per-device pattern cycling. UI state is ephemeral; the DEVICE persists the
  // playlist and cycles off its synced clock, so all connected devices switch
  // together (and keep cycling even if the app disconnects).
  let cycle: Record<string, { enabled: boolean; interval: number }> = {};
  $: connectedList = getConnectedDevicesList($connectedDevices);

  function getCycle(id: string) {
    if (!cycle[id]) cycle[id] = { enabled: false, interval: 10 };
    return cycle[id];
  }

  async function applyCycle(deviceId: string) {
    const c = getCycle(deviceId);
    try {
      if (c.enabled) {
        const pats = get(patterns);
        if (pats.length > 0) await sendPlaylistToDevice(deviceId, pats, c.interval);
      } else {
        const cur = get(currentPattern) || get(patterns)[0];
        if (cur) await sendSinglePatternToDevice(deviceId, cur); // stops cycling on the device
      }
    } catch (e) {
      console.error('Cycle update failed for', deviceId, e);
    }
  }

  function toggleCycle(deviceId: string) {
    const c = getCycle(deviceId);
    c.enabled = !c.enabled;
    cycle = { ...cycle };
    applyCycle(deviceId);
  }

  function onIntervalChange(deviceId: string, value: number) {
    const c = getCycle(deviceId);
    c.interval = Math.max(1, Math.floor(value) || 1);
    cycle = { ...cycle };
    if (c.enabled) applyCycle(deviceId);
  }

  // Swipe state
  let swipeStates: { [key: string]: { isSwipeRevealed: boolean, startX: number, currentX: number } } = {};
  
  onMount(async () => {
    await loadPatterns();
  });
  
  async function handlePatternItemClick(pattern: SerializedPattern, event: Event) {
    const patternName = pattern.meta?.name;
    if (!patternName) return;
    
    // If delete area is revealed, close it instead of navigating
    if (swipeStates[patternName]?.isSwipeRevealed) {
      swipeStates[patternName].isSwipeRevealed = false;
      swipeStates = { ...swipeStates }; // Trigger reactivity
      return;
    }
    
    // Normal tap behavior: Set as current pattern and go to Interact
    console.log('Setting pattern as current:', patternName);
    await switchToPattern(patternName);
    // Load pattern into flow editor for interact page
    const { loadSerializedPattern } = await import('$lib/flowStore');
    await loadSerializedPattern(pattern);
    
    // Sync pattern to all connected devices
    try {
      await syncPatternToAllDevices();
    } catch (error) {
      console.error('Failed to sync pattern to devices:', error);
    }
    
    goto(`${base}/interact`);
  }
  
  async function handleEditTap(pattern: SerializedPattern, event: Event) {
    event.stopPropagation();
    // Set as current pattern and load into editor
    if (pattern.meta?.name) {
      console.log('Setting pattern as current for editing:', pattern.meta?.name);
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
    const { deletePatternByName } = await import('$lib/stores/patternsStore');
    await deletePatternByName(pattern.meta.name);
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
      // Create and save empty pattern
      const emptyPattern = createEmptyPattern(name.trim());
      await saveAsPattern(emptyPattern, name.trim());
      
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
    <h1>🎨 Patterns</h1>
    <p class="subtitle">Tap to interact • Pencil to edit • Trash to delete</p>
  </div>

  {#if connectedList.length > 0}
    <div class="cycle-section" style="background:#1a1a2e;border-radius:12px;padding:12px 16px;margin:0 0 16px;">
      <h2 style="margin:0 0 4px;font-size:1rem;">🔁 Auto-cycle on devices</h2>
      <p class="subtitle" style="margin:0 0 10px;">Each device rotates through all patterns on its synced clock — connected devices switch together.</p>
      {#each connectedList as device (device.deviceId)}
        {@const c = getCycle(device.deviceId)}
        <div class="cycle-row" style="display:flex;align-items:center;gap:12px;padding:6px 0;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{device.name || 'Device'}</span>
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" checked={c.enabled} onchange={() => toggleCycle(device.deviceId)} />
            Cycle
          </label>
          <label style="display:flex;align-items:center;gap:6px;opacity:{c.enabled ? 1 : 0.5};">
            every
            <input type="number" min="1" max="3600" value={c.interval} style="width:56px;"
              disabled={!c.enabled}
              onchange={(e) => onIntervalChange(device.deviceId, +e.currentTarget.value)} />
            s
          </label>
        </div>
      {/each}
    </div>
  {/if}

  {#if patternsList.length === 0}
    <div class="empty-state">
      <div class="empty-icon">🎭</div>
      <h2>No patterns yet</h2>
      <p>Create your first pattern in the Editor</p>
      <a href="{base}/editor" class="create-button">Create Pattern</a>
    </div>
  {:else}
    <div class="patterns-grid">
      {#each patternsList as pattern (pattern.meta?.name)}
        {@const patternName = pattern.meta?.name || 'Unnamed'}
        {@const isCurrentPattern = patternName === currentName}
        {@const swipeState = swipeStates[patternName]}
        
        <div 
          class="pattern-item" 
          class:current={isCurrentPattern}
          class:swiped={swipeState?.isSwipeRevealed}
          onclick={(e) => handlePatternItemClick(pattern, e)}
          ontouchstart={(e) => handleTouchStart(e, patternName)}
          ontouchmove={(e) => handleTouchMove(e, patternName)}
          ontouchend={(e) => handleTouchEnd(e, patternName)}
        >
          <div class="pattern-content">
            <div class="preview-container">
              <PatternPreview {pattern} size={80} />
              {#if isCurrentPattern}
                <div class="current-badge">Current</div>
              {/if}
            </div>
            
            <div class="pattern-details">
              <h3 class="pattern-name">{patternName}</h3>
            </div>
            
            <div class="action-buttons">
              <button 
                class="edit-button"
                onclick={(e) => handleEditTap(pattern, e)}
                aria-label="Edit {patternName}"
                title="Edit pattern"
              >
                ✏️
              </button>
              
              <button 
                class="delete-button-visible"
                onclick={(e) => handleDeleteTap(pattern, e)}
                aria-label="Delete {patternName}"
                title="Delete pattern"
              >
                🗑️
              </button>
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
      
      <!-- New Pattern Button -->
      <button class="new-pattern-button" onclick={handleNewPattern}>
        ➕ New Pattern
      </button>
    </div>
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
  
  .empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: rgba(255, 255, 255, 0.9);
  }
  
  .empty-icon {
    font-size: 4rem;
    margin-bottom: 1rem;
  }
  
  .empty-state h2 {
    margin: 0 0 1rem 0;
    color: white;
  }
  
  .empty-state p {
    margin: 0 0 2rem 0;
    color: rgba(255, 255, 255, 0.8);
  }
  
  .create-button {
    display: inline-block;
    padding: 0.75rem 1.5rem;
    background: #3b82f6;
    color: white;
    text-decoration: none;
    border-radius: 0.5rem;
    font-weight: 600;
    transition: background 0.2s ease;
  }
  
  .create-button:hover {
    background: #2563eb;
  }
  
  .patterns-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  
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
  
  .action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  
  .edit-button, .delete-button-visible {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 0.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1.1rem;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(8px);
  }
  
  .edit-button:hover, .delete-button-visible:hover {
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
    
    .preview-container {
      width: 60px;
      height: 60px;
    }
  }
</style>
