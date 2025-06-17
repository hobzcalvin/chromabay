<script lang="ts">
  import { serializeCurrentPattern } from '$lib/flowStore';
  import { 
    currentPatternName,
    saveCurrentPattern,
    saveAsPattern,
    renameCurrentPattern,
    deleteCurrentPattern,
    patternNameExists
  } from '$lib/stores/patternsStore';
  
  // Props for Add Node functionality
  let { showAddNodeDropdown = $bindable(false), addNodeDropdownRef = $bindable(), handleAddNode, NODE_TYPES } = $props();
  
  // Action dropdown state
  let showDropdown = $state(false);
  let dropdownRef: HTMLDivElement;
  
  // Dialog states
  let showSaveAsDialog = $state(false);
  let showRenameDialog = $state(false);
  
  // Dialog inputs
  let saveAsName = $state('');
  let renameName = $state('');
  
  // Reactive current pattern name
  let patternName = $state('');
  currentPatternName.subscribe(name => patternName = name);
  
  // Close dropdown when clicking outside
  function handleOutsideClick(event: MouseEvent) {
    if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
      showDropdown = false;
    }
  }
  
  $effect(() => {
    if (showDropdown) {
      document.addEventListener('click', handleOutsideClick);
    } else {
      document.removeEventListener('click', handleOutsideClick);
    }
    
    return () => {
      document.removeEventListener('click', handleOutsideClick);
    };
  });
  
  // Actions
  async function handleSave() {
    try {
      const serialized = serializeCurrentPattern(patternName);
      await saveCurrentPattern(serialized);
      showDropdown = false;
    } catch (error: any) {
      console.error('Failed to save pattern:', error);
      alert('Failed to save pattern: ' + (error?.message || 'Unknown error'));
    }
  }
  
  function handleSaveAs() {
    saveAsName = patternName;
    showSaveAsDialog = true;
    showDropdown = false;
  }
  
  function handleRename() {
    renameName = patternName;
    showRenameDialog = true;
    showDropdown = false;
  }
  
  function handleDelete() {
    if (window.confirm(`Are you sure you want to delete "${patternName}"?\n\nThis action cannot be undone.`)) {
      confirmDelete();
    }
    showDropdown = false;
  }
  
  // Dialog actions
  async function confirmSaveAs() {
    if (!saveAsName.trim()) return;
    
    // Check if name already exists
    if (patternNameExists(saveAsName.trim())) {
      if (!confirm(`A pattern named "${saveAsName.trim()}" already exists. Do you want to overwrite it?`)) {
        return;
      }
    }
    
    try {
      const serialized = serializeCurrentPattern(saveAsName.trim());
      await saveAsPattern(serialized, saveAsName.trim());
      showSaveAsDialog = false;
      saveAsName = '';
    } catch (error: any) {
      console.error('Failed to save pattern as:', error);
      alert('Failed to save pattern: ' + (error?.message || 'Unknown error'));
    }
  }
  
  async function confirmRename() {
    if (!renameName.trim()) return;
    
    // Check if name already exists
    if (patternNameExists(renameName.trim())) {
      if (!confirm(`A pattern named "${renameName.trim()}" already exists. Do you want to overwrite it?`)) {
        return;
      }
    }
    
    try {
      await renameCurrentPattern(renameName.trim());
      showRenameDialog = false;
      renameName = '';
    } catch (error: any) {
      console.error('Failed to rename pattern:', error);
      alert('Failed to rename pattern: ' + (error?.message || 'Unknown error'));
    }
  }
  
  async function confirmDelete() {
    try {
      await deleteCurrentPattern();
    } catch (error: any) {
      console.error('Failed to delete pattern:', error);
      alert('Failed to delete pattern: ' + (error?.message || 'Unknown error'));
    }
  }
  
  function cancelDialog() {
    showSaveAsDialog = false;
    showRenameDialog = false;
    saveAsName = '';
    renameName = '';
  }
</script>

<div class="pattern-actions">
  <div class="pattern-name">
    Pattern: <strong>{patternName}</strong>
  </div>
  
  <div class="buttons-container">
    <div class="actions-dropdown" bind:this={dropdownRef}>
      <button
        class="actions-button"
        onclick={() => showDropdown = !showDropdown}
        aria-expanded={showDropdown}
      >
        Actions
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M6 9L1 4h10z"/>
        </svg>
      </button>
      
      {#if showDropdown}
        <div class="dropdown-menu">
          <button onclick={handleSave}>💾 Save</button>
          <button onclick={handleSaveAs}>📋 Save As...</button>
          <button onclick={handleRename}>✏️ Rename...</button>
          <hr />
          <button onclick={handleDelete} class="delete-action">🗑️ Delete</button>
        </div>
      {/if}
    </div>
    
    <div class="add-node-dropdown" bind:this={addNodeDropdownRef}>
      <button
        class="add-node-button"
        onclick={() => showAddNodeDropdown = !showAddNodeDropdown}
        aria-expanded={showAddNodeDropdown}
      >
        ➕ Add Node
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M6 9L1 4h10z"/>
        </svg>
      </button>
      
      {#if showAddNodeDropdown}
        <div class="dropdown-menu">
          {#each NODE_TYPES.slice(1) as nodeType}
            <button onclick={() => handleAddNode(nodeType)}>
              {nodeType.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Save As Dialog -->
{#if showSaveAsDialog}
  <div class="dialog-overlay">
    <div class="dialog">
      <h3>Save Pattern As</h3>
      <input
        type="text"
        bind:value={saveAsName}
        placeholder="Enter pattern name..."
        onkeydown={(e) => e.key === 'Enter' && confirmSaveAs()}
      />
      <div class="dialog-actions">
        <button onclick={cancelDialog}>Cancel</button>
        <button onclick={confirmSaveAs} disabled={!saveAsName.trim()}>Save</button>
      </div>
    </div>
  </div>
{/if}

<!-- Rename Dialog -->
{#if showRenameDialog}
  <div class="dialog-overlay">
    <div class="dialog">
      <h3>Rename Pattern</h3>
      <input
        type="text"
        bind:value={renameName}
        placeholder="Enter new name..."
        onkeydown={(e) => e.key === 'Enter' && confirmRename()}
      />
      <div class="dialog-actions">
        <button onclick={cancelDialog}>Cancel</button>
        <button onclick={confirmRename} disabled={!renameName.trim()}>Rename</button>
      </div>
    </div>
  </div>
{/if}



<style>
  .pattern-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  
  .pattern-name {
    font-size: 1rem;
    color: #666;
  }
  
  .pattern-name strong {
    color: #333;
  }
  
  .buttons-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .actions-dropdown, .add-node-dropdown {
    position: relative;
  }
  
  .actions-button, .add-node-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s ease;
    color: #374151;
  }
  
  .actions-button:hover, .add-node-button:hover {
    background: #e5e5e5;
  }
  
  .actions-button[aria-expanded="true"], .add-node-button[aria-expanded="true"] {
    background: #e5e5e5;
  }
  
  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    background: white;
    border: 1px solid #ddd;
    border-radius: 0.5rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    min-width: 150px;
    z-index: 1000;
  }
  
  .dropdown-menu button {
    display: block;
    width: 100%;
    padding: 0.25rem 1rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background-color 0.2s ease;
  }
  
  .dropdown-menu button:hover {
    background: #f5f5f5;
  }
  
  .dropdown-menu button:first-child {
    border-radius: 0.5rem 0.5rem 0 0;
  }
  
  .dropdown-menu button:last-child {
    border-radius: 0 0 0.5rem 0.5rem;
  }
  
  .dropdown-menu hr {
    margin: 0;
    border: none;
    border-top: 1px solid #eee;
  }
  
  .delete-action {
    color: #dc2626;
  }
  
  .delete-action:hover {
    background: #fef2f2;
  }
  
  /* Dialog styles */
  .dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  
  .dialog {
    background: white;
    padding: 1.5rem;
    border-radius: 0.75rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    max-width: 400px;
    width: 90%;
  }
  
  .dialog h3 {
    margin: 0 0 1rem 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  
  .dialog input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #ddd;
    border-radius: 0.5rem;
    font-size: 1rem;
    margin-bottom: 1rem;
  }
  
  .dialog input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
  }
  
  .dialog-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }
  
  .dialog-actions button {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s ease;
  }
  
  .dialog-actions button:first-child {
    background: white;
  }
  
  .dialog-actions button:first-child:hover {
    background: #f5f5f5;
  }
  
  .dialog-actions button:last-child {
    background: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }
  
  .dialog-actions button:last-child:hover {
    background: #2563eb;
    border-color: #2563eb;
  }
  
  .dialog-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .delete-button {
    background: #dc2626 !important;
    border-color: #dc2626 !important;
    color: white !important;
  }
  
  .delete-button:hover {
    background: #b91c1c !important;
    border-color: #b91c1c !important;
  }
  
  .warning {
    color: #dc2626;
    font-size: 0.875rem;
    margin: 0.5rem 0;
  }
</style> 