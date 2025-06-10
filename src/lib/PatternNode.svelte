<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { flowNodes, flowEdges, nodeOutputs } from '$lib/flowStore';
  
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
  
  // Get connected input nodes
  function getInputNodes() {
    const edges = $flowEdges.filter(edge => edge.target === id);
    const nodes = $flowNodes;
    
    if (nodeTypeName === 'Blend') {
      // For blend nodes, get both inputs
      const input1Edge = edges.find(e => e.targetHandle === 'input-1');
      const input2Edge = edges.find(e => e.targetHandle === 'input-2');
      
      const input1Node = input1Edge ? nodes.find(n => n.id === input1Edge.source) : null;
      const input2Node = input2Edge ? nodes.find(n => n.id === input2Edge.source) : null;
      
      return { input1: input1Node, input2: input2Node };
    } else {
      // For other nodes, get single input
      const inputEdge = edges[0];
      const inputNode = inputEdge ? nodes.find(n => n.id === inputEdge.source) : null;
      return { input: inputNode };
    }
  }
  
  // Get rendered output from a node
  function getNodeOutput(nodeId: string): ImageData | null {
    const outputs = $nodeOutputs;
    return outputs.get(nodeId) || null;
  }
  
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
    
    // Start with black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 100, 50);
    
    const inputs = getInputNodes();
    
    if (nodeTypeName === 'Output') {
      // Output just passes through its input
      if ('input' in inputs && inputs.input) {
        const inputData = getNodeOutput(inputs.input.id);
        if (inputData) {
          ctx.putImageData(inputData, 0, 0);
        }
      }
    } else if (nodeTypeName === 'Blend') {
      // Blend mixes two inputs
      const input1Data = inputs.input1 ? getNodeOutput(inputs.input1.id) : null;
      const input2Data = inputs.input2 ? getNodeOutput(inputs.input2.id) : null;
      
      if (input1Data || input2Data) {
        // Create blend effect
        const imageData = ctx.createImageData(100, 50);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          let r1 = 0, g1 = 0, b1 = 0, a1 = 255;
          let r2 = 0, g2 = 0, b2 = 0, a2 = 255;
          
          if (input1Data) {
            r1 = input1Data.data[i];
            g1 = input1Data.data[i + 1];
            b1 = input1Data.data[i + 2];
            a1 = input1Data.data[i + 3];
          }
          
          if (input2Data) {
            r2 = input2Data.data[i];
            g2 = input2Data.data[i + 1];
            b2 = input2Data.data[i + 2];
            a2 = input2Data.data[i + 3];
          }
          
          // Simple additive blend
          data[i] = Math.min(255, r1 + r2);
          data[i + 1] = Math.min(255, g1 + g2);
          data[i + 2] = Math.min(255, b1 + b2);
          data[i + 3] = 255;
        }
        
        ctx.putImageData(imageData, 0, 0);
      }
    } else {
      // Pattern nodes: render input first, then add pattern on top
      if ('input' in inputs && inputs.input) {
        const inputData = getNodeOutput(inputs.input.id);
        if (inputData) {
          ctx.putImageData(inputData, 0, 0);
        }
      }
      
      // Now render the pattern effect on top
      renderPattern();
    }
    
    // Store this node's output for other nodes to use
    const outputData = ctx.getImageData(0, 0, 100, 50);
    nodeOutputs.update(outputs => {
      outputs.set(id, outputData);
      return outputs;
    });
  }
  
  function renderPattern() {
    if (!ctx) return;
    
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
        const centerX = 50 + Math.sin(time * 2) * 20;
        const centerY = 25 + Math.cos(time * 1.5) * 10;
        const radialGradient = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 20);
        radialGradient.addColorStop(0, '#00ffff');
        radialGradient.addColorStop(1, 'transparent');
        ctx.fillStyle = radialGradient;
        ctx.fillRect(0, 0, 100, 50);
        break;
        
      case 'Raindrops':
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
        const intensity = Math.sin(time * 8) > 0.7 ? 1 : 0;
        if (intensity > 0) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.fillRect(0, 0, 100, 50);
        }
        break;
        
      case 'Sparkle':
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
        ctx.globalAlpha = fadeIntensity;
        ctx.fillStyle = '#ff6b35';
        ctx.fillRect(0, 0, 100, 50);
        ctx.globalAlpha = 1;
        break;
        
      case 'Chase':
        const position = (time * 20) % 100;
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(position, 25, 8, 0, Math.PI * 2);
        ctx.fill();
        break;
        
      case 'Twinkle':
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
        
      default:
        // Simple wave pattern for unknown types
        for (let i = 0; i < 100; i++) {
          const wave = Math.sin(i * 0.1 + time) * 0.5 + 0.5;
          const gray = Math.floor(wave * 128); // Reduced intensity for layering
          ctx.fillStyle = `rgba(${gray}, ${gray}, ${gray}, 0.5)`;
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
    // Clean up this node's output
    nodeOutputs.update(outputs => {
      outputs.delete(id);
      return outputs;
    });
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