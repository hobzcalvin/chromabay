<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { flowNodes, flowEdges, nodeOutputs } from '$lib/flowStore';
  import { inferOutputNode } from '$lib/patternSerializer';
  import PatternNode from '$lib/PatternNode.svelte';
  import { SvelteFlow } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { setFullscreenDimensions, resetToDefaultDimensions } from '$lib/renderConfig';

  export let width: number = 100;
  export let height: number = 100;
  export let fullscreen: boolean = false;

  // Map node type for SvelteFlow
  const nodeTypes = { pattern: PatternNode };

  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;

  // Offscreen canvas for scaling the output
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  // Find the output node id reactively
  $: outputNodeId = inferOutputNode($flowNodes, $flowEdges)?.id ?? '';

  function renderOutput() {
    if (!ctx || !offCtx || !outputNodeId) return;
    const data = $nodeOutputs.get(outputNodeId);
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

  function setupCanvas() {
    if (!canvasElement) return;
    if (fullscreen) {
      canvasElement.width = window.innerWidth;
      canvasElement.height = window.innerHeight;
      // Set the render config to match screen dimensions for high-resolution rendering
      setFullscreenDimensions(window.innerWidth, window.innerHeight);
    } else {
      canvasElement.width = width;
      canvasElement.height = height;
      // Reset to default dimensions for non-fullscreen mode
      resetToDefaultDimensions();
    }
  }

  onMount(() => {
    ctx = canvasElement.getContext('2d');
    setupCanvas();
    
    let resize: (() => void) | undefined;
    if (fullscreen) {
      resize = () => setupCanvas();
      window.addEventListener('resize', resize);
    }
    
    animate();

    return () => {
      if (resize) window.removeEventListener('resize', resize);
    };
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    // Reset render config when component is destroyed
    resetToDefaultDimensions();
  });

  // Watch for fullscreen prop changes and update canvas accordingly
  $: if (canvasElement) {
    setupCanvas();
  }
</script>

<!-- Hidden flow keeps the rendering pipeline running -->
<div class="hidden-flow">
  <SvelteFlow
    bind:nodes={$flowNodes}
    bind:edges={$flowEdges}
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
<canvas 
  bind:this={canvasElement} 
  class="output-canvas"
  class:fullscreen
  style={fullscreen ? '' : `width: ${width}px; height: ${height}px;`}
></canvas>

<style>
  .hidden-flow {
    display: none;
  }

  .output-canvas {
    display: block;
    border-radius: 8px;
    image-rendering: pixelated;
  }

  .output-canvas.fullscreen {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    touch-action: none;
    border-radius: 0;
  }
</style>     