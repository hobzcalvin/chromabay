<script lang="ts">
  // HSV hue/saturation wheel: angle = hue, radius = saturation (centre = white/desaturated,
  // edge = full saturation). Value/brightness isn't a dimension here — LED colour params are
  // hue+sat only. Emits hue & sat on the operator's 0–255 scale. Used both as the editor's
  // combined colour control and as the Interact-page control for a colour param.
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export let hue = 0;         // 0–255
  export let sat = 255;       // 0–255
  export let size = 160;
  export let disabled = false; // e.g. while hue is being automated

  const dispatch = createEventDispatcher<{ change: { hue: number; sat: number }; start: void; end: void }>();

  let el: HTMLDivElement;
  let dragging = false;

  // angle measured clockwise from 12 o'clock (matches the conic-gradient below)
  $: theta = (hue / 255) * 2 * Math.PI;
  $: radiusFrac = Math.max(0, Math.min(1, sat / 255));
  $: thumbX = 50 + Math.sin(theta) * radiusFrac * 50; // % within the wheel box
  $: thumbY = 50 - Math.cos(theta) * radiusFrac * 50;

  function pick(clientX: number, clientY: number) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = clientX - cx, dy = clientY - cy;
    const R = r.width / 2;
    let ang = Math.atan2(dx, -dy);                 // 0 at top, clockwise
    if (ang < 0) ang += 2 * Math.PI;
    const h = Math.round((ang / (2 * Math.PI)) * 255) % 256;
    const s = Math.round(Math.min(1, Math.hypot(dx, dy) / R) * 255);
    dispatch('change', { hue: h, sat: s });
  }

  function onDown(e: PointerEvent) {
    if (disabled) return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    dispatch('start');
    pick(e.clientX, e.clientY);
  }
  function onMove(e: PointerEvent) { if (dragging && !disabled) pick(e.clientX, e.clientY); }
  function onUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    dispatch('end');
  }
</script>

<div
  bind:this={el}
  class="wheel {disabled ? 'disabled' : ''}"
  style="width:{size}px; height:{size}px;"
  on:pointerdown={onDown}
  on:pointermove={onMove}
  on:pointerup={onUp}
  on:pointercancel={onUp}
  role="slider"
  aria-label="Colour (hue and saturation)"
  aria-valuenow={hue}
  aria-valuemin={0}
  aria-valuemax={255}
  tabindex="0"
>
  <div class="thumb" style="left:{thumbX}%; top:{thumbY}%; background: hsl({(hue / 255) * 360}, {(sat / 255) * 100}%, 50%);"></div>
</div>

<style>
  .wheel {
    position: relative;
    border-radius: 50%;
    touch-action: none;
    cursor: crosshair;
    /* Hue around (conic) with a white core for saturation (radial). */
    background:
      radial-gradient(circle at 50% 50%, #fff 0%, rgba(255, 255, 255, 0) 72%),
      conic-gradient(from 0deg,
        hsl(0,100%,50%), hsl(45,100%,50%), hsl(90,100%,50%), hsl(135,100%,50%),
        hsl(180,100%,50%), hsl(225,100%,50%), hsl(270,100%,50%), hsl(315,100%,50%), hsl(360,100%,50%));
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25), 0 1px 4px rgba(0,0,0,0.4);
  }
  .wheel.disabled { opacity: 0.5; cursor: default; }
  .thumb {
    position: absolute;
    width: 16px; height: 16px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.6);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
</style>
