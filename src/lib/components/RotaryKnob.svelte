<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  // Vendored gesture engine (jherrm/knobs). It owns ALL the interaction behavior
  // — circular spin (with distance-based precision), vertical/horizontal slide,
  // and scroll — exactly like the reference. We keep our own SVG visuals and just
  // consume the value it publishes.
  import { Knob } from '$lib/vendor/knob.js';

  // Props
  export let value: number = 50;
  export let min: number = 0;
  export let max: number = 100;
  export let step: number = 1;
  export let size: number = 200;
  // When set, the knob is an ENUM selector: `value` is the option index, and the option's
  // text is shown in the face (shrunk to fit) instead of a number.
  export let labels: string[] = [];

  const dispatch = createEventDispatcher<{
    start: void;
    change: number;
    end: void;
  }>();

  let containerElement: HTMLDivElement;
  let knob: Knob | null = null;
  let isDragging = false;
  let isInteracting = false;

  // Visual mapping (unchanged): the SVG knob rotates from -135° (min) to +135°
  // (max) — a 270° audio-style sweep. We drive the rotation purely from `value`,
  // so Knob.js's internal angle convention never has to match ours.
  const ANGLE_MIN = -135;
  const ANGLE_MAX = 135;
  const ANGLE_RANGE = ANGLE_MAX - ANGLE_MIN; // 270°

  function valueToAngle(val: number): number {
    const t = max - min === 0 ? 0 : (val - min) / (max - min);
    return ANGLE_MIN + t * ANGLE_RANGE;
  }

  function quantize(v: number): number {
    const stepped = step > 0 ? Math.round(v / step) * step : v;
    return Math.max(min, Math.min(max, stepped));
  }

  // Knob.js publishes on every change (gesture or programmatic). It owns the
  // behavior; we just take the value (quantized to our step) and re-render.
  function onKnobUpdate(instance: Knob): void {
    const next = quantize(instance.val());
    if (next !== value) {
      value = next;
      dispatch('change', value);
    }
  }

  // Feed the knob its on-screen geometry so the spin gesture pivots on the
  // visual center (it derives the center from position + size).
  function syncGeometry(): void {
    if (!knob || !containerElement) return;
    const rect = containerElement.getBoundingClientRect();
    knob.setDimensions(rect.width, rect.height);
    knob.setPosition(rect.left + window.scrollX, rect.top + window.scrollY);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!knob) return;
    isInteracting = true;
    isDragging = true;
    syncGeometry();
    containerElement.setPointerCapture(e.pointerId);
    knob.doTouchStart([{ pageX: e.pageX, pageY: e.pageY }], e.timeStamp);
    dispatch('start');
  }

  function onPointerMove(e: PointerEvent): void {
    if (!knob || !isInteracting) return;
    knob.doTouchMove([{ pageX: e.pageX, pageY: e.pageY }], e.timeStamp);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!knob || !isInteracting) return;
    knob.doTouchEnd(e.timeStamp);
    isInteracting = false;
    isDragging = false;
    try { containerElement.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    dispatch('end');
  }

  function onWheel(e: WheelEvent): void {
    if (!knob) return;
    e.preventDefault();
    syncGeometry();
    knob.doMouseScroll(-e.deltaY, e.timeStamp, e.pageX, e.pageY);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      value = quantize(value + step);
      knob?.val(value);
      dispatch('change', value);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      value = quantize(value - step);
      knob?.val(value);
      dispatch('change', value);
    }
  }

  // Reflect external value changes (e.g. a store update) into the knob — but not
  // mid-gesture, when the user is the source of truth.
  $: if (knob && !isInteracting && quantize(knob.val()) !== quantize(value)) {
    knob.val(value);
  }

  onMount(() => {
    // Knob.js reads min/max/value + the data-gesture-* options off the element.
    containerElement.setAttribute('min', String(min));
    containerElement.setAttribute('max', String(max));
    containerElement.setAttribute('value', String(value));
    knob = new Knob(containerElement, onKnobUpdate);
    syncGeometry();
    window.addEventListener('resize', syncGeometry);
  });

  onDestroy(() => {
    window.removeEventListener('resize', syncGeometry);
  });

  // Reactive values driving the SVG
  $: angle = valueToAngle(value);
  $: isEnum = labels.length > 0;
  $: displayValue = isEnum
    ? (labels[Math.max(0, Math.min(labels.length - 1, Math.round(value)))] ?? '')
    : value.toFixed(1);
  // Shrink the enum label so it fits the knob face (viewBox units); longer labels → smaller.
  $: valueFontSize = isEnum ? Math.max(18, Math.min(44, 300 / Math.max(String(displayValue).length, 3))) : 44;
  $: valueAnchor = isEnum ? 'middle' : 'start';
  $: valueX = isEnum ? 103.5 : 45.3246625;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- Knob.js reads min/max/value + the data-gesture-* options off this element. -->
<div
  bind:this={containerElement}
  class="rotary-knob-container {isDragging ? 'dragging' : ''}"
  role="slider"
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  data-angle-start="-135"
  data-angle-end="135"
  data-gesture-spin-enabled="true"
  data-gesture-slidex-enabled="true"
  data-gesture-slidey-enabled="true"
  data-gesture-scroll-enabled="true"
  style="width: {size}px; height: {size}px; touch-action: none;"
  on:pointerdown={onPointerDown}
  on:pointermove={onPointerMove}
  on:pointerup={onPointerUp}
  on:pointercancel={onPointerUp}
  on:wheel={onWheel}
  on:keydown={onKeyDown}
>
<svg
  class="rotary-knob {isDragging ? 'dragging' : ''}"
  xmlns="http://www.w3.org/2000/svg" 
  xmlns:xlink="http://www.w3.org/1999/xlink" 
  width="207px" 
  height="207px" 
  viewBox="0 0 207 207" 
  version="1.1"
>
  <!-- Generator: Sketch 47.1 (45422) - http://www.bohemiancoding.com/sketch -->
  <desc>Created with Sketch.</desc>
  <defs>
        <linearGradient x1="50%" y1="50%" x2="50%" y2="100%" id="49d33e31-bf4d-a753-1175-c0858608ad59-13">
            <stop stop-color="#444040" stop-opacity="0.51098279" offset="0%"></stop>
            <stop stop-color="#131111" stop-opacity="0.893200861" offset="100%"></stop>
        </linearGradient>
        <circle id="b0e61d25-9751-2709-77c2-43a0d2765ac0" cx="98.0392157" cy="98.0392157" r="98.0392157"></circle>
        <filter x="-3.3%" y="-3.3%" width="106.6%" height="106.6%" filterUnits="objectBoundingBox" id="c8076758-005f-b1c9-8186-859994ef4604-13">
            <feMorphology radius="0.5" operator="dilate" in="SourceAlpha" result="shadowSpreadOuter1"></feMorphology>
            <feOffset dx="0" dy="0" in="shadowSpreadOuter1" result="shadowOffsetOuter1"></feOffset>
            <feGaussianBlur stdDeviation="2" in="shadowOffsetOuter1" result="shadowBlurOuter1"></feGaussianBlur>
            <feComposite in="shadowBlurOuter1" in2="SourceAlpha" operator="out" result="shadowBlurOuter1"></feComposite>
            <feColorMatrix values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0.5 0" type="matrix" in="shadowBlurOuter1"></feColorMatrix>
        </filter>
        <linearGradient x1="50%" y1="0%" x2="50%" y2="100%" id="9d79eb1c-be7e-e08b-0a27-94fe49e73955-13">
            <stop stop-color="#FFFFFF" stop-opacity="0.5" offset="0%"></stop>
            <stop stop-color="#000000" stop-opacity="0.5" offset="100%"></stop>
        </linearGradient>
        <circle id="47a738eb-6ad0-d5fd-c2aa-aec25060f3c8" cx="98" cy="98" r="86"></circle>
        <filter x="-4.1%" y="-3.5%" width="108.1%" height="108.1%" filterUnits="objectBoundingBox" id="31a63d60-9dcb-f39f-f64a-841ad0f35b2a-13">
            <feMorphology radius="0.5" operator="dilate" in="SourceAlpha" result="shadowSpreadOuter1"></feMorphology>
            <feOffset dx="0" dy="1" in="shadowSpreadOuter1" result="shadowOffsetOuter1"></feOffset>
            <feGaussianBlur stdDeviation="2" in="shadowOffsetOuter1" result="shadowBlurOuter1"></feGaussianBlur>
            <feComposite in="shadowBlurOuter1" in2="SourceAlpha" operator="out" result="shadowBlurOuter1"></feComposite>
            <feColorMatrix values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0.5 0" type="matrix" in="shadowBlurOuter1"></feColorMatrix>
        </filter>
        <circle id="b0c4faeb-4cbc-946b-d29b-9175d733b39b" cx="71.0784314" cy="71.0784314" r="71.0784314"></circle>
                 <filter x="-8.8%" y="-8.8%" width="117.6%" height="117.6%" filterUnits="objectBoundingBox" id="974cc517-2740-3d43-3f9c-1d54da4dc4b9-13">
             <feGaussianBlur stdDeviation="10" in="SourceAlpha" result="shadowBlurInner1"></feGaussianBlur>
             <feOffset dx="0" dy="0" in="shadowBlurInner1" result="shadowOffsetInner1"></feOffset>
             <feComposite in="shadowOffsetInner1" in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="shadowInnerInner1"></feComposite>
             <feColorMatrix values="0 0 0 0 0.9019607843 0 0 0 0 0.8431372549 0 0 0 0 0.8431372549 0 0 0 1 0" type="matrix" in="shadowInnerInner1"></feColorMatrix>
         </filter>
        <path d="M71.5,6.35149137 L88,67.4498536 C83.2378045,69.1012512 77.7378045,69.946758 71.5,69.986374 C65.2621955,70.02599 59.7621955,69.1804832 55,67.4498536 L71.5,6.35149137 Z" id="017c3ebb-7dbc-8e3a-f3b1-e494f4fa7ff8"></path>
                 <filter x="-71.2%" y="-33.8%" width="242.4%" height="173.9%" filterUnits="objectBoundingBox" id="1dac708c-6252-fad4-d1b2-7c24c1b02857-13">
             <feOffset dx="0" dy="2" in="SourceAlpha" result="shadowOffsetOuter1"></feOffset>
             <feGaussianBlur stdDeviation="7.5" in="shadowOffsetOuter1" result="shadowBlurOuter1"></feGaussianBlur>
             <feColorMatrix values="0 0 0 0 0.9019607843 0 0 0 0 0.8431372549 0 0 0 0 0.8431372549 0 0 0 1 0" type="matrix" in="shadowBlurOuter1"></feColorMatrix>
         </filter>
        <filter x="-5.3%" y="-11.3%" width="110.7%" height="122.6%" filterUnits="objectBoundingBox" id="12f618f7-e258-b597-3ed6-242484ddad8f">
          <feOffset dx="0" dy="0" in="SourceAlpha" result="shadowOffsetOuter1"/>
          <feGaussianBlur stdDeviation="2" in="shadowOffsetOuter1" result="shadowBlurOuter1"/>
          <feColorMatrix values="0 0 0 0 0.915577168   0 0 0 0 0.797591325   0 0 0 0 0.601479722  0 0 0 1 0" type="matrix" in="shadowBlurOuter1"/>
        </filter>
        <pattern id="3cc0e5b8-1f0a-886b-f635-8fcb19212870" width="8.04411765" height="8.04411765" x="21.9558824" y="21.9558824" patternUnits="userSpaceOnUse">
          <use xlink:href="#2b8719c1-286b-ebf8-a488-ac66a6598fc5" transform="scale(0.167585784,0.167585784)"/>
        </pattern>
        <image id="2b8719c1-286b-ebf8-a488-ac66a6598fc5" width="48" height="48" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAEGWlDQ1BrQ0dDb2xvclNwYWNlR2VuZXJpY1JHQgAAOI2NVV1oHFUUPrtzZyMkzlNsNIV0qD8NJQ2TVjShtLp/3d02bpZJNtoi6GT27s6Yyc44M7v9oU9FUHwx6psUxL+3gCAo9Q/bPrQvlQol2tQgKD60+INQ6Ium65k7M5lpurHeZe58853vnnvuuWfvBei5qliWkRQBFpquLRcy4nOHj4g9K5CEh6AXBqFXUR0rXalMAjZPC3e1W99Dwntf2dXd/p+tt0YdFSBxH2Kz5qgLiI8B8KdVy3YBevqRHz/qWh72Yui3MUDEL3q44WPXw3M+fo1pZuQs4tOIBVVTaoiXEI/MxfhGDPsxsNZfoE1q66ro5aJim3XdoLFw72H+n23BaIXzbcOnz5mfPoTvYVz7KzUl5+FRxEuqkp9G/Ajia219thzg25abkRE/BpDc3pqvphHvRFys2weqvp+krbWKIX7nhDbzLOItiM8358pTwdirqpPFnMF2xLc1WvLyOwTAibpbmvHHcvttU57y5+XqNZrLe3lE/Pq8eUj2fXKfOe3pfOjzhJYtB/yll5SDFcSDiH+hRkH25+L+sdxKEAMZahrlSX8ukqMOWy/jXW2m6M9LDBc31B9LFuv6gVKg/0Szi3KAr1kGq1GMjU/aLbnq6/lRxc4XfJ98hTargX++DbMJBSiYMIe9Ck1YAxFkKEAG3xbYaKmDDgYyFK0UGYpfoWYXG+fAPPI6tJnNwb7ClP7IyF+D+bjOtCpkhz6CFrIa/I6sFtNl8auFXGMTP34sNwI/JhkgEtmDz14ySfaRcTIBInmKPE32kxyyE2Tv+thKbEVePDfW/byMM1Kmm0XdObS7oGD/MypMXFPXrCwOtoYjyyn7BV29/MZfsVzpLDdRtuIZnbpXzvlf+ev8MvYr/Gqk4H/kV/G3csdazLuyTMPsbFhzd1UabQbjFvDRmcWJxR3zcfHkVw9GfpbJmeev9F08WW8uDkaslwX6avlWGU6NRKz0g/SHtCy9J30o/ca9zX3Kfc19zn3BXQKRO8ud477hLnAfc1/G9mrzGlrfexZ5GLdn6ZZrrEohI2wVHhZywjbhUWEy8icMCGNCUdiBlq3r+xafL549HQ5jH+an+1y+LlYBifuxAvRN/lVVVOlwlCkdVm9NOL5BE4wkQ2SMlDZU97hX86EilU/lUmkQUztTE6mx1EEPh7OmdqBtAvv8HdWpbrJS6tJj3n0CWdM6busNzRV3S9KTYhqvNiqWmuroiKgYhshMjmhTh9ptWhsF7970j/SbMrsPE1suR5z7DMC+P/Hs+y7ijrQAlhyAgccjbhjPygfeBTjzhNqy28EdkUh8C+DU9+z2v/oyeH791OncxHOs5y2AtTc7nb/f73TWPkD/qwBnjX8BoJ98VQNcC+8AAAFFSURBVGgF7djbDYMwDAXQBjEMYqyqY1WMxTppLiJIQIA8ariWkp8IPuweO60am67r7MstY8wwjuPH7dMz3uUua63p+/7r9rePIRW/9QmQzCV9ub0YgSIgzhxvQkjFb1EZBAdEKolkfJTqtnb7bv/zOJm58moRE0AzYgFoRawAGhE7gDZEEKAJcQjQgjgFaEBcAtgRUQBmRDSAFZEEYEQkA9gQWQAmRDaABVEEYEAUAx5H4EaGOyw+SMl66mbXzNOD4k6gCPNUY/CFwF1YOn5zRxJJRINqaUbUuZA/79sd3wm3xIdbdS60rXzo2XVCbO60/HxKJgFKKv4CkEziuyKBWAE0InYAbYggQBPiEKAFcQrQgLgEsCOiAMyIaAArIgnAiEgGsCGyAEyIbAALogjAgCgGPI7AX9w6F3JtqHMhnMWLFSrSD9jOnakVHpZYAAAAAElFTkSuQmCC"/>
  </defs>
  <g id="Page-1" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
      <g id="s10" transform="translate(3.000000, 3.000000)">
          <g id="container">
              <g id="Oval-2">
                  <use fill="black" fill-opacity="1" filter="url(#c8076758-005f-b1c9-8186-859994ef4604-13)" xlink:href="#b0e61d25-9751-2709-77c2-43a0d2765ac0"/>
                  <use stroke="#979797" stroke-width="1" fill="url(#49d33e31-bf4d-a753-1175-c0858608ad59-13)" fill-rule="evenodd" xlink:href="#b0e61d25-9751-2709-77c2-43a0d2765ac0"/>
              </g>
              <g id="Oval-2">
                  <use fill="black" fill-opacity="1" filter="url(#31a63d60-9dcb-f39f-f64a-841ad0f35b2a-13)" xlink:href="#47a738eb-6ad0-d5fd-c2aa-aec25060f3c8"/>
                  <use fill="" fill-rule="evenodd" xlink:href="#47a738eb-6ad0-d5fd-c2aa-aec25060f3c8"/>
                  <use stroke="#4A4A4A" stroke-width="1" fill="url(#9d79eb1c-be7e-e08b-0a27-94fe49e73955-13)" fill-rule="evenodd" xlink:href="#47a738eb-6ad0-d5fd-c2aa-aec25060f3c8"/>
              </g>
              <g id="knob" transform="translate(28.574244, 28.574244) rotate({angle} 71.4356094 71.4356094)">
                  <circle id="Oval-5" fill="#322E2E" cx="71.4356094" cy="71.4356094" r="71.4356094"/>
                  <g id="Rectangle-Copy-2" transform="translate(71.500000, 38.169598) scale(1, -1) translate(-71.500000, -38.169598) ">
                        <use fill="black" fill-opacity="1" filter="url(#1dac708c-6252-fad4-d1b2-7c24c1b02857-13)" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#017c3ebb-7dbc-8e3a-f3b1-e494f4fa7ff8"></use>
                        <use fill="#E6D7D7" fill-rule="evenodd" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#017c3ebb-7dbc-8e3a-f3b1-e494f4fa7ff8"></use>
                    </g>
              </g>
              <g id="label">
                  <g id="labeltext" fill-opacity="1" fill="#E6D7D7">
                      <text id="534f4e02-5541-3607-0966-af0b025d80e0" font-family="Helvetica" font-size={valueFontSize} font-weight="normal" text-anchor={valueAnchor} fill="#E6D7D7" class="text-7 value-text" filter="url(#12f618f7-e258-b597-3ed6-242484ddad8f)">
          <tspan x={valueX} y="117.884225" textLength={isEnum ? 170 : undefined} lengthAdjust="spacingAndGlyphs">{displayValue}</tspan>
      </text>
                      <text id="92ebe866-c281-70c7-7b0e-a373cee013a9" font-family="Helvetica" font-size={valueFontSize} font-weight="normal" text-anchor={valueAnchor} fill="#E6D7D7" class="text-7 value-text">
          <tspan x={valueX} y="117.884225" textLength={isEnum ? 170 : undefined} lengthAdjust="spacingAndGlyphs">{displayValue}</tspan>
      </text>
                  </g>
                  <circle id="Oval-6" stroke="#979797" fill-opacity="0.730000019" fill="url(#3cc0e5b8-1f0a-886b-f635-8fcb19212870)" transform="translate(100.351759, 100.351759) rotate(-45.000000) translate(-100.351759, -100.351759) " cx="100.351759" cy="100.351759" r="70.3517588"/>
              </g>
          </g>
      </g>
  </g>
</svg>
</div>

<style>
  .rotary-knob-container {
    position: relative;
    outline: none;
    user-select: none;
  }
  
  .rotary-knob {
    /* Scale the fixed 207px viewBox down to the container's actual `size`, so the
       visual center matches the gesture center (which the engine derives from the
       container's bounding box). A mismatch makes the value jump the instant you
       start dragging, since spin angle is atan2 around that center. */
    display: block;
    width: 100%;
    height: 100%;
    cursor: pointer;
    transition: transform 0.1s ease;
  }
  
  .rotary-knob.dragging {
    cursor: grabbing;
  }
  
  .rotary-knob:hover {
    transform: scale(1.02);
  }
  
  .value-text {
    pointer-events: none;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  }
</style> 