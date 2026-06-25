<script lang="ts">
  // Visualize a WLED ledmap: a W×H grid, green = a real LED maps here, red = gap (-1).
  // Lets the user eyeball that a layout (hand-made or auto-mapped) looks right.
  let { width = 0, height = 0, map = [] }: { width?: number; height?: number; map?: number[] } = $props();
  let canvas: HTMLCanvasElement;

  $effect(() => {
    // touch reactive deps so the effect re-runs on change
    const W = width, H = height, m = map;
    if (!canvas || !W || !H) return;
    const cell = Math.max(3, Math.min(20, Math.floor(260 / Math.max(W, H))));
    canvas.width = W * cell;
    canvas.height = H * cell;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let c = 0; c < W * H; c++) {
      const led = m[c];
      const lit = Number.isFinite(led) && (led as number) >= 0;
      ctx.fillStyle = lit ? '#2ecc71' : '#c0392b';
      ctx.fillRect((c % W) * cell + 1, Math.floor(c / W) * cell + 1, cell - 2, cell - 2);
    }
  });
</script>

<canvas bind:this={canvas} class="layout-preview" title="green = LED, red = gap"></canvas>

<style>
  .layout-preview {
    display: block;
    max-width: 100%;
    height: auto;
    image-rendering: pixelated;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    margin-top: 0.5rem;
  }
</style>
