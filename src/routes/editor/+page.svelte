<script lang="ts">
  import { SvelteFlow, Controls, Background, BaseEdge, MarkerType, type Node, type Edge, type Connection } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  
  // Define LED pattern node types
  const NODE_TYPES = [
    { name: 'Gradient', emoji: '🌈', color: '#3b82f6' },
    { name: 'Rainbow', emoji: '🌙', color: '#10b981' },
    { name: 'Perlin Noise', emoji: '🌊', color: '#8b5cf6' },
    { name: 'Moving Blob', emoji: '💧', color: '#f59e0b' },
    { name: 'Raindrops', emoji: '🌧️', color: '#06b6d4' },
    { name: 'Strobe', emoji: '⚡', color: '#ef4444' },
    { name: 'Sparkle', emoji: '✨', color: '#ec4899' },
    { name: 'Fade', emoji: '🌅', color: '#84cc16' },
    { name: 'Chase', emoji: '🏃', color: '#f97316' },
    { name: 'Twinkle', emoji: '⭐', color: '#6366f1' }
  ];
  
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
    },
    { 
      id: 'e2-3', 
      source: '2', 
      target: '3', 
    },
    { 
      id: 'e3-4', 
      source: '3', 
      target: '4', 
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
    
    // Check if node is dragged outside the editor bounds for deletion
    if (node.position.x < -50 || node.position.x > 500 || node.position.y < -50) {
      // Remove node and connected edges
      nodes = nodes.filter(n => n.id !== node.id);
      edges = edges.filter(e => e.source !== node.id && e.target !== node.id);
      return;
    }
    
    const snappedX = snapToLane(node.position.x);
    
    // Update the node's position by reassigning the entire nodes array
    nodes = nodes.map(n => 
      n.id === node.id 
        ? { ...n, position: { x: snappedX, y: node.position.y } }
        : n
    );
  }
  

  
  // Keep track of next available ID
  let nextNodeId = $state(5);
  
    // Create a new node of specified type
  function createNode(nodeType: typeof NODE_TYPES[0]) {
    const newId = nextNodeId.toString();
    nextNodeId++;
    
    // Simple approach: place at center of flow area with some Y offset
    const centerY = 300 + (Math.random() * 200); // Random Y to avoid overlap
    const snappedX = LANES.LEFT; // Default to center lane
    
    const newNode: Node = {
      id: newId,
      type: 'default',
      position: { x: snappedX, y: centerY },
      data: { label: `${nodeType.emoji} ${nodeType.name}` },
      style: `background: ${nodeType.color}; color: white; border: none; font-weight: bold; width: 100px;`
    };
    
    nodes = [...nodes, newNode];
  }

  // Handle edge click to delete edge
  function onEdgeClick(event: any) {
    const edge = event.edge;
    if (!edge) return;
    // Remove the clicked edge
    edges = edges.filter(e => e.id !== edge.id);
  }
  
  // Reactive variables for the flow - using $state.raw for better reactivity
  let nodes = $state.raw(initialNodes);
  let edges = $state.raw(initialEdges);
</script>

<main>
  <div class="header">
    <h1>🎯 Pattern Editor</h1>
    <p>Design your LED patterns visually</p>
    
    <div class="dropdown-container">
      <select 
        class="dropdown-select"
        onchange={(e) => {
          const target = e.target as HTMLSelectElement;
          if (!target) return;
          const selectedIndex = target.selectedIndex - 1; // -1 because first option is placeholder
          if (selectedIndex >= 0) {
            createNode(NODE_TYPES[selectedIndex]);
            target.selectedIndex = 0; // Reset to placeholder
          }
        }}
      >
        <option value="">➕ Add Pattern Node</option>
        {#each NODE_TYPES as nodeType}
          <option value={nodeType.name}>
            {nodeType.emoji} {nodeType.name}
          </option>
        {/each}
      </select>
    </div>
  </div>
  
  <div class="flow-container">
    <SvelteFlow 
      bind:nodes 
      bind:edges
      initialViewport={{x: 0, y: 0, zoom: 1}}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={true}
      elementsSelectable={false}
      selectNodesOnDrag={false}
      panOnDrag={true}
      translateExtent={[[0, 0], [450, Infinity]]}
      colorMode="dark"
      onnodedragstop={onNodeDragStop}
      onedgeclick={onEdgeClick}
      nodesConnectable={true}
      zoomOnDoubleClick={false}
      defaultEdgeOptions={{
        type: 'smoothstep',
        style: 'stroke-width: 3; stroke: #666;',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#666'
        }
      }}
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
    position: relative;
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
  
  .dropdown-container {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10000; /* High z-index to ensure it's above SvelteFlow */
  }
  
  .dropdown-select {
    background: white;
    color: #374151;
    border: 2px solid #d1d5db;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.9rem;
    cursor: pointer;
    min-width: 180px;
    position: relative;
    z-index: 10001;
    font-family: inherit;
    appearance: menulist; /* Standard dropdown appearance */
  }
  
  .dropdown-select:hover {
    border-color: #9ca3af;
  }
  
  .dropdown-select:focus {
    outline: none;
    border-color: #10b981;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1);
  }
  
  .dropdown-select option {
    background: white;
    color: #374151;
    padding: 0.5rem;
    font-weight: normal;
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
    
    .dropdown-container {
      position: static;
      transform: none;
      margin-top: 1rem;
    }
    
    .dropdown-menu {
      position: relative;
      top: 0.5rem;
      right: auto;
      left: 0;
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

  :global(.svelte-flow__handle-bottom) {
    width: 16px !important;
    height: 16px !important;
  }

  /* Disable mouse events on top handles to prevent dragging from them */
  :global(.svelte-flow__handle-top) {
    pointer-events: none !important;
  }

  /* Re-enable pointer events during connection mode when hovering over target */
  :global(.svelte-flow__handle-top.connecting) {
    pointer-events: all !important;
  }
</style>
