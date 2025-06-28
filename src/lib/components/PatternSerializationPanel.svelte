<script lang="ts">
  import { 
    serializeCurrentPattern, 
    loadSerializedPattern, 
    getPatternSizeEstimate, 
    getPatternForBLE 
  } from '$lib/flowStore';
  import type { SerializedPattern } from '$lib/patternSerializer';

  // Reactive state
  let serializedPattern: SerializedPattern | null = $state(null);
  let serializedString: string = $state('');
  let formattedJson: string = $state('');
  let patternSizeBytes: number = $state(0);
  let loadInput: string = $state('');
  let errorMessage: string = $state('');
  let successMessage: string = $state('');
  let showRawJson: boolean = $state(false);
  let copied: boolean = $state(false);
  // Collapsing & meta
  let collapsed: boolean = $state(true);   // start collapsed
  let patternName: string = $state('');    // user-provided pattern name
  
  // Update pattern size on component mount and when pattern changes
  $effect(() => {
    updatePatternSize();
  });
  
  // Format JSON for display
  function formatJson(obj: any): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (error) {
      return 'Error formatting JSON';
    }
  }
  
  // Update pattern size estimate
  function updatePatternSize(): void {
    try {
      patternSizeBytes = getPatternSizeEstimate();
    } catch (error) {
      console.error('Error estimating pattern size:', error);
      patternSizeBytes = 0;
    }
  }
  
  // Serialize current pattern
  function serializePattern(): void {
    try {
      errorMessage = '';
      serializedPattern = serializeCurrentPattern(patternName.trim() || undefined);
      formattedJson = formatJson(serializedPattern);
      serializedString = getPatternForBLE();
      updatePatternSize();
      successMessage = 'Pattern serialized successfully';
      setTimeout(() => successMessage = '', 3000);
    } catch (error) {
      console.error('Error serializing pattern:', error);
      errorMessage = `Failed to serialize pattern: ${error instanceof Error ? error.message : 'Unknown error'}`;
      successMessage = '';
    }
  }
  
  // Load pattern from input
  async function loadPattern(): Promise<void> {
    try {
      errorMessage = '';
      
      if (!loadInput.trim()) {
        errorMessage = 'Please enter a serialized pattern to load';
        return;
      }
      
      const parsed = JSON.parse(loadInput);
      await loadSerializedPattern(parsed);
      successMessage = 'Pattern loaded successfully';
      setTimeout(() => successMessage = '', 3000);
      loadInput = '';
    } catch (error) {
      console.error('Error loading pattern:', error);
      errorMessage = `Failed to load pattern: ${error instanceof Error ? error.message : 'Invalid JSON format'}`;
      successMessage = '';
    }
  }
  
  // Copy serialized pattern to clipboard
  async function copyToClipboard(): Promise<void> {
    try {
      if (!serializedString) {
        serializePattern();
      }
      
      await navigator.clipboard.writeText(serializedString);
      copied = true;
      setTimeout(() => copied = false, 2000);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      errorMessage = 'Failed to copy to clipboard';
      setTimeout(() => errorMessage = '', 3000);
    }
  }

  // Test serialization round-trip (serialize then immediately deserialize)
  async function testSerializationRoundtrip(): Promise<void> {
    try {
      errorMessage = '';
      
      // Serialize current pattern
      const serialized = serializeCurrentPattern(patternName.trim() || undefined);
      
      // Immediately deserialize it
      await loadSerializedPattern(serialized);
      
      // Update the UI to show the serialized data
      serializedPattern = serialized;
      formattedJson = formatJson(serialized);
      serializedString = getPatternForBLE();
      updatePatternSize();
      
      successMessage = 'Round-trip test completed successfully';
      setTimeout(() => successMessage = '', 3000);
    } catch (error) {
      console.error('Error in serialization round-trip test:', error);
      errorMessage = `Round-trip test failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      successMessage = '';
    }
  }
</script>

<div class="serialization-panel" class:collapsed>
  <div class="header-row">
    <h2>Pattern Serialization</h2>
      <button class="test-button" onclick={testSerializationRoundtrip}>
        Test Round-trip
      </button>
    <button class="collapse-btn" onclick={() => (collapsed = !collapsed)}>
      {collapsed ? '▸' : '▾'}
    </button>
  </div>

  {#if !collapsed}
    <!-- Pattern name -->
    <div class="name-row">
      <label for="pattern-name">Name:</label>
      <input
        id="pattern-name"
        type="text"
        placeholder="Pattern name..."
        bind:value={patternName}
      />
    </div>
  
  <div class="info-bar">
    <div class="size-info">
      <span class="label">Size:</span>
      <span class="value">{patternSizeBytes} bytes</span>
      {#if patternSizeBytes > 512}
        <span class="warning">⚠️ Large pattern (BLE MTU is typically 512 bytes)</span>
      {/if}
    </div>
    
    <div class="actions">
      <button class="primary-button" onclick={serializePattern}>
        Serialize Pattern
      </button>
      <button class="secondary-button" onclick={copyToClipboard} disabled={!serializedString}>
        {copied ? '✓ Copied!' : 'Copy for BLE'}
      </button>
    </div>
  </div>
  
  {#if errorMessage}
    <div class="error-message">
      {errorMessage}
    </div>
  {/if}
  
  {#if successMessage}
    <div class="success-message">
      {successMessage}
    </div>
  {/if}
  
  {#if serializedPattern}
    <div class="json-container">
      <div class="json-header">
        <h3>Serialized Pattern</h3>
        <label>
          <input type="checkbox" bind:checked={showRawJson}>
          Show raw JSON
        </label>
      </div>
      
      <pre class="json-display">{showRawJson ? serializedString : formattedJson}</pre>
    </div>
  {/if}
  
  <div class="load-section">
    <h3>Load Pattern</h3>
    <textarea 
      bind:value={loadInput} 
      placeholder="Paste serialized pattern JSON here..."
      rows="5"
    ></textarea>
    <button class="primary-button" onclick={loadPattern}>
      Load Pattern
    </button>
  </div>
  {/if}
</div>

<style>
  .serialization-panel {
    background: #1e1e1e;
    border-radius: 8px;
    padding: 1.5rem;
    color: white;
    font-family: system-ui, -apple-system, sans-serif;
    margin-bottom: 1rem;
  }
  .serialization-panel.collapsed {
    padding-bottom: 0.5rem;
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  
  h2 {
    margin-top: 0;
    margin-bottom: 1rem;
    font-size: 1.5rem;
    color: #e2e8f0;
  }
  
  h3 {
    font-size: 1.1rem;
    margin-bottom: 0.5rem;
    color: #e2e8f0;
  }
  
  .collapse-btn {
    background: transparent;
    color: #e2e8f0;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0 0.25rem;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .name-row input {
    flex: 1;
    min-width: 150px;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    border: 1px solid #4b5563;
    background: #2a2a2a;
    color: #e2e8f0;
  }

  .info-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  
  .size-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  
  .label {
    font-weight: 500;
    color: #a0aec0;
  }
  
  .value {
    font-weight: 600;
    color: #e2e8f0;
  }
  
  .warning {
    color: #ed8936;
    font-size: 0.9rem;
  }
  
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  
  .primary-button, .secondary-button {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.9rem;
    border: none;
  }
  
  .primary-button {
    background: #3b82f6;
    color: white;
  }
  
  .primary-button:hover {
    background: #2563eb;
  }
  
  .primary-button:disabled {
    background: #6b7280;
    cursor: not-allowed;
  }
  
  .secondary-button {
    background: #4b5563;
    color: white;
  }
  
  .secondary-button:hover {
    background: #374151;
  }
  
  .secondary-button:disabled {
    background: #4b5563;
    opacity: 0.6;
    cursor: not-allowed;
  }
  
  .test-button {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.9rem;
    border: none;
    background: #10b981;
    color: white;
  }
  
  .test-button:hover {
    background: #059669;
  }
  
  .json-container {
    margin: 1rem 0;
    border: 1px solid #4b5563;
    border-radius: 6px;
    overflow: hidden;
  }
  
  .json-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    background: #2d3748;
    border-bottom: 1px solid #4b5563;
  }
  
  .json-header h3 {
    margin: 0;
  }
  
  .json-header label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: #a0aec0;
    cursor: pointer;
  }
  
  .json-display {
    margin: 0;
    padding: 1rem;
    background: #2a2a2a;
    overflow-x: auto;
    font-family: monospace;
    font-size: 0.9rem;
    white-space: pre-wrap;
    max-height: 300px;
    overflow-y: auto;
  }
  
  .load-section {
    margin-top: 1.5rem;
  }
  
  textarea {
    width: 100%;
    padding: 0.75rem;
    border-radius: 6px;
    background: #2a2a2a;
    border: 1px solid #4b5563;
    color: white;
    font-family: monospace;
    resize: vertical;
    margin-bottom: 1rem;
    box-sizing: border-box;
  }
  
  textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
  }
  
  .error-message {
    padding: 0.75rem;
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid #ef4444;
    color: #fecaca;
    border-radius: 6px;
    margin-bottom: 1rem;
  }
  
  .success-message {
    padding: 0.75rem;
    background: rgba(16, 185, 129, 0.2);
    border: 1px solid #10b981;
    color: #a7f3d0;
    border-radius: 6px;
    margin-bottom: 1rem;
  }
  
  /* Mobile responsiveness */
  @media (max-width: 640px) {
    .info-bar {
      flex-direction: column;
      align-items: flex-start;
    }
    
    .actions {
      width: 100%;
      justify-content: stretch;
    }
    
    .primary-button, .secondary-button, .test-button {
      flex: 1;
    }
  }
</style>
