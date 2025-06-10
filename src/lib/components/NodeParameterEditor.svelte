<script lang="ts">
  import { onMount } from 'svelte';
  import { getNodeDefinition, setNodeParameter, getNodeParameter, type Parameter } from '../flowStore';
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

  let popoverElement: HTMLElement;
  let nodeDefinition = getNodeDefinition(node.data.type as string);

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
    return getNodeParameter(node.id, param.name, param.default);
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

  function handleDocumentClick(event: MouseEvent) {
    if (popoverElement && event.target && !popoverElement.contains(event.target as Element)) {
      onClose();
    }
  }

  onMount(() => {
    // Add backdrop click handler
    document.addEventListener('click', handleDocumentClick);
    
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });
</script>

<div 
  bind:this={popoverElement}
  class="parameter-popover"
  style="position: fixed; {getPopoverPosition().top !== undefined ? `top: ${getPopoverPosition().top}px;` : ''} {getPopoverPosition().left !== undefined ? `left: ${getPopoverPosition().left}px;` : ''} {getPopoverPosition().right !== undefined ? `right: ${getPopoverPosition().right}px;` : ''} {getPopoverPosition().bottom !== undefined ? `bottom: ${getPopoverPosition().bottom}px;` : ''} visibility: {visible ? 'visible' : 'hidden'}; opacity: {visible ? '1' : '0'}; transition: opacity 0.2s ease;"
  onclick={(e) => e.stopPropagation()}
  role="dialog"
  tabindex="-1"
>
  <div class="popover-header">
    <h3>{node.data.label} Parameters</h3>
    <button class="close-btn" onclick={onClose}>×</button>
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
                style="background: linear-gradient(to right, 
                  hsl(0, 100%, 50%), hsl(60, 100%, 50%), hsl(120, 100%, 50%), 
                  hsl(180, 100%, 50%), hsl(240, 100%, 50%), hsl(300, 100%, 50%), 
                  hsl(360, 100%, 50%));"
              />
              <span class="value-display">{getParameterValue(param)}°</span>
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

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 18px;
    cursor: pointer;
    padding: 0;
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
    width: 16px;
    height: 16px;
    background: #3b82f6;
    border-radius: 50%;
    cursor: pointer;
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

  .no-parameters {
    color: #6b7280;
    font-style: italic;
    text-align: center;
    margin: 0;
  }
</style> 