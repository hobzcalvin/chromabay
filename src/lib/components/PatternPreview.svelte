<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { SerializedPattern } from '$lib/patternSerializer';
  
  export let pattern: SerializedPattern;
  export let size = 60;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number;
  let animationPhase = 0;
  
  function getPatternColor(nodeType: string) {
    switch (nodeType) {
      case 'rainbow': return ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#0000ff', '#4b0082', '#9400d3'];
      case 'solid': return ['#4a90e2'];
      case 'sparkle': return ['#ffffff', '#ffd700', '#ffffff'];
      case 'fade': return ['#000000', '#667eea', '#000000'];
      case 'blend': return ['#667eea', '#764ba2'];
      case 'pulse': return ['#ff4757', '#ff3838'];
      default: return ['#667eea', '#764ba2'];
    }
  }
  
  function renderPattern() {
    if (!ctx) return;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    
    // Find the output node or main pattern node
    const outputNode = pattern.nodes.find(n => n.o === pattern.meta?.output) || pattern.nodes[0];
    if (!outputNode) return;
    
    const colors = getPatternColor(outputNode.t);
    
    // Create animated pattern based on node type
    switch (outputNode.t) {
      case 'rainbow':
        // Rainbow gradient that shifts
        const rainbowGradient = ctx.createLinearGradient(0, 0, size, 0);
        for (let i = 0; i < colors.length; i++) {
          const offset = (i + animationPhase * 0.01) % colors.length / colors.length;
          rainbowGradient.addColorStop(offset, colors[i]);
        }
        ctx.fillStyle = rainbowGradient;
        ctx.fillRect(0, 0, size, size);
        break;
        
      case 'sparkle':
        // Sparkly background with random bright dots
        ctx.fillStyle = '#000020';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 8; i++) {
          const x = (Math.sin(animationPhase * 0.02 + i) * 0.5 + 0.5) * size;
          const y = (Math.cos(animationPhase * 0.03 + i * 1.5) * 0.5 + 0.5) * size;
          const opacity = Math.abs(Math.sin(animationPhase * 0.05 + i)) * 0.8 + 0.2;
          ctx.globalAlpha = opacity;
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
        break;
        
      case 'fade':
        // Fading between colors
        const fadeOpacity = Math.abs(Math.sin(animationPhase * 0.03)) * 0.8 + 0.2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = fadeOpacity;
        ctx.fillStyle = colors[1] || '#667eea';
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = 1;
        break;
        
      case 'pulse':
        // Pulsing color
        const pulseScale = Math.abs(Math.sin(animationPhase * 0.08)) * 0.5 + 0.5;
        const pulseGradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2 * pulseScale);
        pulseGradient.addColorStop(0, colors[0]);
        pulseGradient.addColorStop(1, colors[1] || '#000');
        ctx.fillStyle = pulseGradient;
        ctx.fillRect(0, 0, size, size);
        break;
        
      case 'blend':
        // Blending gradient
        const blendGradient = ctx.createLinearGradient(0, 0, size, size);
        blendGradient.addColorStop(0, colors[0]);
        blendGradient.addColorStop(1, colors[1] || colors[0]);
        ctx.fillStyle = blendGradient;
        ctx.fillRect(0, 0, size, size);
        break;
        
      default:
        // Solid or unknown - simple gradient
        if (colors.length > 1) {
          const gradient = ctx.createLinearGradient(0, 0, size, size);
          gradient.addColorStop(0, colors[0]);
          gradient.addColorStop(1, colors[1]);
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = colors[0];
        }
        ctx.fillRect(0, 0, size, size);
        break;
    }
  }
  
  function animate() {
    animationPhase++;
    renderPattern();
    animationFrame = requestAnimationFrame(animate);
  }
  
  onMount(() => {
    if (canvas) {
      ctx = canvas.getContext('2d');
      animate();
    }
  });
  
  onDestroy(() => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
    }
  });
</script>

<div class="preview-container" style="width: {size}px; height: {size}px;">
  <canvas 
    bind:this={canvas}
    width={size} 
    height={size}
    class="preview-canvas"
  />
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