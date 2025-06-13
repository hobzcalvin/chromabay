<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { flowNodes, flowEdges, nodeOutputs } from '$lib/flowStore';
  import PatternNode from '$lib/PatternNode.svelte';
  import { SvelteFlow } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  // Map node type for SvelteFlow
  const nodeTypes = { pattern: PatternNode };

  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;

  // Offscreen canvas for scaling the output
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  // Find the output node id reactively
  $: outputNodeId = $flowNodes.find(n => n.data.type === 'output')?.id ?? '';

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

  onMount(() => {
    ctx = canvasElement.getContext('2d');
    const resize = () => {
      canvasElement.width = window.innerWidth;
      canvasElement.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    animate();

    return () => {
      window.removeEventListener('resize', resize);
    };
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
  });
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
<canvas bind:this={canvasElement} class="output-canvas"></canvas>

<style>
  .hidden-flow {
    display: none;
  }

  .output-canvas {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    touch-action: none;
  }
</style>
