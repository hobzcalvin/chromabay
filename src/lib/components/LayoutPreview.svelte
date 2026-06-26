<script lang="ts">
  // Visualize a WLED ledmap: a W×H grid, green = a real LED maps here, red = gap (-1).
  // Each LED cell is labelled with its index when it fits; otherwise hover shows it in a tooltip.
  let { width = 0, height = 0, map = [] }: { width?: number; height?: number; map?: number[] } = $props();
  let canvas: HTMLCanvasElement;
  let cell = $state(0);
  let tip = $state<{ x: number; y: number; text: string } | null>(null);

  $effect(() => {
    const W = width, H = height, m = map;
    if (!canvas || !W || !H) return;
    cell = Math.max(3, Math.min(28, Math.floor(280 / Math.max(W, H))));
    canvas.width = W * cell;
    canvas.height = H * cell;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < W * H; c++) {
      const led = m[c];
      const lit = Number.isFinite(led) && (led as number) >= 0;
      const x = (c % W) * cell, y = Math.floor(c / W) * cell;
      ctx.fillStyle = lit ? '#2ecc71' : '#c0392b';
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      // Label the LED index if there's room for the digits.
      if (lit) {
        const label = String(led);
        const fontPx = Math.floor(cell * 0.5);
        if (fontPx >= 7 && label.length * fontPx * 0.62 <= cell - 2) {
          ctx.fillStyle = '#0a2a14';
          ctx.font = `600 ${fontPx}px ui-monospace, monospace`;
          ctx.fillText(label, x + cell / 2, y + cell / 2 + 0.5);
        }
      }
    }
  });

  function onMove(e: MouseEvent) {
    if (!canvas || !cell) return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width; // canvas is CSS-scaled to fit
    const cx = Math.floor((e.clientX - rect.left) / scale / cell);
    const cy = Math.floor((e.clientY - rect.top) / scale / cell);
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) { tip = null; return; }
    const led = map[cy * width + cx];
    const isLed = Number.isFinite(led) && (led as number) >= 0;
    tip = { x: e.clientX - rect.left, y: e.clientY - rect.top, text: isLed ? `LED ${led}` : `gap (${cx},${cy})` };
  }
</script>

<div class="lp-wrap">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <canvas
    bind:this={canvas}
    class="layout-preview"
    onmousemove={onMove}
    onmouseleave={() => (tip = null)}
  ></canvas>
  {#if tip}
    <div class="lp-tip" style="left:{tip.x}px; top:{tip.y}px">{tip.text}</div>
  {/if}
</div>

<style>
  .lp-wrap { position: relative; display: inline-block; margin-top: 0.5rem; }
  .layout-preview {
    display: block;
    max-width: 100%;
    height: auto;
    image-rendering: pixelated;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .lp-tip {
    position: absolute;
    transform: translate(-50%, -130%);
    padding: 0.1rem 0.4rem;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 4px;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    z-index: 10;
  }
</style>
