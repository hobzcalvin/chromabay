<script lang="ts">
  import { SvelteFlow, Controls, Background, BaseEdge, MarkerType, Position, type Node, type Edge, type Connection, useSvelteFlow, useViewport, getOutgoers } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { flowNodes, flowEdges, nextNodeId, LANES, NODE_TYPES, createNodeFromType } from '$lib/flowStore';
  import PatternNode from '$lib/PatternNode.svelte';
  
  // Get SvelteFlow hooks
  const { screenToFlowPosition } = useSvelteFlow();
  const viewport = useViewport();
  
  // Define custom node types
  const nodeTypes = {
    pattern: PatternNode
  };
  
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
    
    // Update the node's position in the store
    flowNodes.update(nodes => 
      nodes.map(n => 
        n.id === node.id 
          ? { ...n, position: { x: snappedX, y: node.position.y } }
          : n
      )
    );
  }
  
  // Create a new node of specified type
  function createNode(nodeType: typeof NODE_TYPES[0]) {
    nextNodeId.update(id => {
      const newId = id.toString();
      
      // Calculate the center of the current viewport
      const flowContainerWidth = 450; // From translateExtent
      const flowContainerHeight = 600; // Estimated height
      
      // Get the center of the viewport in flow coordinates
      const viewportCenterX = -viewport.current.x / viewport.current.zoom + (flowContainerWidth / 2) / viewport.current.zoom;
      const viewportCenterY = -viewport.current.y / viewport.current.zoom + (flowContainerHeight / 2) / viewport.current.zoom;
      
      // Snap X coordinate to the nearest lane
      const nodeX = snapToLane(viewportCenterX);
      
      // Use viewport center Y with slight random offset to avoid overlap
      const nodeY = viewportCenterY + (Math.random() * 100 - 50); // ±50px random offset
      
      // Create node using shared helper
      const newNode = createNodeFromType(nodeType, newId, { x: nodeX, y: nodeY });
      
      // Add new node to the store
      flowNodes.update(nodes => [...nodes, newNode]);
      
      return id + 1; // Increment for next node
    });
  }

  // Handle edge click to delete edge
  function onEdgeClick(event: any) {
    const edge = event.edge;
    if (!edge) return;
    // Remove the clicked edge from the store
    flowEdges.update(edges => edges.filter(e => e.id !== edge.id));
  }

  // Function to validate connections and prevent cycles
  function isValidConnection(connection: Edge | Connection): boolean {
    // Extract source and target from connection (could be Edge or Connection)
    const source = connection.source;
    const target = $flowNodes.find((node) => node.id === connection.target);
    if (!target || !source) return false;
    
    // Prevent self-loops
    if (target.id === source) return false;
    
    // Check input connection limits
    const targetHandleId = connection.targetHandle;
    
    // Check if this is a blend node by examining its type
    const isBlendNode = target.data.type === 'blend';
    
    if (isBlendNode) {
      // For blend nodes, each handle can only have one connection
      const existingConnections = $flowEdges.filter(edge => 
        edge.target === connection.target && 
        edge.targetHandle === targetHandleId
      );
      if (existingConnections.length >= 1) return false;
    } else {
      // For all other nodes, only allow one total input connection
      const allTargetConnections = $flowEdges.filter(edge => edge.target === connection.target);
      if (allTargetConnections.length >= 1) return false;
    }
    
    // Check for cycles by traversing from target to see if we reach source
    const hasCycle = (node: Node, visited = new Set<string>()): boolean => {
      if (visited.has(node.id)) return false;
      
      visited.add(node.id);
      
      for (const outgoer of getOutgoers(node, $flowNodes, $flowEdges)) {
        if (outgoer.id === source) return true;
        if (hasCycle(outgoer, visited)) return true;
      }
      
      return false;
    };
    
    // Check for cycles
    return !hasCycle(target);
  }


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
            // Add 1 to skip the output node at index 0
            createNode(NODE_TYPES[selectedIndex + 1]);
            target.selectedIndex = 0; // Reset to placeholder
          }
        }}
      >
        <option value="">➕ Add Pattern Node</option>
        {#each NODE_TYPES.slice(1) as nodeType}
          <option value={nodeType.name}>
            {nodeType.name}
          </option>
        {/each}
      </select>
    </div>
  </div>
  
  <div class="flow-container">
    <SvelteFlow 
      bind:nodes={$flowNodes}
      bind:edges={$flowEdges}
      {nodeTypes}
      fitView={true}
      fitViewOptions={{
        maxZoom: 1.0,
      }}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={true}
      elementsSelectable={false}
      selectNodesOnDrag={false}
      panOnDrag={true}
      translateExtent={[[0, -Infinity], [450, Infinity]]}
      colorMode="dark"
      onnodedragstop={onNodeDragStop}
      onedgeclick={onEdgeClick}
      nodesConnectable={true}
      zoomOnDoubleClick={false}
      isValidConnection={isValidConnection}
      defaultEdgeOptions={{
        type: 'default',
        style: 'stroke-width: 3; stroke: #666;',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#666'
        }
      }}
    >
      <Background 
        variant={'dots' as any} 
        gap={[150, 5]} 
      />
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
