<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  
  // Props
  export let value: number = 50;
  export let min: number = 0;
  export let max: number = 100;
  export let step: number = 1;
  export let size: number = 200;
  
  // Sensitivity options
  const angleSlideRatio: number = 2.0; // Degrees per pixel during slide
  const angleScrollRatio: number = 0.5; // Degrees per scroll pixel
  
  // State
  let isDragging: boolean = false;
  let svgElement: SVGSVGElement;
  let containerElement: HTMLDivElement;
  
  // Tracking state
  let isTracking: boolean = false;
  let isTurning: boolean = false;
  
  // Gesture detection
  let spinDetected: boolean = false;
  let slideXDetected: boolean = false;
  let slideYDetected: boolean = false;
  
  // Touch tracking
  let initialTouchLeft: number = 0;
  let initialTouchTop: number = 0;
  let lastTouchLeft: number = 0;
  let lastTouchTop: number = 0;
  let initialTouchLocationX: 'left' | 'right' = 'left';
  let initialTouchLocationY: 'top' | 'bottom' = 'top';
  
  // Center tracking
  let centerPageX: number = 0;
  let centerPageY: number = 0;
  
  // Spin tracking
  let initialAngleDiff: number = 0;
  let currentAngle: number = 0;
  
  // Gesture thresholds
  const MINIMUM_TRACKING_FOR_GESTURE = 10;
  const MINIMUM_TRACKING_FOR_SPIN = 20;
  
  const dispatch = createEventDispatcher<{
    start: void;
    change: number;
    end: void;
  }>();
  
  // Audio knob range: 7 o'clock to 5 o'clock (270° sweep going clockwise)
  // In SVG rotation: 0° = indicator pointing up, CW positive
  const ANGLE_MIN = -135; // 7 o'clock (min value)
  const ANGLE_MAX = 135;  // 5 o'clock (max value)  
  const ANGLE_RANGE = ANGLE_MAX - ANGLE_MIN; // 270°
  
  // Calculate SVG rotation angle from value
  function valueToAngle(val: number): number {
    const normalized = (val - min) / (max - min);
    return ANGLE_MIN + normalized * ANGLE_RANGE;
  }
  
  // Calculate value from SVG rotation angle
  function angleToValue(ang: number): number {
    const normalized = (ang - ANGLE_MIN) / ANGLE_RANGE;
    return min + normalized * (max - min);
  }
  
  // Calculate angle from screen coordinates to center (for spin gesture)
  // Returns angle where 0° = up, CW positive (matching SVG rotation)
  function angleFromCoord(x: number, y: number, cx: number, cy: number): number {
    const dx = x - cx;
    const dy = y - cy;
    // atan2 gives angle from positive X axis, CCW positive
    // We want angle from negative Y axis (up), CW positive
    let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
    return angle;
  }
  
  // Update center location
  function updateCenterLocation(): void {
    const rect = svgElement.getBoundingClientRect();
    centerPageX = rect.left + rect.width / 2;
    centerPageY = rect.top + rect.height / 2;
  }
  
  // Constrain value to bounds
  function constrain(val: number, minVal: number, maxVal: number): number {
    return Math.max(minVal, Math.min(maxVal, val));
  }
  
  // Apply value change with step quantization
  function applyValue(newValue: number): void {
    newValue = constrain(newValue, min, max);
    const steppedValue = Math.round(newValue / step) * step;
    
    if (Math.abs(steppedValue - value) >= step * 0.01) {
      value = steppedValue;
      dispatch('change', value);
    }
  }
  
  // Get angle from current gesture
  function getAngleFromGesture(touchLeft: number, touchTop: number): number {
    let ang = currentAngle;
    
    if (spinDetected) {
      // Calculate angle from touch position to center
      const touchAngle = angleFromCoord(touchLeft, touchTop, centerPageX, centerPageY);
      ang = touchAngle - initialAngleDiff;
    } else {
      if (slideXDetected) {
        const change = (touchLeft - lastTouchLeft) * angleSlideRatio;
        // At top: right = CW = increase angle; at bottom: right = CCW = decrease
        ang += (initialTouchLocationY === 'top') ? change : -change;
      }
      
      if (slideYDetected) {
        const change = (touchTop - lastTouchTop) * angleSlideRatio;
        // At right: down = CW = increase angle; at left: down = CCW = decrease  
        ang += (initialTouchLocationX === 'right') ? change : -change;
      }
    }
    
    return ang;
  }
  
  // Validate and apply angle
  function validateAndApplyAngle(newAngle: number): void {
    const constrainedAngle = constrain(newAngle, ANGLE_MIN, ANGLE_MAX);
    currentAngle = constrainedAngle;
    const newValue = angleToValue(constrainedAngle);
    applyValue(newValue);
  }
  
  // Handle pointer down
  function handlePointerDown(clientX: number, clientY: number): void {
    updateCenterLocation();
    
    isTracking = true;
    isTurning = false;
    spinDetected = false;
    slideXDetected = false;
    slideYDetected = false;
    
    initialTouchLeft = clientX;
    initialTouchTop = clientY;
    lastTouchLeft = clientX;
    lastTouchTop = clientY;
    
    // Determine which side of the knob we started on
    initialTouchLocationX = clientX >= centerPageX ? 'right' : 'left';
    initialTouchLocationY = clientY >= centerPageY ? 'bottom' : 'top';
    
    // Initialize current angle from current value
    currentAngle = valueToAngle(value);
    
    // Calculate initial angle difference for spin gesture
    const touchAngle = angleFromCoord(clientX, clientY, centerPageX, centerPageY);
    initialAngleDiff = touchAngle - currentAngle;
    
    isDragging = true;
    dispatch('start');
  }
  
  // Handle pointer move
  function handlePointerMove(clientX: number, clientY: number): void {
    if (!isTracking) return;
    
    const distanceX = Math.abs(clientX - initialTouchLeft);
    const distanceY = Math.abs(clientY - initialTouchTop);
    const distanceFromCenter = Math.sqrt(
      Math.pow(clientX - centerPageX, 2) + Math.pow(clientY - centerPageY, 2)
    );
    
    // Detect gesture type if not yet turning
    if (!isTurning) {
      // Check for spin gesture
      if (distanceFromCenter > MINIMUM_TRACKING_FOR_SPIN) {
        const movementAngle = Math.abs(
          angleFromCoord(clientX, clientY, centerPageX, centerPageY) -
          angleFromCoord(initialTouchLeft, initialTouchTop, centerPageX, centerPageY)
        );
        
        if (movementAngle > 5 && distanceFromCenter > size * 0.2) {
          spinDetected = true;
          isTurning = true;
        }
      }
      
      // Check for slide gestures if spin not detected
      if (!spinDetected) {
        if (distanceY > MINIMUM_TRACKING_FOR_GESTURE && distanceY > distanceX * 1.5) {
          slideYDetected = true;
          isTurning = true;
        } else if (distanceX > MINIMUM_TRACKING_FOR_GESTURE && distanceX > distanceY * 1.5) {
          slideXDetected = true;
          isTurning = true;
        }
      }
    }
    
    if (isTurning) {
      const newAngle = getAngleFromGesture(clientX, clientY);
      validateAndApplyAngle(newAngle);
    }
    
    lastTouchLeft = clientX;
    lastTouchTop = clientY;
  }
  
  // Handle pointer up
  function handlePointerUp(): void {
    isTracking = false;
    isTurning = false;
    isDragging = false;
    spinDetected = false;
    slideXDetected = false;
    slideYDetected = false;
    dispatch('end');
  }
  
  // Mouse event handlers
  function handleMouseDown(event: MouseEvent): void {
    handlePointerDown(event.clientX, event.clientY);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }
  
  function handleMouseMove(event: MouseEvent): void {
    handlePointerMove(event.clientX, event.clientY);
  }
  
  function handleMouseUp(): void {
    handlePointerUp();
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }
  
  // Touch event handlers
  function handleTouchStart(event: TouchEvent): void {
    event.preventDefault();
    const touch = event.touches[0];
    handlePointerDown(touch.clientX, touch.clientY);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
  }
  
  function handleTouchMove(event: TouchEvent): void {
    event.preventDefault();
    const touch = event.touches[0];
    handlePointerMove(touch.clientX, touch.clientY);
  }
  
  function handleTouchEnd(): void {
    handlePointerUp();
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
  }
  
  // Scroll/wheel event handler
  function handleWheel(event: WheelEvent): void {
    event.preventDefault();
    
    currentAngle = valueToAngle(value);
    const scrollDelta = event.deltaY * angleScrollRatio;
    // Scroll down = increase angle (CW), scroll up = decrease
    const newAngle = currentAngle + scrollDelta;
    validateAndApplyAngle(newAngle);
  }
  
  // Reactive values
  $: angle = valueToAngle(value);
  $: displayValue = value.toFixed(1);
  
  onMount(() => {
    function handleKeyDown(event: KeyboardEvent): void {
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div 
  bind:this={containerElement}
  class="rotary-knob-container"
  role="slider"
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  style="width: {size}px; height: {size}px;"
>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg 
  bind:this={svgElement}
  on:mousedown={handleMouseDown}
  on:touchstart={handleTouchStart}
  on:wheel={handleWheel}
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