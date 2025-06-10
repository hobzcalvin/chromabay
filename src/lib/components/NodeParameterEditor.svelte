<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getNodeDefinition, setNodeParameter, getNodeParameter, deleteNode, nodeParameters, type Parameter } from '../flowStore';
  import type { Node } from '@xyflow/svelte';

  export let node: Node;
  export let onClose: () => void;
  export let nodeElement: HTMLElement;
  export let viewport: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 };
  export let visible: boolean = true;
  export let top: number | undefined = undefined;
  export let left: number | undefined = undefined;
  export let right: number | undefined = undefined;
  export let bottom: number | undefined = undefined;
  export let deleteConfirmState: boolean = false;
  export let deleteTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  let popoverElement: HTMLElement;
  $: nodeDefinition = getNodeDefinition(node.data.type as string);

  // Calculate popover position
  function getPopoverPosition() {
    // Use provided position props, fallback to fixed position on the left side of screen
    return { 
      top: top ?? 80, 
      left: left ?? 20,
      right: right,
      bottom: bottom
    };
  }

  function getParameterValue(param: Parameter): any {
    const nodeParams = $nodeParameters.get(node.id);
    if (nodeParams && nodeParams.has(param.name)) {
      return nodeParams.get(param.name);
    }
    return param.default;
  }

  function updateParameter(param: Parameter, value: any) {
    setNodeParameter(node.id, param.name, value);
  }

  function handleColorChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    updateParameter(param, input.value);
  }

  function handleRangeChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    const value = param.type === 'integer' ? parseInt(input.value) : parseFloat(input.value);
    updateParameter(param, value);
  }

  function handleFloatChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    const value = Math.max(0, Math.min(1, parseFloat(input.value) || 0));
    updateParameter(param, value);
  }

  function handleSelectChange(param: Parameter, event: Event) {
    const select = event.target as HTMLSelectElement;
    updateParameter(param, select.value);
  }

  function handleDeleteNode() {
    // Don't allow deletion of output node
    if (node.data.type === 'output') {
      return;
    }
    
    if (!deleteConfirmState) {
      // First click - show "Really?" state
      deleteConfirmState = true;
      
      // Reset after 3 seconds if not clicked again
      clearTimeout(deleteTimeout);
      deleteTimeout = setTimeout(() => {
        deleteConfirmState = false;
      }, 3000);
    } else {
      // Second click - actually delete
      clearTimeout(deleteTimeout);
      deleteConfirmState = false;
      
      // Delete the node (this will handle rewiring automatically)
      deleteNode(node.id);
      
      // Close the parameter editor
      onClose();
    }
  }

  function handleClose() {
    // Cleanup is now handled by the parent component
    onClose();
  }

  function handleDocumentClick(event: MouseEvent) {
    if (popoverElement && event.target && !popoverElement.contains(event.target as Element)) {
      handleClose();
    }
  }

  onMount(() => {
    // Add backdrop click handler
    document.addEventListener('click', handleDocumentClick);
    
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });

  onDestroy(() => {
    clearTimeout(deleteTimeout);
  });
</script>

<div 
  bind:this={popoverElement}
  class="parameter-popover"
  style="position: fixed; {getPopoverPosition().top !== undefined ? `top: ${getPopoverPosition().top}px;` : ''} {getPopoverPosition().left !== undefined ? `left: ${getPopoverPosition().left}px;` : ''} {getPopoverPosition().right !== undefined ? `right: ${getPopoverPosition().right}px;` : ''} {getPopoverPosition().bottom !== undefined ? `bottom: ${getPopoverPosition().bottom}px;` : ''} visibility: {visible ? 'visible' : 'hidden'}; opacity: {visible ? '1' : '0'}; transition: opacity 0.2s ease;"
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
  role="dialog"
  tabindex="-1"
>
  <div class="popover-header">
    <h3>{node.data.label} Parameters</h3>
    <div class="header-buttons">
      {#if node.data.type !== 'output'}
        <button 
          class="delete-btn" 
          class:delete-confirm={deleteConfirmState}
          onclick={handleDeleteNode}
        >
          {deleteConfirmState ? 'Really?' : 'Delete'}
        </button>
      {/if}
      <button class="close-btn" onclick={handleClose}>×</button>
    </div>
  </div>
  
  <div class="popover-content">
    {#if nodeDefinition && nodeDefinition.params.length > 0}
      {#each nodeDefinition.params as param}
        <div class="parameter-group">
          <label class="parameter-label">{param.label}</label>
          
          {#if param.type === 'float'}
            <div class="float-control">
              <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.01"
                value={getParameterValue(param)}
                oninput={(e) => handleFloatChange(param, e)}
                onchange={(e) => handleFloatChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param).toFixed(2)}</span>
            </div>
          {:else if param.type === 'range'}
            <div class="range-control">
              <input 
                type="range" 
                min={param.min || 0} 
                max={param.max || 100} 
                step="1"
                value={getParameterValue(param)}
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'integer'}
            <div class="integer-control">
              <input 
                type="range" 
                min={param.min || 0} 
                max={param.max || 100} 
                step="1"
                value={getParameterValue(param)}
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'color'}
            <div class="color-control">
              <input 
                type="color" 
                value={getParameterValue(param)}
                oninput={(e) => handleColorChange(param, e)}
              />
              <span class="color-value">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'hue'}
            <div class="hue-control">
              <input 
                type="range" 
                min="0" 
                max="360" 
                step="1"
                value={getParameterValue(param)}
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
                style="background: linear-gradient(to right, 
                  hsl(0, 100%, 50%), hsl(60, 100%, 50%), hsl(120, 100%, 50%), 
                  hsl(180, 100%, 50%), hsl(240, 100%, 50%), hsl(300, 100%, 50%), 
                  hsl(360, 100%, 50%));"
              />
              <span class="value-display">{getParameterValue(param)}°</span>
            </div>
          {:else if param.type === 'select'}
            <div class="select-control">
              <select 
                value={getParameterValue(param)}
                onchange={(e) => handleSelectChange(param, e)}
              >
                {#if param.options}
                  {#each param.options as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                {/if}
              </select>
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <p class="no-parameters">This node has no parameters to configure.</p>
    {/if}
  </div>
</div>

<style>
  .parameter-popover {
    background: #1f2937;
    border: 1px solid #374151;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    width: 300px;
    max-height: 400px;
    overflow-y: auto;
    z-index: 1000;
    color: white;
  }

  .popover-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #374151;
    background: #111827;
    border-radius: 8px 8px 0 0;
  }

  .popover-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .header-buttons {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 16px;
    cursor: pointer;
    padding: 2px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: #374151;
    color: white;
  }

  .delete-btn {
    background: #ef4444;
    border: none;
    color: white;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    min-width: 50px;
    transition: background-color 0.2s ease;
  }

  .delete-btn:hover {
    background: #dc2626;
  }

  .delete-btn.delete-confirm {
    background: #f59e0b;
    animation: pulse 0.5s ease-in-out;
  }

  .delete-btn.delete-confirm:hover {
    background: #d97706;
  }

  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
  }

  .popover-content {
    padding: 16px;
  }

  .parameter-group {
    margin-bottom: 16px;
  }

  .parameter-group:last-child {
    margin-bottom: 0;
  }

  .parameter-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #d1d5db;
    margin-bottom: 8px;
  }

  .float-control, .range-control, .integer-control, .hue-control {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .float-control input[type="range"],
  .range-control input[type="range"],
  .integer-control input[type="range"],
  .hue-control input[type="range"] {
    flex: 1;
    height: 4px;
    background: #374151;
    border-radius: 2px;
    outline: none;
    -webkit-appearance: none;
  }

  .float-control input[type="range"]::-webkit-slider-thumb,
  .range-control input[type="range"]::-webkit-slider-thumb,
  .integer-control input[type="range"]::-webkit-slider-thumb,
  .hue-control input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    background: #3b82f6;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  /* Firefox slider thumb */
  .float-control input[type="range"]::-moz-range-thumb,
  .range-control input[type="range"]::-moz-range-thumb,
  .integer-control input[type="range"]::-moz-range-thumb,
  .hue-control input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    background: #3b82f6;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  /* Increase touch target area on mobile */
  @media (max-width: 768px) {
    .float-control input[type="range"]::-webkit-slider-thumb,
    .range-control input[type="range"]::-webkit-slider-thumb,
    .integer-control input[type="range"]::-webkit-slider-thumb,
    .hue-control input[type="range"]::-webkit-slider-thumb {
      width: 28px;
      height: 28px;
    }

    .float-control input[type="range"]::-moz-range-thumb,
    .range-control input[type="range"]::-moz-range-thumb,
    .integer-control input[type="range"]::-moz-range-thumb,
    .hue-control input[type="range"]::-moz-range-thumb {
      width: 28px;
      height: 28px;
    }

    /* Increase the height of the slider track for better touch interaction */
    .float-control input[type="range"],
    .range-control input[type="range"],
    .integer-control input[type="range"],
    .hue-control input[type="range"] {
      height: 8px;
      padding: 12px 0; /* Add padding around the slider for larger touch area */
    }
  }

  .value-display {
    font-size: 11px;
    color: #9ca3af;
    min-width: 40px;
    text-align: right;
  }

  .color-control {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .color-control input[type="color"] {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: none;
  }

  .color-value {
    font-size: 11px;
    color: #9ca3af;
    font-family: monospace;
  }

  .select-control {
    display: flex;
    align-items: center;
  }

  .select-control select {
    flex: 1;
    background: #374151;
    border: 1px solid #4b5563;
    border-radius: 4px;
    color: white;
    font-size: 12px;
    padding: 6px 8px;
    cursor: pointer;
    outline: none;
  }

  .select-control select:hover {
    border-color: #6b7280;
  }

  .select-control select:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 1px #3b82f6;
  }

  .select-control select option {
    background: #374151;
    color: white;
  }

  .no-parameters {
    color: #6b7280;
    font-style: italic;
    text-align: center;
    margin: 0;
  }
</style> 