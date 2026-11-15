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

  // Device layout: every strip of a device renders the same pattern over the same normalized
  // space (firmware renders each strip at its own size), so they share one "universe" grid — the
  // largest strip's width × the tallest's height. Each LED lands in the universe cell under its
  // own cell's centre; LEDs from several strips in one spot simply show that spot. Drawn as
  // square cells, centred, turned 90° when that makes it bigger on this screen.
  type Universe = { uw: number; uh: number; lit: Uint8Array; img: ImageData; rotated: boolean; cell: number; x: number; y: number };
  let universe: Universe | null = null;
  let stripCanvas = document.createElement('canvas');
  let stripCtx = stripCanvas.getContext('2d');

  function placeShapes() {
    universe = null;
    const dev = deviceRenderSize();
    if (!dev || !canvasElement) return;
    const { width: uw, height: uh } = dev;
    const lit = new Uint8Array(uw * uh);
    for (const s of shapes!) {
      const { width: w, height: h } = shapeSize(s);
      if (!w || !h) continue;
      const cells = litCells(s);
      for (let y = 0; y < h; y++) {
        const uy = Math.min(uh - 1, Math.floor(((y + 0.5) * uh) / h));
        for (let x = 0; x < w; x++) {
          if (cells[y * w + x]) lit[uy * uw + Math.min(uw - 1, Math.floor(((x + 0.5) * uw) / w))] = 1;
        }
      }
    }
    const margin = 16;
    const availW = Math.max(1, canvasElement.width - 2 * margin);
    const availH = Math.max(1, canvasElement.height - insetTop - insetBottom - 2 * margin);
    // Square cells as big as fit, never stretched; capped so a 1-LED device isn't a wall.
    const fit = (cols: number, rows: number) => Math.min(availW / cols, availH / rows, 160);
    const upright = fit(uw, uh), turned = fit(uh, uw);
    const rotated = turned > upright * 1.05; // only turn it when that's clearly bigger
    const cell = Math.max(0.5, rotated ? turned : upright);
    const cols = rotated ? uh : uw, rows = rotated ? uw : uh;
    universe = {
      uw, uh, lit, img: new ImageData(uw, uh), rotated, cell,
      x: (canvasElement.width - cols * cell) / 2,
      y: insetTop + margin + (availH - rows * cell) / 2,
    };
  }

  // The canvas the pattern renders at: the device's universe (largest strip width × tallest
  // height), so a single-strip device looks exactly the way the device renders it.
  function deviceRenderSize(): { width: number; height: number } | null {
    if (!shapes?.length) return null;
    const sizes = shapes.map(shapeSize).filter((z) => z.width > 0 && z.height > 0);
    if (!sizes.length) return null;
    return { width: Math.max(...sizes.map((z) => z.width)), height: Math.max(...sizes.map((z) => z.height)) };
  }

  function renderShapes(src: ImageData) {
    const u = universe;
    if (!ctx || !stripCtx || !u) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
    const sd = src.data, SW = src.width, SH = src.height, d = u.img.data;
    for (let y = 0; y < u.uh; y++) {
      const sy = Math.min(SH - 1, Math.floor(((y + 0.5) * SH) / u.uh));
      for (let x = 0; x < u.uw; x++) {
        const c = y * u.uw + x, o = c * 4;
        if (!u.lit[c]) { d[o + 3] = 0; continue; }
        const so = (sy * SW + Math.min(SW - 1, Math.floor(((x + 0.5) * SW) / u.uw))) * 4;
        d[o] = sd[so]; d[o + 1] = sd[so + 1]; d[o + 2] = sd[so + 2]; d[o + 3] = 255;
      }
    }
    if (stripCanvas.width !== u.uw || stripCanvas.height !== u.uh) { stripCanvas.width = u.uw; stripCanvas.height = u.uh; }
    stripCtx.putImageData(u.img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const cols = u.rotated ? u.uh : u.uw, rows = u.rotated ? u.uw : u.uh;
    if (u.rotated) {
      // 90° clockwise: the universe's top edge runs down the right side.
      ctx.save();
      ctx.translate(u.x + cols * u.cell, u.y);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(stripCanvas, 0, 0, u.uw * u.cell, u.uh * u.cell);
      ctx.restore();
    } else {
      ctx.drawImage(stripCanvas, u.x, u.y, cols * u.cell, rows * u.cell);
    }
    // Gaps between LEDs, so each reads as its own square.
    const gap = u.cell >= 6 ? Math.max(1, Math.round(u.cell * 0.1)) : 0;
    if (gap) {
      ctx.fillStyle = '#000';
      for (let x = 0; x <= cols; x++) ctx.fillRect(Math.round(u.x + x * u.cell - gap / 2), u.y, gap, rows * u.cell);
      for (let y = 0; y <= rows; y++) ctx.fillRect(u.x, Math.round(u.y + y * u.cell - gap / 2), cols * u.cell, gap);
    }
  }

  function renderOutput() {
    if (!ctx || !offCtx || !outputNodeId) return;
    const data = $nodeOutputs.get(outputNodeId);
    if (!data) return;

    if (fullscreen && universe) { renderShapes(toScreen(data)); return; }

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