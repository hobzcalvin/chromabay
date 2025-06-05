<script lang="ts">
  import { onMount } from 'svelte';
  import { PatternEngine } from '$lib/patterns';

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  const width = 64;
  const height = 32;
  const engine = new PatternEngine(width, height);

  const patterns = [
    { type: 'gradient', start: { r: 255, g: 0, b: 0 }, end: { r: 0, g: 0, b: 255 } },
    { type: 'sine', color: { r: 255, g: 255, b: 255 }, frequency: 2 },
    { type: 'invert' }
  ];

  onMount(() => {
    engine.load(patterns);
    ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    requestAnimationFrame(draw);
  });

  function draw(time: number) {
    const fb = engine.render(time / 1000);
    const imageData = fb.toImageData();
    ctx.putImageData(imageData, 0, 0);
    requestAnimationFrame(draw);
  }
</script>

<canvas bind:this={canvas} width={width} height={height} style="image-rendering: pixelated; border:1px solid #555"></canvas>

<style>
  canvas {
    width: 100%;
    height: auto;
  }
</style>
