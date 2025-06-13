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
  let showNotification = true;
  let notificationVisible = true;

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

    // Start fade out after 2 seconds, then hide after transition
    setTimeout(() => {
      notificationVisible = false;
    }, 2000);
    
    setTimeout(() => {
      showNotification = false;
    }, 3000);

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

<!-- Temporary notification -->
{#if showNotification}
  <div class="notification" class:fade-out={!notificationVisible}>
    Use swipe or browser back to leave Interact mode
  </div>
{/if}

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

  .notification {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 16px 24px;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 500;
    text-align: center;
    z-index: 1000;
    pointer-events: none;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    opacity: 1;
    transition: opacity 1s ease-out;
  }

  .notification.fade-out {
    opacity: 0;
  }
</style>
