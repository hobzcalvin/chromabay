<script lang="ts">
import { onMount } from 'svelte';
import PatternRenderer from '$lib/components/PatternRenderer.svelte';
import RotaryKnob from '$lib/components/RotaryKnob.svelte';
import ColorWheel from '$lib/components/ColorWheel.svelte';
import { loadPatterns, currentPattern, patterns, switchToPattern } from '$lib/stores/patternsStore';
import { loadSerializedPattern, initializeDefaultPattern, forceSyncCurrentPattern, 
         flowNodes, nodeParameters, getNodeDefinition, setNodeParameter, type Parameter } from '$lib/flowStore';
import { interactiveParameters } from '$lib/stores/interactiveStore';
import type { Node } from '@xyflow/svelte';
import { get } from 'svelte/store';

  // Remove unused notification code
  
  // Dynamic knobs based on interactive parameters
  interface InteractiveKnob {
    nodeId: string;
    paramName: string;
    paramLabel: string;
    nodeType: string;
    value: number;
    min: number;
    max: number;
    step: number;
    order: number;
    kind: 'knob' | 'color';   // a hue+saturation pair renders a wheel, not a knob
    satParamName?: string;
    satValue?: number;
  }
  
  let dynamicKnobs: InteractiveKnob[] = [];

  // --- Knob layouts (1-6) ---
  // Deliberate, evenly-spaced positions as [left%, top%] of the screen. Tuned for a
  // phone held vertically (single column when few; two columns + corners when many)
  // but the percentages + responsive sizing below adapt to any aspect ratio.
  //   1: center · 2-3: stacked vertically · 4: corners · 5: corners + center
  //   6: two columns of three
  const KNOB_LAYOUTS: Record<number, [number, number][]> = {
    1: [[50, 50]],
    2: [[50, 33], [50, 67]],
    3: [[50, 22], [50, 50], [50, 78]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[28, 27], [72, 27], [50, 50], [28, 73], [72, 73]],
    6: [[30, 22], [70, 22], [30, 50], [70, 50], [30, 78], [70, 78]],
  };
  // Columns/rows each layout occupies, for sizing knobs so they never overlap.
  const LAYOUT_COLS: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2 };
  const LAYOUT_ROWS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 };

  let innerWidth = 0;
  let innerHeight = 0;

  $: knobCount = Math.min(dynamicKnobs.length, 6);
  $: knobPositions = KNOB_LAYOUTS[knobCount] ?? [];
  // Fit each knob inside its grid cell, reserving room for the label, then clamp.
  $: knobSize = (() => {
    if (knobCount === 0 || innerWidth === 0 || innerHeight === 0) return 160;
    const cellW = innerWidth / LAYOUT_COLS[knobCount];
    const cellH = innerHeight / LAYOUT_ROWS[knobCount];
    const byWidth = cellW * 0.8;
    const byHeight = cellH * 0.78 - 36; // ~36px reserved for the label
    return Math.round(Math.max(88, Math.min(byWidth, byHeight, 240)));
  })();
  $: labelFontPx = Math.round(Math.max(11, Math.min(18, knobSize * 0.1)));

  // Make sure dynamicKnobs is reactive
  // $: console.log('🎛️ dynamicKnobs updated:', dynamicKnobs.length);
  
  // Reactive statement to regenerate knobs when interactive parameters change
  $: {
    // Wait for stores to be properly loaded and watch interactive parameters
    if ($flowNodes.length > 0 && $interactiveParameters) {
      const newKnobs = generateDynamicKnobs();
      if (newKnobs.length !== dynamicKnobs.length || 
          newKnobs.some((knob, i) => 
            !dynamicKnobs[i] || 
            knob.nodeId !== dynamicKnobs[i]?.nodeId || 
            knob.paramName !== dynamicKnobs[i]?.paramName
          )) {
        dynamicKnobs = newKnobs;
        console.log('🎛️ Reactively updated knobs:', dynamicKnobs.length);
      }
    }
  }
  
  // Track previous knob values to detect changes
  let previousKnobValues = new Map<string, number>();
  
  // Reactive statement to update parameters when knob values change
  $: {
    for (const knob of dynamicKnobs) {
      const key = `${knob.nodeId}-${knob.paramName}`;
      const previousValue = previousKnobValues.get(key);
      
      // Only update if the value actually changed
      if (previousValue !== knob.value) {
        setNodeParameter(knob.nodeId, knob.paramName, knob.value);
        previousKnobValues.set(key, knob.value);
        // Note: setNodeParameter already handles auto-save with debouncing
      }
      // Colour wheel also drives the saturation param.
      if (knob.kind === 'color' && knob.satParamName) {
        const sKey = `${knob.nodeId}-${knob.satParamName}`;
        if (previousKnobValues.get(sKey) !== knob.satValue) {
          setNodeParameter(knob.nodeId, knob.satParamName, knob.satValue ?? 255);
          previousKnobValues.set(sKey, knob.satValue ?? 255);
        }
      }
    }
  }

  function generateDynamicKnobs(): InteractiveKnob[] {
    console.log('🎛️ Generating dynamic knobs...');
    
    // Get current flow nodes and interactive parameters
    const currentNodes = get(flowNodes);
    const currentInteractiveParams = get(interactiveParameters);
    const currentNodeParams = get(nodeParameters);
    
    console.log('Current nodes:', currentNodes.length);
    console.log('Interactive parameters:', currentInteractiveParams.size);
    
    // Create an array to store knobs with their order
    const knobsWithOrder: { knob: InteractiveKnob; order: number }[] = [];
    
    for (const [nodeId, nodeInteractiveParams] of currentInteractiveParams.entries()) {
      console.log(`Processing node ${nodeId} with ${nodeInteractiveParams.size} interactive params`);
      
      const node = currentNodes.find(n => n.id === nodeId);
      if (!node) {
        console.log(`Node ${nodeId} not found in current nodes`);
        continue;
      }
      
      const nodeDefinition = getNodeDefinition(node.data.type as string);
      if (!nodeDefinition) {
        console.log(`Node definition not found for type ${node.data.type}`);
        continue;
      }
      
      const nodeParams = currentNodeParams.get(nodeId) || new Map();
      
      for (const [paramName, isInteractive] of nodeInteractiveParams.entries()) {
        if (!isInteractive) continue;
        
        console.log(`Processing interactive param ${paramName} for node ${nodeId}`);
        
        const paramDef = nodeDefinition.params.find((p: Parameter) => p.name === paramName);
        if (!paramDef) {
          console.log(`Parameter definition not found for ${paramName}`);
          continue;
        }
        
        const currentValue = nodeParams.get(paramName) ?? paramDef.default;
        
        // Debug: console.log(`Parameter ${paramName}:`, currentValue);
        
        // Determine knob properties based on parameter type
        let min = 0;
        let max = 100;
        let step = 1;
        
        if (paramDef.type === 'float' || paramDef.type === 'range') {
          min = paramDef.min ?? 0;
          max = paramDef.max ?? 1;
          step = paramDef.type === 'float' ? 0.01 : 1;
        } else if (paramDef.type === 'integer') {
          min = paramDef.min ?? 0;
          max = paramDef.max ?? 100;
          step = 1;
        } else if (paramDef.type === 'hue') {
          min = 0;
          max = 360;
          step = 1;
        }
        
        // A hue param on an operator that also has saturation → a colour wheel (controls both).
        const satDef = nodeDefinition.params.find((p: Parameter) => p.name === 'saturation');
        const isColor = paramName === 'hue' && !!satDef;
        const satValue = satDef ? (nodeParams.get('saturation') ?? satDef.default) : 255;

        const knob: InteractiveKnob = {
          nodeId,
          paramName,
          paramLabel: isColor
            ? `${node.data.label || nodeDefinition.name} Color`
            : `${node.data.label || nodeDefinition.name} ${paramDef.label}`,
          nodeType: node.data.type as string,
          value: currentValue,
          min,
          max,
          step,
          order: 0, // Default order for now
          kind: isColor ? 'color' : 'knob',
          satParamName: isColor ? 'saturation' : undefined,
          satValue,
        };
        
        console.log(`Created knob for ${paramName}: ${knob.paramLabel}`);
        knobsWithOrder.push({ knob, order: 0 });
      }
    }
    
    // Sort knobs by their order (for consistent positioning)
    knobsWithOrder.sort((a, b) => a.order - b.order);
    
    console.log(`Generated ${knobsWithOrder.length} knobs total`);
    return knobsWithOrder.map(item => item.knob);
  }

  // handleKnobChange function removed - now using reactive binding instead

  // Pattern switcher: cycle the current pattern without leaving Interact. Same effect
  // as selecting on the Patterns page (loads into the flow store + syncs to devices);
  // the knobs above regenerate reactively for the new pattern.
  $: currentPatternName = $currentPattern?.meta?.name ?? '';
  let switching = false;
  async function switchPattern(dir: number) {
    if (switching) return;
    switching = true;
    try {
      const list = get(patterns);
      if (!list || list.length === 0) return;
      let idx = list.findIndex(p => p.meta?.name === get(currentPattern)?.meta?.name);
      if (idx < 0) idx = 0;
      const next = list[(idx + dir + list.length) % list.length];
      if (!next?.meta?.name) return;
      await switchToPattern(next.meta.name);
      await loadSerializedPattern(next);
      forceSyncCurrentPattern();
    } catch (e) {
      console.error('Interact: switch pattern failed', e);
    } finally {
      switching = false;
    }
  }

  onMount(async () => {
    // Initialize patterns on mount (same as editor page)
    try {
      console.log('🎯 Starting interact page initialization...');
      await loadPatterns();
      
      // Load the current pattern into the flow editor
      const current = $currentPattern;
      if (current) {
        await loadSerializedPattern(current);
        console.log('🎯 Loaded current pattern for interact mode:', current.meta?.name);
      } else {
        // Fallback to default pattern
        initializeDefaultPattern();
        console.log('🔄 No current pattern found, using default for interact mode');
      }
      
      // Dynamic knobs will be generated reactively via the $: statement above
      
      // Force sync the loaded pattern to connected devices
      forceSyncCurrentPattern();
    } catch (error) {
      console.error('❌ Failed to load patterns in interact mode:', error);
      // Fallback to default pattern on error
      initializeDefaultPattern();
      // Dynamic knobs will be generated reactively via the $: statement above
      // Still try to sync the default pattern
      forceSyncCurrentPattern();
    }
  });
</script>

<svelte:window bind:innerWidth bind:innerHeight />

<!-- Full-screen pattern renderer -->
<PatternRenderer fullscreen={true} />

<!-- Pattern switcher: prev / name / next -->
{#if $patterns.length > 1}
  <div class="pattern-switcher">
    <button class="switch-btn" onclick={() => switchPattern(-1)} aria-label="Previous pattern">‹</button>
    <span class="switch-name">{currentPatternName}</span>
    <button class="switch-btn" onclick={() => switchPattern(1)} aria-label="Next pattern">›</button>
  </div>
{/if}

<!-- Dynamic rotary knobs overlay -->
{#if dynamicKnobs.length > 0}
  <div class="knobs-overlay">
    {#each dynamicKnobs.slice(0, 6) as knob, i (knob.nodeId + '-' + knob.paramName)}
      <div
        class="knob-container"
        style="left: {knobPositions[i]?.[0] ?? 50}%; top: {knobPositions[i]?.[1] ?? 50}%;"
      >
        {#if knob.kind === 'color'}
          <ColorWheel
            hue={knob.value}
            sat={knob.satValue ?? 255}
            size={knobSize}
            on:change={(e) => { knob.value = e.detail.hue; knob.satValue = e.detail.sat; dynamicKnobs = dynamicKnobs; }}
          />
        {:else}
          <RotaryKnob
            bind:value={knob.value}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            size={knobSize}
          />
        {/if}
        <div class="knob-label" style="font-size: {labelFontPx}px; max-width: {knobSize + 48}px;">{knob.paramLabel}</div>
      </div>
    {/each}
  </div>
{:else}
  <div class="no-knobs-message">
    <p>No interactive parameters selected</p>
    <p>Go to the Editor and click the 🖐️ next to parameters to make them interactive</p>
  </div>
{/if}


<style>
  /* Pattern switcher pill, pinned top-center above the renderer + knobs. */
  .pattern-switcher {
    position: fixed;
    top: max(1rem, env(safe-area-inset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: 94vw;
    padding: 0.5rem 0.75rem;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    backdrop-filter: blur(8px);
  }
  .switch-btn {
    flex-shrink: 0;
    width: 3rem;
    height: 3rem;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    font-size: 2rem;
    line-height: 1;
    cursor: pointer;
  }
  .switch-btn:active { background: rgba(255, 255, 255, 0.3); }
  .switch-name {
    color: #fff;
    font-weight: 600;
    font-size: 1.25rem;
    max-width: 60vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Full-screen overlay; knobs are positioned absolutely from the layout table.
     The overlay itself ignores pointer events so taps in the gaps reach the
     pattern behind it; each knob re-enables them. */
  .knobs-overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    pointer-events: none;
  }

  .knob-container {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
  }

  .knob-label {
    color: white;
    font-weight: 500;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    text-align: center;
    pointer-events: none;
    line-height: 1.2;
  }

  .no-knobs-message {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: white;
    text-align: center;
    font-size: 18px;
    font-weight: 500;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    z-index: 10;
    pointer-events: none;
  }
  
  .no-knobs-message p {
    margin: 8px 0;
  }
  
  .no-knobs-message p:first-child {
    font-size: 24px;
    margin-bottom: 16px;
  }

  /* Responsive design for mobile. The knob grid handles its own sizing/spacing via
     percentages + JS; only the no-knobs message needs tweaking here. */
  @media (max-width: 768px) {
    .no-knobs-message {
      font-size: 16px;
      padding: 0 20px;
    }
    
    .no-knobs-message p:first-child {
      font-size: 20px;
    }
  }

</style>
