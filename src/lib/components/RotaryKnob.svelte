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
  let centerPoint: Point = { x: 0, y: 0 };
  let svgElement: SVGSVGElement;
  let containerElement: HTMLDivElement;
  
  const dispatch = createEventDispatcher();
  
  // Calculate angle from value (0-360 degrees)
  function valueToAngle(val: number): number {
    const normalized = (val - min) / (max - min);
    return normalized * 360;
  }
  
  // Calculate value from angle
  function angleToValue(angle: number): number {
    const normalized = (angle % 360) / 360;
    return min + normalized * (max - min);
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
  
  // Handle mouse down
  function handleMouseDown(event: MouseEvent) {
    if (preciseMode) {
      isDragging = false;
      dragDistance = 0;
      startMousePos = { x: event.clientX, y: event.clientY };
    } else {
      isDragging = true;
      const angle = getMouseAngle(event);
      const newValue = Math.round(angleToValue(angle) / step) * step;
      value = Math.max(min, Math.min(max, newValue));
      dispatch('change', value);
    }
    
    dispatch('start');
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }
  
  // Handle mouse move
  function handleMouseMove(event: MouseEvent) {
    if (preciseMode && !isDragging) {
      // Calculate drag distance to unlock
      const distance = Math.sqrt(
        Math.pow(event.clientX - startMousePos.x, 2) +
        Math.pow(event.clientY - startMousePos.y, 2)
      );
      
      if (distance > unlockDistance) {
        isDragging = true;
      }
    }
    
    if (isDragging) {
      const angle = getMouseAngle(event);
      const newValue = Math.round(angleToValue(angle) / step) * step;
      value = Math.max(min, Math.min(max, newValue));
      dispatch('change', value);
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
    class="rotary-knob"
    class:dragging={isDragging}
    width={size}
    height={size}
    viewBox="0 0 207 207"
    on:mousedown={handleMouseDown}
  >
    <defs>
      <!-- Exact gradients from s10 -->
      <linearGradient x1="50%" y1="50%" x2="50%" y2="100%" id="outerGradient">
        <stop stop-color="#444040" stop-opacity="0.51098279" offset="0%"/>
        <stop stop-color="#131111" stop-opacity="0.893200861" offset="100%"/>
      </linearGradient>
      <linearGradient x1="50%" y1="0%" x2="50%" y2="100%" id="innerGradient">
        <stop stop-color="#FFFFFF" stop-opacity="0.5" offset="0%"/>
        <stop stop-color="#000000" stop-opacity="0.5" offset="100%"/>
      </linearGradient>
      
      <!-- TV lines pattern from s10 -->
      <pattern id="tvLines" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="1" fill="#666666" opacity="0.4"/>
        <rect width="8" height="1" y="2" fill="#333333" opacity="0.3"/>
        <rect width="8" height="1" y="4" fill="#666666" opacity="0.4"/>
        <rect width="8" height="1" y="6" fill="#333333" opacity="0.3"/>
      </pattern>
      
      <!-- Filters for shadows and glow -->
      <filter x="-3.3%" y="-3.3%" width="106.5%" height="106.5%" filterUnits="objectBoundingBox" id="shadowFilter">
        <feMorphology radius="0.5" operator="dilate" in="SourceAlpha" result="shadowSpreadOuter1"/>
        <feOffset dx="0" dy="0" in="shadowSpreadOuter1" result="shadowOffsetOuter1"/>
        <feGaussianBlur stdDeviation="2" in="shadowOffsetOuter1" result="shadowBlurOuter1"/>
        <feComposite in="shadowBlurOuter1" in2="SourceAlpha" operator="out" result="shadowBlurOuter1"/>
        <feColorMatrix values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0.5 0" type="matrix" in="shadowBlurOuter1"/>
      </filter>
      
      <!-- Text glow filter -->
      <filter x="-5.3%" y="-11.3%" width="110.7%" height="122.6%" filterUnits="objectBoundingBox" id="textGlow">
        <feOffset dx="0" dy="0" in="SourceAlpha" result="shadowOffsetOuter1"/>
        <feGaussianBlur stdDeviation="2" in="shadowOffsetOuter1" result="shadowBlurOuter1"/>
        <feColorMatrix values="0 0 0 0 0.915577168   0 0 0 0 0.797591325   0 0 0 0 0.601479722  0 0 0 1 0" type="matrix" in="shadowBlurOuter1"/>
      </filter>
    </defs>
    
    <g transform="translate(3, 3)">
      <!-- Outer ring -->
      <circle 
        cx="100.497487" 
        cy="100.497487" 
        r="99.4974874" 
        fill="url(#outerGradient)" 
        stroke="#979797" 
        stroke-width="1"
        filter="url(#shadowFilter)"
      />
      
      <!-- Inner ring -->
      <circle 
        cx="100.432161" 
        cy="100.432161" 
        r="86.4321608" 
        fill="url(#innerGradient)" 
        stroke="#4A4A4A" 
        stroke-width="1"
        filter="url(#shadowFilter)"
      />
      
      <!-- Center knob -->
      <circle 
        cx="71.4356094" 
        cy="71.4356094" 
        r="71.4356094" 
        fill="#322E2E"
        transform="translate(28.574244, 28.574244)"
      />
      
      <!-- Knob indicator with glow -->
      <path
        d="M100,35 L108,50 L92,50 Z"
        fill="#E6D7D7"
        transform="rotate({angle} 100 100)"
        stroke="#CCCCCC"
        stroke-width="1"
        filter="url(#textGlow)"
      />
      
      <!-- Center value display with glow -->
      <text
        x="100"
        y="117.884225"
        text-anchor="middle"
        class="value-text"
        fill="#E6D7D7"
        font-family="Helvetica"
        font-size="44"
        font-weight="normal"
        filter="url(#textGlow)"
      >
        {displayValue}
      </text>
      
      <!-- Duplicate text for extra glow -->
      <text
        x="100"
        y="117.884225"
        text-anchor="middle"
        class="value-text"
        fill="#E6D7D7"
        font-family="Helvetica"
        font-size="44"
        font-weight="normal"
      >
        {displayValue}
      </text>
      
      <!-- TV scan lines overlay - stationary horizontal lines on top of everything -->
      <circle 
        cx="100" 
        cy="100" 
        r="70" 
        fill="url(#tvLines)" 
        opacity="0.4"
        stroke="none"
      />
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