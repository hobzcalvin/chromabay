<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getNodeDefinition, setNodeParameter, getNodeParameter, deleteNode, nodeParameters, type Parameter } from '../flowStore';
  import { getParameterInteractive, setParameterInteractive, MAX_INTERACTIVE_PARAMS, interactiveParameters } from '../stores/interactiveStore';
  import { modulators, getModulator, setModulator, clearModulator, SHAPES, type ModulatorConfig } from '../stores/modulatorStore';
  import type { Node } from '@xyflow/svelte';

  export let node: Node;
  export let onClose: () => void;
  // Changed to const as per svelte-check warning if only for external reference / initial value
  export const nodeElement: HTMLElement = undefined as any; // Initialized by parent
  export const viewport: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 }; // Initialized by parent
  export let visible: boolean = true;
  export let top: number | undefined = undefined;
  export let left: number | undefined = undefined;
  export let right: number | undefined = undefined;
  export let bottom: number | undefined = undefined;
  export let deleteConfirmState: boolean = false;
  export let deleteTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  let popoverElement: HTMLElement;
  $: nodeDefinition = getNodeDefinition(node.data.type as string);
  
  // Reactive helper to get interactive state (subscribes to store changes)
  $: getParameterInteractiveReactive = (nodeId: string, paramName: string): boolean => {
    const nodeParams = $interactiveParameters.get(nodeId);
    if (nodeParams?.has(paramName)) {
      return nodeParams.get(paramName) || false;
    }
    return false;
  };

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

  function handleBooleanChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    updateParameter(param, input.checked ? 1 : 0);
  }

  function handleSelectChange(param: Parameter, event: Event) {
    const select = event.target as HTMLSelectElement;
    // A SELECT is an enum: its option values ARE the integer index (see flowStore
    // convertWasmParameter). Store a number so it travels over the wire as an int.
    updateParameter(param, parseInt(select.value, 10));
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
    modRaf = requestAnimationFrame(tickLive); // drive the automated-slider thumbs

    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });

  onDestroy(() => {
    clearTimeout(deleteTimeout);
    cancelAnimationFrame(modRaf);
  });

  function getUniqueInputId(paramName: string): string {
    return `param-input-${node.id}-${paramName}`;
  }

  function handleInteractiveToggle(param: Parameter, event: Event) {
    const checkbox = event.target as HTMLInputElement;
    const wantsInteractive = checkbox.checked;

    const success = setParameterInteractive(node.id, param.name, wantsInteractive);

    if (!success) {
      // Revert the checkbox state
      checkbox.checked = false;
      // Show error message
      alert(`Maximum of ${MAX_INTERACTIVE_PARAMS} interactive parameters allowed. Please uncheck other parameters first.`);
    } else if (wantsInteractive) {
      // Interactive and automated are mutually exclusive.
      clearModulator(node.id, param.name);
    }
  }

  // ---- Parameter automation (LFO / noise / random) ----
  let automating: Parameter | null = null;              // param whose automation sub-panel is open
  let liveValues: Record<string, number> = {};          // live modulated value per param (moving thumb)
  let modRaf = 0;

  const SLIDER_TYPES = new Set(['float', 'integer', 'range', 'hue']);
  const isSlider = (p: Parameter) => SLIDER_TYPES.has(p.type as string);
  // Reactive modulator lookup (subscribes to the store).
  $: getModReactive = (paramName: string): ModulatorConfig | null => $modulators.get(node.id)?.get(paramName) ?? null;

  function paramRange(p: Parameter) { return { lo: p.min ?? 0, hi: p.max ?? ((p.type === 'hue') ? 255 : 1) }; }

  function openAutomation(param: Parameter) {
    if (!getModulator(node.id, param.name)) {
      const { lo, hi } = paramRange(param);
      setModulator(node.id, param.name, { shape: 0, min: lo, max: hi, period: 5 });
      if (getParameterInteractive(node.id, param.name)) setParameterInteractive(node.id, param.name, false); // exclusive
    }
    automating = param;
  }
  function stopAutomation(param: Parameter) { clearModulator(node.id, param.name); automating = null; }
  function updateMod(param: Parameter, patch: Partial<ModulatorConfig>) {
    const cur = getModulator(node.id, param.name); if (!cur) return;
    setModulator(node.id, param.name, { ...cur, ...patch });
  }

  // Tiny SVG waveform for each shape (viewBox 0 0 32 14).
  function shapePath(s: number): string {
    switch (s) {
      case 0: return 'M0 7 Q4 0 8 7 T16 7 T24 7 T32 7';                 // sine
      case 1: return 'M0 13 L8 1 L16 13 L24 1 L32 13';                  // triangle
      case 2: return 'M0 13 L14 1 L14 13 L28 1 L28 13';                 // sawtooth
      case 3: return 'M0 13 L0 1 L16 1 L16 13 L32 13 L32 1';            // square
      case 4: return 'M0 10 L8 10 L8 3 L16 3 L16 13 L24 13 L24 6 L32 6';// random
      case 5: return 'M0 8 Q6 3 12 7 T24 6 T32 9';                      // perlin
      default: return 'M0 7 L32 7';
    }
  }

  // Live value for the moving thumb — evaluated via the shared WASM math (same as preview+device).
  function tickLive() {
    const m: any = (typeof window !== 'undefined') ? (window as any).getWasmModule?.() : null;
    const nodeMods = $modulators.get(node.id);
    if (m && nodeMods && nodeMods.size && nodeDefinition) {
      const t = Math.floor(performance.now()) % 1000000;
      let i = 0;
      for (const p of nodeDefinition.params) {
        const cfg = nodeMods.get(p.name);
        if (cfg) liveValues[p.name] = m.ccall('evalModulator', 'number',
          ['number','number','number','number','number','number'], [cfg.shape, cfg.min, cfg.max, cfg.period, t, i]);
        i++;
      }
      liveValues = liveValues; // reactivity
    }
    modRaf = requestAnimationFrame(tickLive);
  }
</script>

<div 
  bind:this={popoverElement}
  class="parameter-popover"
  style="position: fixed; {getPopoverPosition().top !== undefined ? `top: ${getPopoverPosition().top}px;` : ''} {getPopoverPosition().left !== undefined ? `left: ${getPopoverPosition().left}px;` : ''} {getPopoverPosition().right !== undefined ? `right: ${getPopoverPosition().right}px;` : ''} {getPopoverPosition().bottom !== undefined ? `bottom: ${getPopoverPosition().bottom}px;` : ''} visibility: {visible ? 'visible' : 'hidden'}; opacity: {visible ? '1' : '0'}; transition: opacity 0.2s ease;"
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
  role="dialog"
  aria-labelledby="popover-header-title"
  tabindex="-1"
>
  <div class="popover-header">
    <h3 id="popover-header-title">{node.data.label} Parameters</h3>
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
      <button class="close-btn" onclick={handleClose} aria-label="Close parameter editor">×</button>
    </div>
  </div>
  
  <div class="popover-content">
    {#if automating}
      {@const p = automating}
      {@const cfg = getModReactive(p.name)}
      <div class="automation-panel">
        <button type="button" class="back-btn" onclick={() => (automating = null)}>← Back</button>
        <h4 class="auto-title">Automate: {p.label}</h4>
        {#if cfg}
          <div class="shape-grid">
            {#each SHAPES as name, si}
              <button type="button" class="shape-btn" class:sel={cfg.shape === si} title={name} onclick={() => updateMod(p, { shape: si })}>
                <svg viewBox="0 0 32 14" width="36" height="16" aria-hidden="true"><path d={shapePath(si)} fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
                <span>{name}</span>
              </button>
            {/each}
          </div>
          <label class="mod-field">Min <input type="number" step="any" value={cfg.min} oninput={(e) => updateMod(p, { min: parseFloat(e.currentTarget.value) })} /></label>
          <label class="mod-field">Max <input type="number" step="any" value={cfg.max} oninput={(e) => updateMod(p, { max: parseFloat(e.currentTarget.value) })} /></label>
          <label class="mod-field">Period (sec/cycle) <input type="number" min="0.1" step="0.1" value={cfg.period} oninput={(e) => updateMod(p, { period: Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1) })} /></label>
          <button type="button" class="stop-btn" onclick={() => stopAutomation(p)}>Stop automating</button>
        {/if}
      </div>
    {:else if nodeDefinition && nodeDefinition.params.length > 0}
      {#each nodeDefinition.params as param (param.name)}
        {@const inputId = getUniqueInputId(param.name)}
        <div class="parameter-group">
          <div class="parameter-header">
            <label class="parameter-label" for={inputId}>{param.label}</label>
            <div class="interactive-checkbox">
              <input 
                type="checkbox" 
                id="interactive-{inputId}"
                checked={getParameterInteractiveReactive(node.id, param.name)}
                onchange={(e) => handleInteractiveToggle(param, e)}
              />
              <label for="interactive-{inputId}" class="hand-emoji" title="Interactive parameter (shows knob on interact page)">🖐️</label>
            </div>
            {#if isSlider(param)}
              <button type="button" class="automate-btn" class:active={!!getModReactive(param.name)}
                title="Automate this parameter (LFO / noise / random)" onclick={() => openAutomation(param)}>🔄</button>
            {/if}
          </div>
          
          {#if isSlider(param) && getModReactive(param.name)}
            {@const cfg = getModReactive(param.name)!}
            <div class="automated-control" role="button" tabindex="0" title="Edit automation"
              onclick={() => openAutomation(param)} onkeydown={(e) => { if (e.key === 'Enter') openAutomation(param); }}>
              <input type="range" min={param.min ?? 0} max={param.max ?? (param.type === 'hue' ? 255 : 1)} step="any"
                value={liveValues[param.name] ?? cfg.min} disabled />
              <span class="auto-tag">🔄 {SHAPES[cfg.shape]} · {(+cfg.min).toFixed(1)}–{(+cfg.max).toFixed(1)} · {cfg.period}s</span>
            </div>
          {:else if param.type === 'float'}
            <div class="float-control">
              <input
                id={inputId}
                type="range"
                min={param.min ?? 0} 
                max={param.max ?? 1} 
                step={((param.max ?? 1) - (param.min ?? 0)) / 100}
                value={getParameterValue(param)}
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param).toFixed(2)}</span>
            </div>
          {:else if param.type === 'boolean'}
            <div class="boolean-control">
              <input
                id={inputId}
                type="checkbox"
                checked={Number(getParameterValue(param)) !== 0}
                onchange={(e) => handleBooleanChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
              />
            </div>
          {:else if param.type === 'range'}
            <div class="range-control">
              <input
                id={inputId}
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
                id={inputId}
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
                id={inputId}
                type="color" 
                value={getParameterValue(param)}
                oninput={(e) => handleColorChange(param, e)}
              />
              <span class="color-value">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'hue'}
            <div class="hue-control">
              <input 
                id={inputId}
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
                id={inputId}
                value={String(getParameterValue(param))}
                onchange={(e) => handleSelectChange(param, e)}
              >
                {#if param.options}
                  {#each param.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                {/if}
              </select>
            </div>
          {:else if param.type === 'string'}
            <input
              id={inputId}
              class="text-input"
              type="text"
              maxlength="255"
              value={String(getParameterValue(param) ?? '')}
              oninput={(e) => updateParameter(param, (e.target as HTMLInputElement).value)}
            />
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

  .parameter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .parameter-label {
    font-size: 12px;
    font-weight: 500;
    color: #d1d5db;
    margin: 0;
  }

  .interactive-checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .interactive-checkbox input[type="checkbox"] {
    display: none;
  }

  .hand-emoji {
    font-size: 14px;
    cursor: pointer;
    opacity: 0.3;
    transition: opacity 0.2s ease;
    user-select: none;
  }

  .interactive-checkbox input[type="checkbox"]:checked + .hand-emoji {
    opacity: 1;
  }

  .hand-emoji:hover {
    opacity: 0.7;
  }

  .interactive-checkbox input[type="checkbox"]:checked + .hand-emoji:hover {
    opacity: 1;
    transform: scale(1.1);
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
    appearance: none; /* Added for broader compatibility */
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
    padding: 0; /* Ensure no extra padding affects size */
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
    appearance: none; /* Added for broader compatibility */
    -webkit-appearance: none; /* For Safari */
    -moz-appearance: none; /* For Firefox */
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

  /* ---- Parameter automation ---- */
  .automate-btn {
    background: none; border: none; cursor: pointer; font-size: 0.95rem;
    opacity: 0.4; padding: 0 2px; line-height: 1; filter: grayscale(1);
  }
  .automate-btn.active { opacity: 1; filter: none; }
  .automated-control { display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
  .automated-control input[type="range"] { width: 100%; accent-color: #22d3ee; opacity: 0.9; }
  .auto-tag { font-size: 0.72rem; color: #22d3ee; font-variant-numeric: tabular-nums; }
  .automation-panel { display: flex; flex-direction: column; gap: 10px; }
  .back-btn { align-self: flex-start; background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 0.85rem; padding: 0; }
  .auto-title { margin: 0; font-size: 0.95rem; color: #e5e7eb; }
  .shape-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .shape-btn {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: #111827; border: 1px solid #374151; border-radius: 6px; color: #9ca3af;
    padding: 6px 2px; cursor: pointer; font-size: 0.7rem;
  }
  .shape-btn.sel { border-color: #22d3ee; color: #22d3ee; background: #0e2a30; }
  .mod-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; color: #d1d5db; }
  .mod-field input { width: 90px; background: #111827; border: 1px solid #374151; border-radius: 4px; color: #e5e7eb; padding: 4px 6px; }
  .stop-btn { margin-top: 4px; background: #3f1d1d; border: 1px solid #7f1d1d; color: #fca5a5; border-radius: 6px; padding: 6px; cursor: pointer; font-size: 0.8rem; }
</style> 
