<script lang="ts">
  import { screenScratch } from '$lib/ledDisplay';
  import { onMount, onDestroy } from 'svelte';
  import { flowNodes, flowEdges, nodeOutputs } from '$lib/flowStore';
  import PatternNode from '$lib/PatternNode.svelte';
  import { SvelteFlow } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { setFullscreenDimensions, setRenderDimensions, resetToDefaultDimensions } from '$lib/renderConfig';
  import { litCells, shapeSize, type StripShape } from '$lib/stores/deviceLayoutStore';

  export let width: number = 100;
  export let height: number = 100;
  export let fullscreen: boolean = false;
  // Fullscreen only: show the pattern the way a device does — one square per LED, for each of
  // its strips (stacked top to bottom), instead of stretched across the screen.
  export let shapes: StripShape[] | null = null;
  // Fullscreen + shapes: screen space (px) kept clear above and below the drawing.
  export let insetTop: number = 0;
  export let insetBottom: number = 0;

  // Map node type for SvelteFlow
  const nodeTypes = { pattern: PatternNode };

  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;

  // Offscreen canvas for scaling the output
  const toScreen = screenScratch();
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  // Find the output node id reactively
  $: outputNodeId = $flowNodes.find(n => n.data.type === 'output')?.id ?? '';

  // Per-strip cell placement, rebuilt when the shapes or the screen change.
  type Placed = { w: number; h: number; lit: Uint8Array; x: number; y: number; cell: number; img: ImageData };
  let placed: Placed[] = [];
  let stripCanvas = document.createElement('canvas');
  let stripCtx = stripCanvas.getContext('2d');

  function placeShapes() {
    placed = [];
    if (!shapes?.length || !canvasElement) return;
    const sizes = shapes.map(shapeSize).filter((z) => z.width > 0 && z.height > 0);
    const valid = shapes.filter((s) => { const z = shapeSize(s); return z.width > 0 && z.height > 0; });
    if (!sizes.length) return;
    const margin = 16;
    const availW = Math.max(1, canvasElement.width - 2 * margin);
    const availH = Math.max(1, canvasElement.height - insetTop - insetBottom - 2 * margin);
    const maxW = Math.max(...sizes.map((z) => z.width));
    const rows = sizes.reduce((a, z) => a + z.height, 0) + (sizes.length - 1); // one-cell gap between strips
    // Square cells as big as fit, never stretched; capped so a 1-LED device isn't a wall.
    const cell = Math.max(1, Math.min(availW / maxW, availH / rows, 160));
    let y = insetTop + margin + (availH - rows * cell) / 2;
    valid.forEach((s, i) => {
      const { width: w, height: h } = sizes[i];
      placed.push({ w, h, lit: litCells(s), x: (canvasElement.width - w * cell) / 2, y, cell, img: new ImageData(w, h) });
      y += (h + 1) * cell;
    });
  }

  // The canvas the pattern renders at: the device's own size (the largest strip), so it looks
  // the way the device renders it. Smaller strips sample that canvas at their cell centres.
  function deviceRenderSize(): { width: number; height: number } | null {
    if (!shapes?.length) return null;
    const sizes = shapes.map(shapeSize);
    const width = Math.max(1, ...sizes.map((z) => z.width));
    const height = Math.max(1, ...sizes.map((z) => z.height));
    return { width, height };
  }

  function renderShapes(src: ImageData) {
    if (!ctx || !stripCtx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
    const sd = src.data, SW = src.width, SH = src.height;
    for (const p of placed) {
      const d = p.img.data;
      for (let y = 0; y < p.h; y++) {
        const sy = Math.min(SH - 1, Math.floor(((y + 0.5) * SH) / p.h));
        for (let x = 0; x < p.w; x++) {
          const c = y * p.w + x, o = c * 4;
          if (!p.lit[c]) { d[o + 3] = 0; continue; }
          const sx = Math.min(SW - 1, Math.floor(((x + 0.5) * SW) / p.w));
          const so = (sy * SW + sx) * 4;
          d[o] = sd[so]; d[o + 1] = sd[so + 1]; d[o + 2] = sd[so + 2]; d[o + 3] = 255;
        }
      }
      if (stripCanvas.width !== p.w || stripCanvas.height !== p.h) { stripCanvas.width = p.w; stripCanvas.height = p.h; }
      stripCtx.putImageData(p.img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stripCanvas, p.x, p.y, p.w * p.cell, p.h * p.cell);
      // Gaps between LEDs, so each reads as its own square.
      const gap = p.cell >= 6 ? Math.max(1, Math.round(p.cell * 0.1)) : 0;
      if (gap) {
        ctx.fillStyle = '#000';
        for (let x = 0; x <= p.w; x++) ctx.fillRect(Math.round(p.x + x * p.cell - gap / 2), p.y, gap, p.h * p.cell);
        for (let y = 0; y <= p.h; y++) ctx.fillRect(p.x, Math.round(p.y + y * p.cell - gap / 2), p.w * p.cell, gap);
      }
    }
  }

  function renderOutput() {
    if (!ctx || !offCtx || !outputNodeId) return;
    const data = $nodeOutputs.get(outputNodeId);
    if (!data) return;

    if (fullscreen && placed.length) { renderShapes(toScreen(data)); return; }

    offscreen.width = data.width;
    offscreen.height = data.height;
    offCtx.putImageData(toScreen(data), 0, 0); // LED values → screen (display only)

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ctx.drawImage(offscreen, 0, 0, canvasElement.width, canvasElement.height);
  }

  function animate() {
    renderOutput();
    animationFrame = requestAnimationFrame(animate);
  }

  function setupCanvas() {
    if (fullscreen) {
      canvasElement.width = window.innerWidth;
      canvasElement.height = window.innerHeight;
      const dev = deviceRenderSize();
      if (dev) setRenderDimensions(dev.width, dev.height);
      // Otherwise match the screen dimensions for high-resolution rendering
      else setFullscreenDimensions(window.innerWidth, window.innerHeight);
      placeShapes();
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
    
    // Cleanup is returned from onMount: onDestroy can only be registered during component
    // init, so one called in here never ran and the listener outlived the page, throwing on
    // every resize once the canvas was gone.
    const resize = () => setupCanvas();
    if (fullscreen) window.addEventListener('resize', resize);

    animate();
    return () => window.removeEventListener('resize', resize);
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    // Reset render config when component is destroyed
    resetToDefaultDimensions();
  });

  // Watch for fullscreen prop changes and update canvas accordingly
  $: if (canvasElement) {
    shapes; insetTop; insetBottom;
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