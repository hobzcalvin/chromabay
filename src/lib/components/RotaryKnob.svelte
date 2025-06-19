<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  
  interface Point {
    x: number;
    y: number;
  }
  
  // Props
  export let value: number = 50;
  export let min: number = 0;
  export let max: number = 100;
  export let step: number = 1;
  export let unlockDistance: number = 50;
  export let preciseMode: boolean = true;
  export let size: number = 200;
  
  // State
  let isDragging: boolean = false;
  let dragDistance: number = 0;
  let startMousePos: Point = { x: 0, y: 0 };
  let startValue: number = 0;
  let centerPoint: Point = { x: 0, y: 0 };
  let svgElement: SVGSVGElement;
  let containerElement: HTMLDivElement;
  
  const dispatch = createEventDispatcher();
  
  // Sensitivity settings
  const VERTICAL_SENSITIVITY = 0.2; // Main control: more change per pixel (less pixels needed)
  const HORIZONTAL_SENSITIVITY = 1; // Fine control: same as old vertical sensitivity
  
  // Audio knob range: 7 o'clock (210°) to 5 o'clock (150°)
  const MIN_ANGLE = 210; // 7 o'clock position (min value)
  const MAX_ANGLE = 150; // 5 o'clock position (max value)
  const ANGLE_RANGE = 300; // 300 degrees counterclockwise (210° to 150° the long way)
  
  // Calculate angle from value (210° to 150° counterclockwise for audio knob)
  function valueToAngle(val: number): number {
    const normalized = (val - min) / (max - min);
    // Go counterclockwise from 210° for 300°
    let angle = MIN_ANGLE + normalized * ANGLE_RANGE;
    // Handle wrap-around
    if (angle >= 360) angle -= 360;
    return angle;
  }
  
  // Calculate value from angle, returns null if outside valid range
  function angleToValue(angle: number): number | null {
    // Normalize angle to 0-360 range
    angle = ((angle % 360) + 360) % 360;
    
    // Add tolerance for easier min/max value access
    const tolerance = 10;
    
    // Calculate distance from MIN_ANGLE (210°) going counterclockwise
    let angleDistance;
    
    if (angle >= MIN_ANGLE) {
      // From 210° to 360°
      angleDistance = angle - MIN_ANGLE;
    } else {
      // From 0° to angle (continuing counterclockwise from 360°)
      angleDistance = (360 - MIN_ANGLE) + angle;
    }
    
    // Special case: check if we're close to min value from the "backward" direction
    // (e.g., angles like 200°, 190° should give us min value)
    if (angle < MIN_ANGLE && angle > MIN_ANGLE - tolerance) {
      return min;
    }
    
    // Check if we're within the valid range (with tolerance at the end)
    if (angleDistance <= ANGLE_RANGE + tolerance) {
      // Clamp angleDistance to the actual range to prevent going beyond min/max
      const clampedDistance = Math.min(angleDistance, ANGLE_RANGE);
      const progress = clampedDistance / ANGLE_RANGE;
      return min + progress * (max - min);
    } else {
      // Outside valid range, return null to indicate invalid position
      return null;
    }
  }
  
  // Get mouse position relative to center
  function getMouseAngle(event: MouseEvent): number {
    const rect = svgElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const deltaX = event.clientX - centerX;
    const deltaY = event.clientY - centerY;
    
    // Calculate angle in degrees (0-360)
    let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
    // Convert to 0-360 range and offset by 90 degrees to start at top
    angle = (angle + 90 + 360) % 360;
    
    return angle;
  }
  
  // Get touch position relative to center (same logic as mouse)
  function getTouchAngle(event: TouchEvent): number {
    const rect = svgElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const touch = event.touches[0] || event.changedTouches[0];
    const deltaX = touch.clientX - centerX;
    const deltaY = touch.clientY - centerY;
    
    // Calculate angle in degrees (0-360)
    let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
    // Convert to 0-360 range and offset by 90 degrees to start at top
    angle = (angle + 90 + 360) % 360;
    
    return angle;
  }
  
  // Calculate angular difference, handling wrap-around
  function getAngleDifference(startAngle: number, currentAngle: number): number {
    let diff = currentAngle - startAngle;
    
    // Handle wrap-around for smoother rotation
    if (diff > 180) {
      diff -= 360;
    } else if (diff < -180) {
      diff += 360;
    }
    
    return diff;
  }
  
  // Handle mouse down
  function handleMouseDown(event: MouseEvent) {
    isDragging = true;
    startMousePos = { x: event.clientX, y: event.clientY };
    startValue = value;
    
    dispatch('start');
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }
  
  // Handle touch start
  function handleTouchStart(event: TouchEvent) {
    event.preventDefault(); // Prevent scrolling and other touch behaviors
    
    isDragging = true;
    const touch = event.touches[0];
    startMousePos = { x: touch.clientX, y: touch.clientY };
    startValue = value;
    
    dispatch('start');
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
  }
  
  // Handle mouse move
  function handleMouseMove(event: MouseEvent) {
    if (isDragging) {
      const deltaY = startMousePos.y - event.clientY; // Inverted: up is positive
      const deltaX = event.clientX - startMousePos.x; // Right is positive
      
      // Calculate value change based on vertical movement
      const verticalChange = (deltaY / VERTICAL_SENSITIVITY) * (step || 1);
      
      // Calculate precision adjustment based on horizontal movement
      const horizontalChange = (deltaX / HORIZONTAL_SENSITIVITY) * (step || 1);
      
      // Combine both movements
      const totalChange = verticalChange + horizontalChange;
      let newValue = startValue + totalChange;
      
      // Clamp to min/max bounds
      newValue = Math.max(min, Math.min(max, newValue));
      
      // Apply step
      const steppedValue = Math.round(newValue / step) * step;
      
      if (Math.abs(steppedValue - value) >= step * 0.01) { // Small threshold to prevent micro-updates
        value = steppedValue;
        dispatch('change', value);
      }
    }
  }
  
  // Handle touch move
  function handleTouchMove(event: TouchEvent) {
    event.preventDefault(); // Prevent scrolling
    
    if (isDragging) {
      const touch = event.touches[0];
      const deltaY = startMousePos.y - touch.clientY; // Inverted: up is positive
      const deltaX = touch.clientX - startMousePos.x; // Right is positive
      
      // Calculate value change based on vertical movement
      const verticalChange = (deltaY / VERTICAL_SENSITIVITY) * (step || 1);
      
      // Calculate precision adjustment based on horizontal movement
      const horizontalChange = (deltaX / HORIZONTAL_SENSITIVITY) * (step || 1);
      
      // Combine both movements
      const totalChange = verticalChange + horizontalChange;
      let newValue = startValue + totalChange;
      
      // Clamp to min/max bounds
      newValue = Math.max(min, Math.min(max, newValue));
      
      // Apply step
      const steppedValue = Math.round(newValue / step) * step;
      
      if (Math.abs(steppedValue - value) >= step * 0.01) { // Small threshold to prevent micro-updates
        value = steppedValue;
        dispatch('change', value);
      }
    }
  }
  
  // Handle mouse up
  function handleMouseUp() {
    isDragging = false;
    dragDistance = 0;
    dispatch('end');
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }
  
  // Handle touch end
  function handleTouchEnd() {
    isDragging = false;
    dragDistance = 0;
    dispatch('end');
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
  }
  
  // Reactive values
  $: angle = valueToAngle(value);
  $: displayValue = value.toFixed(1);
  
  // Remove pie slice - s10 doesn't have it
  
  onMount(() => {
    // Handle keyboard events
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault();
        value = Math.min(max, value + step);
        dispatch('change', value);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault();
        value = Math.max(min, value - step);
        dispatch('change', value);
      }
    }
    
    containerElement.addEventListener('keydown', handleKeyDown);
    
    return () => {
      containerElement.removeEventListener('keydown', handleKeyDown);
    };
  });
</script>

<div 
  bind:this={containerElement}
  class="rotary-knob-container"
  tabindex="0"
  style="width: {size}px; height: {size}px;"
>
<svg 
  bind:this={svgElement}
  on:mousedown={handleMouseDown}
  on:touchstart={handleTouchStart}
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
                      <text id="534f4e02-5541-3607-0966-af0b025d80e0" font-family="Helvetica" font-size="44" font-weight="normal" fill="#E6D7D7" class="text-7 value-text" filter="url(#12f618f7-e258-b597-3ed6-242484ddad8f)">
          <tspan x="45.3246625" y="117.884225">{displayValue}</tspan>
      </text>
                      <text id="92ebe866-c281-70c7-7b0e-a373cee013a9" font-family="Helvetica" font-size="44" font-weight="normal" fill="#E6D7D7" class="text-7 value-text">
          <tspan x="45.3246625" y="117.884225">{displayValue}</tspan>
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