<script lang="ts">
  import { tick, onMount } from 'svelte';
  import { SvelteFlow, Controls, Background, BaseEdge, MarkerType, Position, type Node, type Edge, type Connection, useSvelteFlow, useViewport, getOutgoers } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { flowNodes, flowEdges, nextNodeId, LANES, NODE_TYPES, createNodeFromType, getNodeDefinition, isValidConnectionWithBuffers, initializeDefaultPattern, loadSerializedPattern } from '$lib/flowStore';
  import PatternNode from '$lib/PatternNode.svelte';
  import NodeParameterEditor from '$lib/components/NodeParameterEditor.svelte';
  import PatternActions from '$lib/components/PatternActions.svelte';
  import { loadPatterns, currentPattern } from '$lib/stores/patternsStore';
  // Hidden for now: import PatternSerializationPanel from '$lib/components/PatternSerializationPanel.svelte';
  
  // Initialize patterns on mount
  onMount(async () => {
    try {
      await loadPatterns();
      // Load the current pattern into the flow editor
      const current = $currentPattern;
      if (current) {
        loadSerializedPattern(current);
      } else {
        // Fallback to default pattern
        initializeDefaultPattern();
      }
    } catch (error) {
      console.error('Failed to load patterns:', error);
      // Fallback to default pattern on error
      initializeDefaultPattern();
    }
  });
  
  // Get SvelteFlow hooks
  const { screenToFlowPosition, setViewport } = useSvelteFlow();
  const viewport = useViewport();
  
  // Parameter editor state - similar to context menu approach
  let parameterEditor: {
    id: string;
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
  } | null = $state(null);
  let clientWidth: number = $state(0);
  let clientHeight: number = $state(0);
  let flowContainer: HTMLDivElement;
  
  // Editor cleanup state - managed here so external closures can reset it
  let deleteConfirmState = $state(false);
  let deleteTimeout: ReturnType<typeof setTimeout> | undefined = $state(undefined);
  
  // Add Pattern Node dropdown state
  let showAddNodeDropdown = $state(false);
  let addNodeDropdownRef: HTMLDivElement;
  
  // Reactive check for active node - ensure we have a valid node with proper data
  const activeNode = $derived.by(() => {
    if (!parameterEditor) return null;
    const node = $flowNodes.find(n => n.id === parameterEditor!.id);
    // Only return the node if it has valid data structure
    return (node && node.data && node.data.type) ? node : null;
  });
  const showParameterEditor = $derived(parameterEditor !== null && activeNode !== null);
  
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
  


  // Handle node drag stop to implement snapping and validate buffer constraints
  function onNodeDragStop(event: any) {
    const node = event.targetNode;
    if (!node) return;
    
    const snappedX = snapToLane(node.position.x);
    
    // Update the node's position in the store
    flowNodes.update(nodes => {
      const updatedNodes = nodes.map(n => 
        n.id === node.id 
          ? { ...n, position: { x: snappedX, y: node.position.y } }
          : n
      );
      
      // Validate connections with the updated nodes immediately
      // This avoids async store update issues
      tick().then(() => {
        validateAndCleanupConnections();
      });
      
      return updatedNodes;
    });

    console.log("$flowNodes", JSON.stringify($flowNodes, null, 2), "$flowEdges", JSON.stringify($flowEdges, null, 2));
  }
  
  // Validate all connections and remove any that violate buffer constraints
  function validateAndCleanupConnections() {
    const invalidConnections: Edge[] = [];
    
    // Check each existing connection
    $flowEdges.forEach(edge => {
      const isValid = isValidConnectionWithBuffers(edge, $flowNodes, $flowEdges);
      if (!isValid) {
        invalidConnections.push(edge);
      }
    });
    
    // Remove invalid connections
    if (invalidConnections.length > 0) {
      flowEdges.update(edges => 
        edges.filter(edge => !invalidConnections.some(invalid => invalid.id === edge.id))
      );
    }
  }

  // Handle node clicks for parameter editing - positioned below the node
  function handleNodeClick({ event, node }: { event: MouseEvent | TouchEvent; node: Node }) {
    event.stopPropagation();
    
    // If parameter editor is already open, close it
    if (parameterEditor ) {
      closeParameterEditor();
      return;
    }
 
    // Check if this node has parameters
    const nodeDefinition = getNodeDefinition(node.data.type as string);
    if (!nodeDefinition || !nodeDefinition.params || nodeDefinition.params.length === 0) {
      return;
    }

    // Get the actual node DOM element from the event target
    const nodeElement = event.target as HTMLElement;
    const nodeRect = nodeElement.getBoundingClientRect();
    
    // Initially position editor centered underneath the node (we'll adjust after measuring)
    const initialX = nodeRect.left + (nodeRect.width / 2); // Start at node center
    const editorY = nodeRect.bottom + 10; // 10px spacing below the node

    // Use absolute positioning - will be adjusted after measuring actual width
    parameterEditor = {
      id: node.id,
      top: editorY,
      left: initialX,
    };

    // Use tick to wait for the parameter editor to render, then adjust position
    tick().then(() => {
      // Find the rendered parameter editor element and measure its width
      const editorElement = document.querySelector('.parameter-popover') as HTMLElement;
      if (editorElement && parameterEditor && flowContainer) {
        const editorRect = editorElement.getBoundingClientRect();
        const flowContainerRect = flowContainer.getBoundingClientRect();
        const adjustedX = nodeRect.left + (nodeRect.width / 2) - (editorRect.width / 2);
        
        // Check for vertical overflow (below the fold)
        const editorBottom = editorRect.bottom;
        const containerBottom = flowContainerRect.bottom;
        const isEditorBelowFold = editorBottom > containerBottom;
        
        // Check for horizontal overflow (left and right sides)
        const editorLeft = editorRect.left;
        const editorRight = editorRect.right;
        const containerLeft = flowContainerRect.left;
        const containerRight = flowContainerRect.right;
        const isEditorOffLeft = editorLeft < containerLeft;
        const isEditorOffRight = editorRight > containerRight;
        
        let finalX = adjustedX;
        let finalY = parameterEditor.top || 0;
        
        // Handle horizontal overflow - only move the editor, not the viewport
        if (isEditorOffLeft) {
          const bufferSpace = 20;
          finalX = containerLeft + bufferSpace;
        } else if (isEditorOffRight) {
          const bufferSpace = 20;
          finalX = containerRight - editorRect.width - bufferSpace;
        }
        
        // Handle vertical overflow - move both editor and viewport
        if (isEditorBelowFold) {
          // Calculate how much we need to move up to make it fully visible
          const overflowAmount = editorBottom - containerBottom;
          const bufferSpace = 20; // Add some buffer space
          const totalMoveUp = overflowAmount + bufferSpace;
          
          // Move the parameter editor up
          finalY = finalY - totalMoveUp;
          
          // Also move the viewport up by the same amount
          const currentViewport = viewport.current;
          setViewport({
            x: currentViewport.x,
            y: currentViewport.y - totalMoveUp,
            zoom: currentViewport.zoom
          });
        }
        
        // Update parameter editor position with final calculated values
        parameterEditor = {
          ...parameterEditor,
          left: finalX,
          top: finalY,
        };
      }
    });
  }
  
  // Close parameter editor
  function closeParameterEditor() {
    console.log('closeParameterEditor');
    // Reset delete confirmation state and clear timeout
    deleteConfirmState = false;
    if (deleteTimeout) clearTimeout(deleteTimeout);
    parameterEditor = null;
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

  // Handle add node from dropdown
  function handleAddNode(nodeType: typeof NODE_TYPES[0]) {
    createNode(nodeType);
    showAddNodeDropdown = false;
  }

  // Close dropdown when clicking outside
  function handleAddNodeOutsideClick(event: MouseEvent) {
    if (addNodeDropdownRef && !addNodeDropdownRef.contains(event.target as HTMLElement)) {
      showAddNodeDropdown = false;
    }
  }

  $effect(() => {
    if (showAddNodeDropdown) {
      document.addEventListener('click', handleAddNodeOutsideClick);
    } else {
      document.removeEventListener('click', handleAddNodeOutsideClick);
    }
    
    return () => {
      document.removeEventListener('click', handleAddNodeOutsideClick);
    };
  });

  // Handle edge click to delete edge
  function onEdgeClick(event: any) {
    const edge = event.edge;
    if (!edge) return;
    // Remove the clicked edge from the store
    flowEdges.update(edges => edges.filter(e => e.id !== edge.id));
  }

  // Function to validate connections with buffer constraints
  function isValidConnection(connection: Edge | Connection): boolean {
    return isValidConnectionWithBuffers(connection, $flowNodes, $flowEdges);
  }

  // State for tracking connection attempts
  let connectionAttempt: Connection | null = $state(null);
  let connectionLineColor = $state('#666'); // Default gray
  
  // Handle connection start - track the attempt and store source info
  function handleConnectionStart(event: any) {
    connectionAttempt = {
      source: event.node?.id || '',
      sourceHandle: event.handleId || null,
      target: '',
      targetHandle: null
    };
    connectionLineColor = '#666'; // Start gray
  }
  
  // Handle connection end - clear the attempt
  function handleConnectionEnd() {
    connectionAttempt = null;
    connectionLineColor = '#666'; // Reset to gray
  }
  
  // Handle mouse move to detect when not over connection targets
  function handleFlowMouseMove(event: MouseEvent) {
    // Only care about mouse movement during active connection attempts
    if (!connectionAttempt) return;
    
    // Check if we're over a connection handle
    const elements = document.elementsFromPoint(event.clientX, event.clientY);
    const isOverHandle = elements.some(el => 
      el.classList.contains('svelte-flow__handle') && 
      el.classList.contains('svelte-flow__handle-top') // Only input handles
    );
    
    // If not over a handle, reset to gray
    if (!isOverHandle) {
      connectionLineColor = '#666';
    }
  }
  
  // Enhanced isValidConnection that also updates connection line color
  function isValidConnectionEnhanced(connection: Edge | Connection): boolean {
    const isValid = isValidConnectionWithBuffers(connection, $flowNodes, $flowEdges);
    
    // Only update color if we're actively making a connection
    if (connectionAttempt) {
      if (isValid) {
        connectionLineColor = '#10b981'; // Green for valid
      } else {
        connectionLineColor = '#ef4444'; // Red for invalid
      }
    } else {
      // Not actively connecting, keep gray
      connectionLineColor = '#666';
    }
    
    return isValid;
  }
  
  // Handle successful connections
  function handleConnect(connection: Connection) {
    connectionAttempt = null;
    connectionLineColor = '#666'; // Reset to gray
    
    if (isValidConnectionWithBuffers(connection, $flowNodes, $flowEdges)) {
      // Add the connection to the store with gray styling (original color)
      const newEdge: Edge = {
        id: `e${connection.source}-${connection.target}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        style: 'stroke-width: 3; stroke: #666;', // Gray for connections
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#666'
        }
      };
      
      flowEdges.update(edges => [...edges, newEdge]);
    }
  }
  
  // Ensure existing edges have proper gray styling
  $effect(() => {
    // Update any edges that don't have proper styling
    flowEdges.update(edges => 
      edges.map(edge => ({
        ...edge,
        style: 'stroke-width: 3; stroke: #666;', // Gray for all connections (original color)
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#666'
        }
      }))
    );
  });


</script>

<main>
  <div class="header">
    <h1>🎯 Pattern Editor</h1>
    
    <PatternActions 
      bind:showAddNodeDropdown 
      bind:addNodeDropdownRef 
      {handleAddNode}
      {NODE_TYPES}
    />
  </div>
  
  <!-- PatternSerializationPanel is hidden for now -->
  
  <div class="flow-container" bind:this={flowContainer} bind:clientWidth bind:clientHeight onmousemove={handleFlowMouseMove} role="application">
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
      onnodedragstart={closeParameterEditor}
      onnodedragstop={onNodeDragStop}
      onnodeclick={handleNodeClick}
      onpaneclick={closeParameterEditor}
      onmovestart={closeParameterEditor}
      onedgeclick={onEdgeClick}
      nodesConnectable={true}
      zoomOnDoubleClick={false}
      onconnect={handleConnect}
      onconnectstart={handleConnectionStart}
      onconnectend={handleConnectionEnd}
      isValidConnection={isValidConnectionEnhanced}
      defaultEdgeOptions={{
        type: 'default',
        style: 'stroke-width: 3; stroke: #666;', // Gray for connections (original color)
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#666'
        }
      }}
      connectionLineStyle="stroke-width: 3; stroke: {connectionLineColor};"
    >
      <Background 
        variant={'dots' as any} 
        gap={[150, 5]} 
      />
      
      <!-- Always-rendered Parameter Editor with CSS visibility -->
      {#if activeNode}
        <NodeParameterEditor 
          node={activeNode} 
          nodeElement={document.body}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          visible={showParameterEditor}
          top={parameterEditor?.top}
          left={parameterEditor?.left}
          right={parameterEditor?.right}
          bottom={parameterEditor?.bottom}
          bind:deleteConfirmState
          bind:deleteTimeout
          onClose={closeParameterEditor}
        />
      {/if}
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
