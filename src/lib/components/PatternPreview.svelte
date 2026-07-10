<script lang="ts">
  import { onMount, onDestroy, setContext } from 'svelte';
  import { writable } from 'svelte/store';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { deserializePatternWhenReady } from '$lib/patternSerializer';
  import { clearNodeModulators } from '$lib/stores/modulatorStore';
  import ContextualPatternNode from './ContextualPatternNode.svelte';
  import { SvelteFlow, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  export let pattern: SerializedPattern;
  export let size = 60;

  // Map node type for SvelteFlow
  const nodeTypes = { pattern: ContextualPatternNode };

  // LOCAL stores for this preview only - isolated from global state
  const localFlowNodes = writable<Node[]>([]);
  const localFlowEdges = writable<Edge[]>([]);
  const localNodeOutputs = writable<Map<string, ImageData>>(new Map());
  const localNodeParameters = writable<Map<string, any>>(new Map());
  const localGlobalStartTime = writable<number>(Date.now()); // Use synchronized timestamp

  // Set context so PatternNode components can access local stores
  setContext('flowNodes', localFlowNodes);
  setContext('flowEdges', localFlowEdges);
  setContext('nodeOutputs', localNodeOutputs);
  setContext('nodeParameters', localNodeParameters);
  setContext('globalStartTime', localGlobalStartTime);

  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;
  // Node IDs this preview registered modulators under (unique per deserialize) —
  // cleared on unmount so the shared modulators store doesn't grow with every thumbnail.
  let modulatedNodeIds: string[] = [];
  // The pattern object we last deserialized. The list keys items by name, so a slot
  // can be REUSED for a different pattern (e.g. after saving a new pattern over an
  // existing name) — when that happens the prop changes but the component instance
  // doesn't, so we must re-deserialize instead of showing the pattern we mounted with.
  let loadedPattern: SerializedPattern | null = null;

  // Offscreen canvas for scaling the output
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  // Find the output node id reactively from LOCAL nodes
  $: outputNodeId = $localFlowNodes.find(n => n.data.type === 'output')?.id ?? '';

  function renderOutput() {
    if (!ctx || !offCtx || !outputNodeId) return;
    const data = $localNodeOutputs.get(outputNodeId);
    if (!data) return;

    offscreen.width = data.width;
    offscreen.height = data.height;
    offCtx.putImageData(data, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ctx.drawImage(offscreen, 0, 0, canvasElement.width, canvasElement.height);
  }

  function animate() {
    renderOutput();
    animationFrame = requestAnimationFrame(animate);
  }

  // Deserialize once WASM operators are available. Using the synchronous
  // deserializePattern here raced WASM init on (re)load: with only the Output
  // operator loaded, every real node type ("rainbow", "blend", …) is unknown
  // and dropped, leaving an empty graph and a permanently black preview.
  // deserializePatternWhenReady waits for the operators first.
  // applyInteractiveParameters: false — previews are isolated; they must not
  // touch the global interactiveParameters store (doing so clobbered the live
  // pattern's interactive flags, so navigating to /patterns lost the knobs).
  // applyModulators: true — but we DO want automation to animate in the thumbnail.
  // Modulators are keyed by this deserialize's unique node IDs, so they can't
  // clobber the live pattern; we clear them again on unmount (see onDestroy).
  function loadPattern(p: SerializedPattern) {
    // Release the previous deserialize's automation entries before replacing them.
    for (const id of modulatedNodeIds) clearNodeModulators(id);
    modulatedNodeIds = [];
    deserializePatternWhenReady(p, 5000, { applyInteractiveParameters: false, applyModulators: true })
      .then(({ nodes, edges, nodeParameters }) => {
        if (p !== pattern) return; // a newer pattern arrived while we awaited WASM
        localFlowNodes.set(nodes);
        localFlowEdges.set(edges);
        localNodeParameters.set(nodeParameters);
        modulatedNodeIds = nodes.map(n => n.id);
      })
      .catch((err) => console.warn('PatternPreview: failed to deserialize pattern', err));
  }

  // (Re)load whenever the pattern prop changes — covers a reused list slot pointing
  // at a different pattern, not just the initial mount.
  $: if (pattern && pattern !== loadedPattern) { loadedPattern = pattern; loadPattern(pattern); }

  onMount(() => {
    // Setup canvas
    ctx = canvasElement.getContext('2d');
    canvasElement.width = size;
    canvasElement.height = size;
    animate();
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    // Release this preview's automation entries from the shared modulators store.
    for (const id of modulatedNodeIds) clearNodeModulators(id);
  });
</script>

<!-- Hidden flow keeps the rendering pipeline running - uses LOCAL stores -->
<div class="preview-container" style="width: {size}px; height: {size}px;">
  <div class="hidden-flow">
    <SvelteFlow
      bind:nodes={$localFlowNodes}
      bind:edges={$localFlowEdges}
      {nodeTypes}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      edgesFocusable={false}
      nodesDraggable={false}
      elementsSelectable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      zoomOnPinch={false}
    />
  </div>

  <!-- Visible canvas displaying the output node -->
  <canvas bind:this={canvasElement} class="preview-canvas"></canvas>
</div>

<style>
  .preview-container {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    background: #000;
  }

  .hidden-flow {
    display: none;
  }

  .preview-canvas {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    image-rendering: pixelated;
  }
</style> 