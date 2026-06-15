<script lang="ts">
  import { onMount, onDestroy, setContext } from 'svelte';
  import { writable } from 'svelte/store';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { deserializePatternWhenReady } from '$lib/patternSerializer';
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

  onMount(() => {
    // Setup canvas
    ctx = canvasElement.getContext('2d');
    canvasElement.width = size;
    canvasElement.height = size;

    // Deserialize once WASM operators are available. Using the synchronous
    // deserializePattern here raced WASM init on (re)load: with only the Output
    // operator loaded, every real node type ("rainbow", "blend", …) is unknown
    // and dropped, leaving an empty graph and a permanently black preview.
    // deserializePatternWhenReady waits for the operators first.
    deserializePatternWhenReady(pattern)
      .then(({ nodes, edges, nodeParameters }) => {
        localFlowNodes.set(nodes);
        localFlowEdges.set(edges);
        localNodeParameters.set(nodeParameters);
      })
      .catch((err) => console.warn('PatternPreview: failed to deserialize pattern', err));

    animate();
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
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