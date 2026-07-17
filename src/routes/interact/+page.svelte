<script lang="ts">
import { onMount, tick } from 'svelte';
import PatternRenderer from '$lib/components/PatternRenderer.svelte';
import RotaryKnob from '$lib/components/RotaryKnob.svelte';
import ColorWheel from '$lib/components/ColorWheel.svelte';
import { loadPatterns, currentPattern, patterns, switchToPattern } from '$lib/stores/patternsStore';
import { loadSerializedPattern, initializeDefaultPattern, forceSyncCurrentPattern, 
         flowNodes, nodeParameters, getNodeDefinition, setNodeParameter, type Parameter } from '$lib/flowStore';
import { interactiveParameters } from '$lib/stores/interactiveStore';
import { modulators, getModulator, setModulator, SHAPES, type ModField } from '$lib/stores/modulatorStore';
import { exitCycle } from '$lib/stores/cycleStore';
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
    kind: 'knob' | 'color' | 'mod' | 'enum';   // color = hue+sat wheel; mod = automation field; enum = a select
    modField?: ModField;              // for kind 'mod': which automation field this knob drives
    labels?: string[];                // for enum knobs (select options, or automation envelope shapes)
    satParamName?: string;
    satValue?: number;
  }
  
  let dynamicKnobs: InteractiveKnob[] = [];

  // --- Knob layouts (1-6): up to 3 rows of 1-2 knobs, positioned as [left%, top%] within
  //   the band between the switcher and the bottom nav.
  //   1: center · 2: stacked (top+bottom) · 3: stacked ×3 · 4: 2×2 · 5: corners+center · 6: 2×3
  const KNOB_LAYOUTS: Record<number, [number, number][]> = {
    1: [[50, 50]],
    2: [[50, 30], [50, 70]],
    3: [[50, 20], [50, 50], [50, 80]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[28, 26], [72, 26], [50, 50], [28, 74], [72, 74]],
    6: [[30, 20], [70, 20], [30, 50], [70, 50], [30, 80], [70, 80]],
  };
  const LAYOUT_COLS: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2 };
  const LAYOUT_ROWS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 };

  let innerWidth = 0;
  let innerHeight = 0;
  let overlayEl: HTMLDivElement | undefined;
  let navInset = 88;   // px from the viewport bottom occupied by the bottom nav (measured)
  let bandsH = 0;      // measured height of the knob band (switcher bottom -> nav top)

  $: knobCount = Math.min(dynamicKnobs.length, 6);
  $: knobPositions = KNOB_LAYOUTS[knobCount] ?? [];

  function measureBand() {
    if (typeof document === 'undefined') return;
    const nav = document.querySelector('.bottom-nav');
    if (nav && innerHeight > 0) navInset = Math.max(0, Math.round(innerHeight - nav.getBoundingClientRect().top));
    bandsH = overlayEl ? overlayEl.clientHeight : 0;
  }
  // Re-measure when the band could have changed. tick() lets the DOM apply the new `bottom`
  // inset first so overlayEl.clientHeight (the band we distribute knobs within) is correct.
  $: { knobCount; innerHeight; innerWidth; tick().then(measureBand); }

  // Fit each knob inside its grid cell (band ÷ rows tall, width ÷ cols wide), leaving room
  // for the label, then clamp. Uses the measured band so knobs never hide behind the nav.
  $: knobSize = (() => {
    if (knobCount === 0) return 160;
    const band = bandsH > 0 ? bandsH : Math.max(160, innerHeight - 120 - navInset);
    const cellW = (innerWidth || 360) / LAYOUT_COLS[knobCount];
    const cellH = band / LAYOUT_ROWS[knobCount];
    const byWidth = cellW * 0.82;
    const byHeight = cellH * 0.82 - 38; // ~38px reserved for the label
    return Math.round(Math.max(80, Math.min(byWidth, byHeight, 260)));
  })();
  $: labelFontPx = Math.round(Math.max(11, Math.min(18, knobSize * 0.1)));

  // Make sure dynamicKnobs is reactive
  // $: console.log('🎛️ dynamicKnobs updated:', dynamicKnobs.length);
  
  // Reactive statement to regenerate knobs when interactive parameters change
  $: {
    // Wait for stores to be properly loaded and watch interactive params AND automations
    // ($modulators referenced so interactive-speed knobs appear/disappear reactively).
    if ($flowNodes.length > 0 && $interactiveParameters && $modulators) {
      const newKnobs = generateDynamicKnobs();
      if (newKnobs.length !== dynamicKnobs.length ||
          newKnobs.some((knob, i) =>
            !dynamicKnobs[i] ||
            knob.nodeId !== dynamicKnobs[i]?.nodeId ||
            knob.paramName !== dynamicKnobs[i]?.paramName ||
            knob.kind !== dynamicKnobs[i]?.kind ||
            knob.modField !== dynamicKnobs[i]?.modField
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
      const key = `${knob.nodeId}-${knob.paramName}-${knob.kind}-${knob.modField ?? ''}`;
      const previousValue = previousKnobValues.get(key);

      // Only update if the value actually changed
      if (previousValue !== knob.value) {
        if (knob.kind === 'mod' && knob.modField) {
          // Drive one field of the automation live (shape is an integer index).
          const cur = getModulator(knob.nodeId, knob.paramName);
          if (cur) setModulator(knob.nodeId, knob.paramName,
            { ...cur, [knob.modField]: knob.modField === 'shape' ? Math.round(knob.value) : knob.value });
        } else if (knob.kind === 'enum') {
          // Select param: the stored value is the option index (as a string).
          setNodeParameter(knob.nodeId, knob.paramName, String(Math.round(knob.value)));
        } else {
          setNodeParameter(knob.nodeId, knob.paramName, knob.value);
          // Note: setNodeParameter already handles auto-save with debouncing
        }
        previousKnobValues.set(key, knob.value);
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

        // Enum/select: the knob steps through the options (value = option index) and shows labels.
        const selOptions = (paramDef.type as string) === 'select' ? (paramDef.options ?? []) : null;
        if (selOptions) { min = 0; max = Math.max(0, selOptions.length - 1); step = 1; }

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
          value: selOptions ? (Number(currentValue) || 0) : currentValue,
          min,
          max,
          step,
          order: 0, // Default order for now
          kind: isColor ? 'color' : (selOptions ? 'enum' : 'knob'),
          labels: selOptions ? selOptions.map((o) => o.label) : undefined,
          satParamName: isColor ? 'saturation' : undefined,
          satValue,
        };
        
        console.log(`Created knob for ${paramName}: ${knob.paramLabel}`);
        knobsWithOrder.push({ knob, order: 0 });
      }
    }
    
    // Automation knobs: each automation field (envelope/min/max/period) flagged interactive
    // gets its own live knob. Numeric fields map to their natural range; the envelope is a
    // discrete knob stepping through the shapes.
    const currentModulators = get(modulators);
    for (const [nodeId, params] of currentModulators.entries()) {
      const node = currentNodes.find(n => n.id === nodeId);
      if (!node) continue;
      const nodeDefinition = getNodeDefinition(node.data.type as string);
      if (!nodeDefinition) continue;
      for (const [paramName, cfg] of params.entries()) {
        const fields = cfg.interactive ?? [];
        if (fields.length === 0) continue;
        const paramDef = nodeDefinition.params.find((p: Parameter) => p.name === paramName);
        const base = `${node.data.label || nodeDefinition.name} ${paramDef?.label ?? paramName}`;
        for (const field of fields) {
          let value: number, min: number, max: number, step: number, suffix: string;
          if (field === 'period') {
            value = cfg.period; min = 0.1; max = 30; step = 0.1; suffix = 'Period';
          } else if (field === 'shape') {
            value = cfg.shape; min = 0; max = SHAPES.length - 1; step = 1; suffix = 'Envelope';
          } else {
            // min / max endpoints live in the driven parameter's own units.
            const lo = paramDef?.min ?? 0, hi = paramDef?.max ?? 1;
            value = field === 'min' ? cfg.min : cfg.max;
            min = lo; max = hi; step = (hi - lo) > 20 ? 1 : 0.01;
            suffix = field === 'min' ? 'Min' : 'Max';
          }
          knobsWithOrder.push({
            knob: {
              nodeId, paramName, nodeType: node.data.type as string,
              paramLabel: `${base} ${suffix}`,
              value, min, max, step, order: 1, kind: 'mod', modField: field,
              labels: field === 'shape' ? [...SHAPES] : undefined,
            },
            order: 1,
          });
        }
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
      // Interacting is a Live action → devices must show the current pattern, not cycle.
      await exitCycle();
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

<svelte:window bind:innerWidth bind:innerHeight on:resize={measureBand} />

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
  <div class="knobs-overlay" bind:this={overlayEl} style="bottom: {navInset}px;">
    {#each dynamicKnobs.slice(0, 6) as knob, i (knob.nodeId + '-' + knob.paramName + '-' + knob.kind + '-' + (knob.modField ?? ''))}
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
            labels={knob.labels ?? []}
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
  /* The knob band = the space between the switcher pill and the bottom nav (bottom set
     inline to the measured nav inset, so nothing hides behind the nav). Knobs are placed
     within it by the [left%, top%] layout table. */
  .knobs-overlay {
    position: fixed;
    top: calc(max(1rem, env(safe-area-inset-top, 0px)) + 4.25rem);
    left: 0;
    right: 0;
    bottom: 0; /* overridden inline with the measured nav inset */
    z-index: 10;
    pointer-events: none;
  }

  .knob-container {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
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
