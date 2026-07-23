<script lang="ts">
  // Lightweight: does NOT render the pattern itself. It registers interest in the pattern
  // (acquirePreview → a shared PatternRenderSource renders it once, see previewRender.ts) and
  // blits the latest shared frame to its own <canvas>. Many previews of the same pattern thus
  // cost one render + N cheap draws, and always show the same up-to-date frame.
  import { onMount, onDestroy } from 'svelte';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { acquirePreview, releasePreview, previewEntry } from '$lib/stores/previewRender';

  export let pattern: SerializedPattern;
  export let size = 60;

  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;
  let key: string | null = null;
  let loadedPattern: SerializedPattern | null = null;

  const offscreen = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const offCtx = offscreen ? offscreen.getContext('2d') : null;

  function draw() {
    const frame = key ? previewEntry(key)?.frame : null;
    if (frame && ctx && offCtx && offscreen) {
      offscreen.width = frame.width;
      offscreen.height = frame.height;
      offCtx.putImageData(frame, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
      ctx.drawImage(offscreen, 0, 0, canvasElement.width, canvasElement.height);
    }
    animationFrame = requestAnimationFrame(draw);
  }

  // (Re)acquire whenever the pattern prop changes (a reused list slot can point at a new one).
  $: if (pattern && pattern !== loadedPattern) {
    loadedPattern = pattern;
    if (key) releasePreview(key);
    key = acquirePreview(pattern);
  }

  onMount(() => {
    ctx = canvasElement.getContext('2d');
    canvasElement.width = size;
    canvasElement.height = size;
    draw();
  });

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (key) releasePreview(key);
  });
</script>

<div class="preview-container" style="width: {size}px; height: {size}px;">
  <canvas bind:this={canvasElement} class="preview-canvas"></canvas>
</div>

<style>
  .preview-container {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    background: #000;
  }
  .preview-canvas {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    image-rendering: pixelated;
  }
</style>
