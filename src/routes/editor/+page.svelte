<script lang="ts">
  import { tick, onMount, onDestroy } from 'svelte';
  import { SvelteFlow, Controls, Background, BaseEdge, MarkerType, Position, type Node, type Edge, type Connection, useSvelteFlow, useViewport, getOutgoers } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { flowNodes, flowEdges, nextNodeId, LANES, NODE_TYPES, createNodeFromType, getNodeDefinition, isValidConnectionWithBuffers, initializeDefaultPattern, loadSerializedPattern, isDirty, forceSyncCurrentPattern } from '$lib/flowStore';
  import PatternNode from '$lib/PatternNode.svelte';
  import LaneBackground from '$lib/components/LaneBackground.svelte';
  import NodeParameterEditor from '$lib/components/NodeParameterEditor.svelte';
  import PatternActions from '$lib/components/PatternActions.svelte';
  import { loadPatterns, currentPattern } from '$lib/stores/patternsStore';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  // Hidden for now: import PatternSerializationPanel from '$lib/components/PatternSerializationPanel.svelte';
  
  // Initialize patterns on mount
  onMount(() => {
    (async () => {
      try {
        await loadPatterns();
        // Load the current pattern into the flow editor
        const current = $currentPattern;
        if (current) {
          await loadSerializedPattern(current);
        } else {
          // Fallback to default pattern
          initializeDefaultPattern();
        }
        
        // Force sync the loaded pattern to connected devices
        forceSyncCurrentPattern();
      } catch (error) {
        console.error('Failed to load patterns:', error);
        // Fallback to default pattern on error
        initializeDefaultPattern();
        // Still try to sync the default pattern
        forceSyncCurrentPattern();
      }
    })();
    
    // Add beforeunload handler to warn about unsaved changes
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if ($isDirty) {
        const message = 'You have unsaved changes to your pattern. Are you sure you want to leave?';
        event.preventDefault();
        event.returnValue = message;
        return message;
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
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
    caretX?: number;   // node centre X (screen px) — the popover draws a caret pointing here
    caretY?: number;   // node centre Y (screen px), for side placements
    caretSide?: 'top' | 'bottom' | 'left' | 'right'; // direction the caret points at the node
    maxHeight?: number; // free vertical space the editor allotted for the popover on its chosen side
  } | null = $state(null);
  let caretVp: string | null = null; // viewport signature when the caret was placed (to detect pans)
  let caretArmed = false;            // false during the placement-scroll settle, so it isn't mistaken for a pan
  let caretArmTimer: ReturnType<typeof setTimeout> | null = null;
  let clientWidth: number = $state(0);
  let clientHeight: number = $state(0);
  let flowContainer: HTMLDivElement;
  
  // Editor cleanup state - managed here so external closures can reset it
  let deleteConfirmState = $state(false);
  let deleteTimeout: ReturnType<typeof setTimeout> | undefined = $state(undefined);
  
  // Add Pattern Node dropdown state
  let showAddNodeDropdown = $state(false);
  let addNodeDropdownRef = $state<HTMLDivElement>();
  
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

    // After it renders: pick the BEST of four placements (below / above / right / left) — the one
    // needing the least viewport scroll to show both the node and the popover — then scroll only if
    // needed and point a caret at the node. Wide canvases prefer the sides (node stays put); narrow
    // ones prefer above/below. This avoids the constant scroll-to-fit the old below-only anchor did.
    tick().then(() => {
      const el = document.querySelector('.parameter-popover') as HTMLElement;
      if (!el || !parameterEditor || !flowContainer) return;
      const er = el.getBoundingClientRect();
      const c = flowContainer.getBoundingClientRect();
      const nr = nodeElement.getBoundingClientRect();
      const pw = er.width, ph = er.height, GAP = 12, M = 8;
      const availTop = c.top + M, availBot = c.bottom - M, availL = c.left + M, availR = c.right - M;
      const colH = availBot - availTop;
      const wide = c.width > 700;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

      const nodeH = nr.height, nCx = nr.left + nr.width / 2;
      const potentialVert = colH - nodeH - GAP;   // most room above/below can get by scrolling the node to the edge

      // 1. Choose the side. Above/below can earn nearly the whole column by scrolling the node to
      //    the edge, so they "fit" whenever that column is usable; sides need horizontal room now.
      const cands = [
        { side: 'below', caret: 'top',    fits: potentialVert >= 150 },
        { side: 'above', caret: 'bottom', fits: potentialVert >= 150 },
        { side: 'right', caret: 'left',   fits: (availR - (nr.right + GAP)) >= pw },
        { side: 'left',  caret: 'right',  fits: ((nr.left - GAP) - availL) >= pw },
      ];
      const rank: Record<string, number> = wide
        ? { right: 0, left: 1, below: 2, above: 3 }
        : { below: 0, above: 1, right: 2, left: 3 };
      let best: any = null;
      for (const k of cands) {
        const score = (k.fits ? 0 : 1000) + rank[k.side];
        if (!best || score < best.score) best = k;
      }

      // 2. Scroll + geometry for the chosen side. For above/below, scroll the node toward that edge
      //    only as much as the content needs (capped at the node reaching the edge), maximizing the
      //    popover's room; sides just scroll enough to keep the node visible (they use the column).
      let scroll = 0, maxH = colH, fx = 0, fy = 0;
      if (best.side === 'below') {
        const room0 = availBot - (nr.bottom + GAP);
        const need = Math.max(0, Math.min(ph, potentialVert) - room0);
        scroll = nr.top < availTop ? nr.top - availTop : Math.min(need, Math.max(0, nr.top - availTop));
        const nBot = nr.bottom - scroll;
        maxH = availBot - (nBot + GAP);
        fy = nBot + GAP;
        fx = clamp(nCx - pw / 2, availL, availR - pw);
      } else if (best.side === 'above') {
        const room0 = (nr.top - GAP) - availTop;
        const need = Math.max(0, Math.min(ph, potentialVert) - room0);
        scroll = nr.bottom > availBot ? nr.bottom - availBot : -Math.min(need, Math.max(0, availBot - nr.bottom));
        const nTop = nr.top - scroll;
        maxH = (nTop - GAP) - availTop;
        fy = (nTop - GAP) - Math.min(ph, Math.max(160, maxH));
        fx = clamp(nCx - pw / 2, availL, availR - pw);
      } else {
        scroll = nr.top < availTop ? nr.top - availTop : (nr.bottom > availBot ? nr.bottom - availBot : 0);
        const nTop = nr.top - scroll;
        maxH = colH;
        fy = clamp(nTop, availTop, availBot - Math.min(ph, maxH));
        fx = best.side === 'right' ? nr.right + GAP : nr.left - GAP - pw;
      }
      maxH = Math.max(160, Math.floor(maxH));
      const nCy = (nr.top + nr.height / 2) - scroll;

      // Apply the scroll, and remember the viewport for pan-detection (compare to the post-scroll
      // target so our own scroll doesn't read as a pan).
      const vp0 = viewport.current;
      const targetY = vp0.y - scroll;
      if (Math.abs(scroll) > 4) setViewport({ x: vp0.x, y: targetY, zoom: vp0.zoom });
      caretVp = `${Math.round(vp0.x)},${Math.round(targetY)},${vp0.zoom}`;
      caretArmed = false;
      if (caretArmTimer) clearTimeout(caretArmTimer);
      caretArmTimer = setTimeout(() => { caretArmed = true; }, 450);

      parameterEditor = {
        ...parameterEditor,
        left: fx, top: fy, maxHeight: maxH,
        caretSide: best.caret, caretX: nCx, caretY: nCy,
      };
    });
  }

  // The popover is position:fixed, so once the canvas pans/zooms or a node is dragged, the caret no
  // longer lines up with the node. Drop the caret (keep the popover open) instead of leaving a
  // stale pointer.
  function dropCaret() {
    if (parameterEditor && parameterEditor.caretSide) {
      parameterEditor = { ...parameterEditor, caretSide: undefined };
    }
  }

  // Pan/zoom the canvas → the node moves under the fixed popover, so drop the caret. (Node DRAG is
  // handled separately via onnodedragstart, since dragging a node doesn't change the viewport.)
  $effect(() => {
    const v = viewport.current;
    if (!v || !parameterEditor?.caretSide) return;
    const key = `${Math.round(v.x)},${Math.round(v.y)},${v.zoom}`;
    if (!caretArmed) { caretVp = key; return; } // settle window: follow the viewport, don't drop
    if (key !== caretVp) dropCaret();
  });
  
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
    <h1>Pattern Editor</h1>

    <button class="interact-btn" title="Interact with this pattern" aria-label="Interact" onclick={() => goto(`${base}/interact`)}>🎛️</button>

    <PatternActions
      bind:showAddNodeDropdown 
      bind:addNodeDropdownRef 
      {handleAddNode}
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
      onnodedragstart={dropCaret}
      onnodedragstop={onNodeDragStop}
      onnodeclick={handleNodeClick}
      onpaneclick={closeParameterEditor}
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
      <!-- Plain, symmetric dot grid for spatial reference (the old gap=[150,5] drew
           vertical dotted lines that read as extra swim lanes). -->
      <Background
        variant={'dots' as any}
        gap={18}
        size={1}
      />
      <!-- Red/green/blue tints marking the 3 real lanes (output buffers 0/1/2). -->
      <LaneBackground {viewport} />
      
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
          caretX={parameterEditor?.caretX}
          caretY={parameterEditor?.caretY}
          caretSide={parameterEditor?.caretSide}
          maxHeight={parameterEditor?.maxHeight}
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

  /* Jump to the Interact page for the current pattern (mirrors the 🎛️ on Patterns). */
  .interact-btn {
    position: absolute;
    left: 0;
    top: 0;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    font-size: 1.3rem;
    line-height: 1;
    padding: 8px 12px;
    cursor: pointer;
  }
  .interact-btn:hover { background: rgba(0, 0, 0, 0.5); }

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
  }
  
  @media (max-width: 480px) {
    .header h1 {
      font-size: 1.75rem;
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
