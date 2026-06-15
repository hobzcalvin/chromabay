<script lang="ts">
import { onMount } from 'svelte';
import PatternRenderer from '$lib/components/PatternRenderer.svelte';
import RotaryKnob from '$lib/components/RotaryKnob.svelte';
import { loadPatterns, currentPattern } from '$lib/stores/patternsStore';
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
  }
  
  let dynamicKnobs: InteractiveKnob[] = [];
  
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
        // Optional: console.log(`🎛️ Knob value changed: ${knob.paramLabel} = ${knob.value}`);
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
        
        const knob: InteractiveKnob = {
          nodeId,
          paramName,
          paramLabel: `${node.data.label || nodeDefinition.name} ${paramDef.label}`,
          nodeType: node.data.type as string,
          value: currentValue,
          min,
          max,
          step,
          order: 0 // Default order for now
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

<!-- Full-screen pattern renderer -->
<PatternRenderer fullscreen={true} />

<!-- Dynamic rotary knobs overlay -->
{#if dynamicKnobs.length > 0}
  <div class="knobs-overlay" class:many-knobs={dynamicKnobs.length > 3}>
    {#each dynamicKnobs as knob (knob.nodeId + '-' + knob.paramName)}
      <div class="knob-container">
              <RotaryKnob
                bind:value={knob.value}
                min={knob.min}
                max={knob.max}
                step={knob.step}
                size={dynamicKnobs.length > 4 ? 150 : 200}
              />
        <div class="knob-label">{knob.paramLabel}</div>
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
  .knobs-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 10;
    pointer-events: auto;
    display: flex;
    gap: 60px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 90vw;
  }
  
  .knobs-overlay.many-knobs {
    gap: 40px;
  }

  .knob-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .knob-label {
    color: white;
    font-size: 18px;
    font-weight: 500;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    text-align: center;
    pointer-events: none;
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

  /* Responsive design for mobile */
  @media (max-width: 768px) {
    .knobs-overlay {
      flex-direction: column;
      gap: 40px;
      max-height: 80vh;
      overflow-y: auto;
    }
    
    .knobs-overlay.many-knobs {
      gap: 30px;
    }
    
    .knob-container {
      gap: 12px;
    }
    
    .knob-label {
      font-size: 16px;
    }
    
    .no-knobs-message {
      font-size: 16px;
      padding: 0 20px;
    }
    
    .no-knobs-message p:first-child {
      font-size: 20px;
    }
  }

</style>
