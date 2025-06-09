<script lang="ts">
  import { SvelteFlow, Controls, Background, BaseEdge, MarkerType, type Node, type Edge, type Connection } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { RemovableNode } from '$lib';
  
  // Define the 3 vertical lanes for node snapping
  const LANES = {
    LEFT: 25,
    CENTER: 175,
    RIGHT: 325
  };

  const nodeTypes = {
    default: RemovableNode,
    input: RemovableNode,
    output: RemovableNode
  };

  function deleteNode(id: string) {
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
  }
  
  // Define initial nodes for the pattern editor with lane positioning and fixed width
  const initialNodes: Node[] = [
    {
      id: '1',
      type: 'input',
      position: { x: LANES.LEFT, y: 50 },
      data: { label: '🚀 Start Pattern', onDelete: () => deleteNode('1') },
      style: 'background: #10b981; color: white; border: none; font-weight: bold; width: 100px; position: relative;'
    },
    {
      id: '2',
      type: 'default',
      position: { x: LANES.CENTER, y: 50 },
      data: { label: '💡 LED Strip', onDelete: () => deleteNode('2') },
      style: 'background: #3b82f6; color: white; border: none; font-weight: bold; width: 100px; position: relative;'
    },
    {
      id: '3',
      type: 'default',
      position: { x: LANES.RIGHT, y: 50 },
      data: { label: '🎨 Color Effect', onDelete: () => deleteNode('3') },
      style: 'background: #8b5cf6; color: white; border: none; font-weight: bold; width: 100px; position: relative;'
    },
    {
      id: '4',
      type: 'output',
      position: { x: LANES.CENTER, y: 200 },
      data: { label: '🏁 End Pattern', onDelete: () => deleteNode('4') },
      style: 'background: #ef4444; color: white; border: none; font-weight: bold; width: 100px; position: relative;'
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
      deleteNode(node.id);
      return;
    }
    
    const snappedX = snapToLane(node.position.x);
    
    // Directly update the node's position
    node.position.x = snappedX;
  }
  

  
  // Create a new node
  function createNode() {
    const nodeTypes = ['default'];
    const nodeLabels = ['⚡ Action', '🎯 Trigger', '🏁 Output'];
    const nodeColors = ['#3b82f6', '#10b981', '#ef4444'];
    
    const randomType = Math.floor(Math.random() * nodeTypes.length);
    const newId = (nodes.length + 1).toString();
    
    const newNode: Node = {
      id: newId,
      type: nodeTypes[randomType],
      position: { x: LANES.CENTER, y: 100 + (nodes.length * 60) },
      data: { label: nodeLabels[randomType], onDelete: () => deleteNode(newId) },
      style: `background: ${nodeColors[randomType]}; color: white; border: none; font-weight: bold; width: 100px; position: relative;`
    };
    
    nodes = [...nodes, newNode];
  }
  
  // Handle new connections to ensure unique edge IDs
  function onConnect(connection: Connection) {
    const newEdgeId = `e${connection.source}-${connection.target}-${Date.now()}`;
    const newEdge: Edge = {
      id: newEdgeId,
      source: connection.source!,
      target: connection.target!,
    };
    edges = [...edges, newEdge];
  }

  // Handle edge click to delete edge
  function onEdgeClick(event: any) {
    const edge = event.edge;
    if (!edge) return;
    // Remove the clicked edge
    edges = edges.filter(e => e.id !== edge.id);
  }
  
  // Reactive variables for the flow - using $state for better reactivity
  let nodes = $state(initialNodes);
  let edges = $state(initialEdges);
</script>

<main>
  <div class="header">
    <h1>🎯 Pattern Editor</h1>
    <p>Design your LED patterns visually</p>
    <button class="create-node-btn" onclick={createNode}>
      ➕ Add Node
    </button>
  </div>
  
  <div class="flow-container">
    <SvelteFlow
      {nodes}
      {edges}
      nodeTypes={nodeTypes}
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
      onconnect={onConnect}
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
  
  .create-node-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: #10b981;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background-color 0.2s;
  }
  
  .create-node-btn:hover {
    background: #059669;
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
    
    .create-node-btn {
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
