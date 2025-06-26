<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy, getContext } from 'svelte';
  import { getNodeDefinition, type RenderContext } from '$lib/flowStore';
  import { flowNodes as globalFlowNodes, flowEdges as globalFlowEdges, nodeOutputs as globalNodeOutputs, globalStartTime as globalGlobalStartTime } from '$lib/flowStore';
  import type { Writable } from 'svelte/store';
  
  let { data, id, type, ...nodeProps }: NodeProps & { type: string } = $props();
  
  // Get local stores from context (if available) or fall back to global
  const contextFlowNodes = getContext<Writable<any[]>>('flowNodes');
  const contextFlowEdges = getContext<Writable<any[]>>('flowEdges');
  const contextNodeOutputs = getContext<Writable<Map<string, ImageData>>>('nodeOutputs');
  const contextGlobalStartTime = getContext<Writable<number>>('globalStartTime');
  
  // Use context stores if available, otherwise fall back to global
  const flowNodes = contextFlowNodes || globalFlowNodes;
  const flowEdges = contextFlowEdges || globalFlowEdges;
  const nodeOutputs = contextNodeOutputs || globalNodeOutputs;
  const globalStartTime = contextGlobalStartTime || globalGlobalStartTime;
  
  let canvasElement: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationFrame: number | null = null;
  let lastFrameTime: number;
  
  // Configurable texture dimensions
  let textureWidth = 100;
  let textureHeight = 50;
  
  // Get the clean node type from data
  const nodeType = data.type as string;
  
  // Get connected input nodes
  function getInputNodes() {
    const edges = $flowEdges.filter(edge => edge.target === id);
    const nodes = $flowNodes;
    
    if (nodeType === 'blend') {
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
    ctx = canvasElement.getContext('2d', { willReadFrequently: true });
    lastFrameTime = performance.now();
    animate();
  });

  function animate() {
    const currentTime = performance.now();
    render(currentTime);
    animationFrame = requestAnimationFrame(animate);
  }

  function render(currentTime: number) {
    if (!ctx) return;
    
    const totalTime = (currentTime - $globalStartTime) / 1000; // Convert to seconds
    const deltaTime = (currentTime - lastFrameTime) / 1000; // Convert to seconds
    lastFrameTime = currentTime;
    
    // Start with black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, textureWidth, textureHeight);
    
    // Always handle single input first (no-op for blend nodes)
    const inputs = getInputNodes();
    if ('input' in inputs && inputs.input) {
      const inputData = getNodeOutput(inputs.input.id);
      if (inputData) {
        ctx.putImageData(inputData, 0, 0);
      }
    }
    
    // Get the node definition and call its render function
    const nodeDefinition = getNodeDefinition(nodeType);
    if (nodeDefinition) {
      const renderContext: RenderContext = {
        ctx,
        totalTime,
        deltaTime,
        width: textureWidth,
        height: textureHeight,
        getInputNodes,
        getNodeOutput,
        nodeId: id
      };
      
      nodeDefinition.render(renderContext);
    }
    
    // Store this node's output for other nodes to use
    const outputData = ctx.getImageData(0, 0, textureWidth, textureHeight);
    nodeOutputs.update(outputs => {
      outputs.set(id, outputData);
      return outputs;
    });
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
  
  const isBlendNode = nodeType === 'blend';
  const isOutputNode = nodeType === 'output';
</script>

<div 
  class="pattern-node" 
  class:blend-node={isBlendNode}
  class:has-parameters={getNodeDefinition(nodeType)?.params.length ?? 0 > 0}
  role="button"
  tabindex="0"
>
  <canvas 
    bind:this={canvasElement}
    width={textureWidth}
    height={textureHeight}
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
  
  .has-parameters {
    cursor: pointer;
  }
</style> 