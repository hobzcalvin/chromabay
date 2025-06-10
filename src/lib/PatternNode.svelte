<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  
  let { data, id, type }: NodeProps & { type: string } = $props();
  
  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;
  let time = 0;
  
  // Extract node type name from data.label
  const getNodeTypeName = (label: string): string => {
    const parts = label.split(' ');
    return parts.slice(1).join(' ');
  };
  
  const nodeTypeName = getNodeTypeName(data.label as string);
  
  onMount(() => {
    ctx = canvasElement.getContext('2d');
    animate();
  });
  
  function animate() {
    time += 0.016;
    render();
    animationFrame = requestAnimationFrame(animate);
  }
  
  function render() {
    if (!ctx) return;
    
    ctx.clearRect(0, 0, 100, 50);
    
    switch (nodeTypeName) {
      case 'Rainbow':
        for (let i = 0; i < 100; i++) {
          const hue = (i / 100 + time * 0.1) % 1;
          const [r, g, b] = hslToRgb(hue, 1, 0.5);
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          ctx.fillRect(i, 0, 1, 50);
        }
        break;
        
      case 'Gradient':
        const gradient = ctx.createLinearGradient(0, 0, 100, 0);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#8b5cf6');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 100, 50);
        break;
        
      case 'Perlin Noise':
        for (let x = 0; x < 100; x += 2) {
          for (let y = 0; y < 50; y += 2) {
            const noise = Math.sin(x * 0.1 + time) * Math.cos(y * 0.1 + time);
            const intensity = Math.floor((noise + 1) * 127.5);
            ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
            ctx.fillRect(x, y, 2, 2);
          }
        }
        break;
        
      case 'Moving Blob':
        ctx.fillStyle = '#000033';
        ctx.fillRect(0, 0, 100, 50);
        const centerX = 50 + Math.sin(time * 2) * 20;
        const centerY = 25 + Math.cos(time * 1.5) * 10;
        const radialGradient = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 20);
        radialGradient.addColorStop(0, '#00ffff');
        radialGradient.addColorStop(1, 'transparent');
        ctx.fillStyle = radialGradient;
        ctx.fillRect(0, 0, 100, 50);
        break;
        
      case 'Raindrops':
        ctx.fillStyle = '#000044';
        ctx.fillRect(0, 0, 100, 50);
        for (let i = 0; i < 5; i++) {
          const x = (i * 20 + 10) % 100;
          const y = ((time * 50 + i * 10) % 60) - 10;
          if (y >= 0 && y <= 50) {
            ctx.fillStyle = '#4fc3f7';
            ctx.beginPath();
            ctx.ellipse(x, y, 2, 4, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
        
      case 'Strobe':
        const intensity = Math.sin(time * 8) > 0.7 ? 255 : 0;
        ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
        ctx.fillRect(0, 0, 100, 50);
        break;
        
      case 'Sparkle':
        ctx.fillStyle = '#001122';
        ctx.fillRect(0, 0, 100, 50);
        for (let i = 0; i < 8; i++) {
          const x = 20 + i * 10;
          const y = 25 + Math.sin(i * 2) * 10;
          const alpha = Math.abs(Math.sin(time * 3 + i)) * 0.8 + 0.2;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
        
      case 'Fade':
        const fadeIntensity = (Math.sin(time) + 1) * 0.5;
        const color = Math.floor(fadeIntensity * 255);
        ctx.fillStyle = `rgb(${color}, ${Math.floor(color * 0.8)}, ${Math.floor(color * 0.6)})`;
        ctx.fillRect(0, 0, 100, 50);
        break;
        
      case 'Chase':
        ctx.fillStyle = '#001100';
        ctx.fillRect(0, 0, 100, 50);
        const position = (time * 20) % 100;
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(position, 25, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
        
      case 'Twinkle':
        ctx.fillStyle = '#000011';
        ctx.fillRect(0, 0, 100, 50);
        for (let i = 0; i < 15; i++) {
          const x = (i * 7) % 100;
          const y = 15 + (i % 3) * 10;
          const alpha = Math.sin(time * 4 + i * 0.5) > 0.5 ? 0.9 : 0.1;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ffff88';
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
        
      case 'Blend':
        // Blend visualization - show a mixing pattern
        ctx.fillStyle = '#8b5cf6';
        ctx.fillRect(0, 0, 100, 50);
        
        // Add some visual indication of blending
        for (let i = 0; i < 100; i += 10) {
          const alpha = Math.sin(time * 3 + i * 0.1) * 0.3 + 0.7;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(i, 0, 5, 50);
        }
        ctx.globalAlpha = 1;
        break;
        
      case 'Output':
        // Output node - show what would be the final result
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(0, 0, 100, 50);
        
        // Add some activity indicators
        const pulse = Math.sin(time * 4) * 0.3 + 0.7;
        ctx.globalAlpha = pulse;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(10, 20, 80, 10);
        ctx.globalAlpha = 1;
        break;
        
      default:
        // Simple wave pattern for unknown types
        for (let i = 0; i < 100; i++) {
          const wave = Math.sin(i * 0.1 + time) * 0.5 + 0.5;
          const gray = Math.floor(wave * 255);
          ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
          ctx.fillRect(i, 0, 1, 50);
        }
    }
  }
  
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h * 6) % 2 - 1));
    const m = l - c / 2;
    
    let r = 0, g = 0, b = 0;
    
    if (0 <= h && h < 1/6) {
      r = c; g = x; b = 0;
    } else if (1/6 <= h && h < 2/6) {
      r = x; g = c; b = 0;
    } else if (2/6 <= h && h < 3/6) {
      r = 0; g = c; b = x;
    } else if (3/6 <= h && h < 4/6) {
      r = 0; g = x; b = c;
    } else if (4/6 <= h && h < 5/6) {
      r = x; g = 0; b = c;
    } else if (5/6 <= h && h < 1) {
      r = c; g = 0; b = x;
    }
    
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255)
    ];
  }
  
  onDestroy(() => {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
    }
  });
  
  const isBlendNode = nodeTypeName === 'Blend';
  const isOutputNode = nodeTypeName === 'Output';
</script>

<div class="pattern-node" class:blend-node={isBlendNode}>
  <canvas 
    bind:this={canvasElement}
    width="100"
    height="50"
    class="pattern-canvas"
  ></canvas>
  
  <div class="node-content">
    {data.label}
  </div>
  
  {#if isBlendNode}
    <Handle type="target" position={Position.Top} id="input-1" style="left: 30%" />
    <Handle type="target" position={Position.Top} id="input-2" style="left: 70%" />
  {:else}
    <Handle type="target" position={Position.Top} id="input" style="left: 50%" />
  {/if}
  
  {#if !isOutputNode}
    <Handle type="source" position={Position.Bottom} id="output" style="left: 50%" />
  {/if}
</div>

<style>
  .pattern-node {
    position: relative;
    background: transparent;
    color: white;
    border: none;
    font-weight: bold;
    width: 100px;
    height: 50px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .pattern-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    border-radius: 4px;
  }
  
  .node-content {
    position: relative;
    z-index: 1;
    text-align: center;
    font-size: 12px;
    color: white;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    pointer-events: none;
  }
  
  .blend-node {
    background: rgba(139, 92, 246, 0.1);
  }
</style> 