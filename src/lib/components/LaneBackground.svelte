<script lang="ts">
  import { LANES } from '$lib/flowStore';

  // `viewport` is the object returned by useViewport(): viewport.current = {x, y, zoom}.
  // Passed in as a prop so this works regardless of slot/context wiring.
  let { viewport }: { viewport: { current: { x: number; y: number; zoom: number } } } = $props();

  // Each output buffer has a fixed lane; tint it so it's obvious where nodes belong.
  // Buffer 0 = red, 1 = green, 2 = blue (lane order LEFT / CENTER / RIGHT).
  // A node's position.x is its LEFT edge and the lane X is where that edge snaps, so a
  // node centers at laneX + NODE_W/2 — center the band there, not on laneX itself.
  const NODE_W = 100;
  const BAND_W = 132; // flow units; lanes are 150 apart, so this leaves a small gutter
  const lanes = [
    { x: LANES.LEFT,   tint: '239, 68, 68'  }, // buffer 0
    { x: LANES.CENTER, tint: '34, 197, 94'  }, // buffer 1
    { x: LANES.RIGHT,  tint: '59, 130, 246' }, // buffer 2
  ];

  const vp = $derived(viewport.current);
</script>

<div class="lanes" aria-hidden="true">
  {#each lanes as lane (lane.x)}
    <div
      class="lane"
      style:left="{vp.x + (lane.x + NODE_W / 2 - BAND_W / 2) * vp.zoom}px"
      style:width="{BAND_W * vp.zoom}px"
      style:background="rgba({lane.tint}, 0.09)"
      style:border-color="rgba({lane.tint}, 0.35)"
    ></div>
  {/each}
</div>

<style>
  .lanes {
    position: absolute;
    inset: 0;
    /* Above .svelte-flow__background (z -1), below the pane (1) and nodes (2). */
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .lane {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid;
    border-right: 1px solid;
  }
</style>
