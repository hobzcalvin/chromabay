<script lang="ts">
  import { SvelteFlow, Controls, Background, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  
  // Define the 3 vertical lanes for node snapping
  const LANES = {
    LEFT: 25,
    CENTER: 175, 
    RIGHT: 325
  };
  
  // Define initial nodes for the pattern editor with lane positioning and fixed width
  const initialNodes: Node[] = [
    {
      id: '1',
      type: 'input',
      position: { x: LANES.LEFT, y: 50 },
      data: { label: '🚀 Start Pattern' },
      style: 'background: #10b981; color: white; border: none; font-weight: bold; width: 100px;'
    },
    {
      id: '2',
      type: 'default',
      position: { x: LANES.CENTER, y: 50 },
      data: { label: '💡 LED Strip' },
      style: 'background: #3b82f6; color: white; border: none; font-weight: bold; width: 100px;'
    },
    {
      id: '3',
      type: 'default',
      position: { x: LANES.RIGHT, y: 50 },
      data: { label: '🎨 Color Effect' },
      style: 'background: #8b5cf6; color: white; border: none; font-weight: bold; width: 100px;'
    },
    {
      id: '4',
      type: 'output',
      position: { x: LANES.CENTER, y: 200 },
      data: { label: '🏁 End Pattern' },
      style: 'background: #ef4444; color: white; border: none; font-weight: bold; width: 100px;'
    }
  ];
  
  // Define initial edges with better styling
  const initialEdges: Edge[] = [
    { 
      id: 'e1-2', 
      source: '1', 
      target: '2', 
      type: 'smoothstep',
      style: 'stroke: #10b981; stroke-width: 2;',
      animated: true
    },
    { 
      id: 'e2-3', 
      source: '2', 
      target: '3', 
      type: 'smoothstep',
      style: 'stroke: #3b82f6; stroke-width: 2;',
      animated: true
    },
    { 
      id: 'e3-4', 
      source: '3', 
      target: '4', 
      type: 'smoothstep',
      style: 'stroke: #8b5cf6; stroke-width: 2;',
      animated: true
    }
  ];
  
  // Function to snap nodes to the nearest lane
  function snapToLane(x: number): number {
    const lanes = [LANES.LEFT, LANES.CENTER, LANES.RIGHT];
    return lanes.reduce((closest, lane) => 
      Math.abs(x - lane) < Math.abs(x - closest) ? lane : closest
    );
  }
  
  // Handle node drag stop to implement snapping
  function onNodeDragStop(event: any) {
    const node = event.targetNode;
    if (!node) return;
    
    const snappedX = snapToLane(node.position.x);
    
    // Directly update the node's position
    node.position.x = snappedX;
  }
  
  // Reactive variables for the flow - using $state for better reactivity
  let nodes = $state(initialNodes);
  let edges = $state(initialEdges);
</script>

<main>
  <div class="header">
    <h1>🎯 Pattern Editor</h1>
    <p>Design your LED patterns visually</p>
  </div>
  
  <div class="flow-container">
    <SvelteFlow 
      {nodes} 
      {edges}
      initialViewport={{x: 0, y: 0, zoom: 1}}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={true}
      elementsSelectable={false}
      selectNodesOnDrag={false}
      panOnDrag={true}
      translateExtent={[[0, 0], [450, Infinity]]}
      colorMode="dark"
      onnodedragstop={onNodeDragStop}
    >
      <Background variant={'none' as any} />
    </SvelteFlow>
  </div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
  }
  
  .header {
    text-align: center;
    color: white;
    flex-shrink: 0;
    margin-bottom: 1rem;
  }
  
  .header h1 {
    margin: 0;
    font-size: 2.5rem;
    font-weight: 700;
    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
  }
  
  .header p {
    margin: 0.5rem 0 0 0;
    font-size: 1.1rem;
    opacity: 0.9;
  }
  
  .flow-container {
    flex: 1;
    border-radius: 12px;
    background: white;
    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
    overflow: hidden;
    min-height: 0; /* Important for flex child to shrink */
    width: 100%;
    box-sizing: border-box;
  }
  
  /* Mobile responsive adjustments */
  @media (max-width: 768px) {
    .header h1 {
      font-size: 2rem;
    }
    
    .header p {
      font-size: 1rem;
    }
  }
  
  @media (max-width: 480px) {
    .header h1 {
      font-size: 1.75rem;
    }
    
    .header p {
      font-size: 0.9rem;
    }
  }
</style>
