/**
 * Pattern Serialization Module
 *
 * This module provides utilities for serializing and deserializing node-based LED patterns
 * for transmission to ESP32 devices via BLE. It handles topological sorting of nodes to ensure
 * proper execution order, buffer assignment, and compact representation.
 */

import type { Node, Edge } from '@xyflow/svelte';
import {
  getNodeDefinition,
  type NodeDefinition,
  NODE_TYPES,
  createNodeFromType,
  LANES,
  type Parameter,
  getNodeBuffer
} from './flowStore';
import { interactiveParameters, setParameterInteractive } from './stores/interactiveStore';
import { get } from 'svelte/store';

/**
 * Compact representation of a node in the serialized pattern
 * Uses short keys to minimize JSON size for BLE transmission
 */
export interface SerializedNode {
  /** Node type identifier (e.g. 'rainbow', 'gradient') */
  t: string;

  /** Node parameters as key-value pairs. Only non-default values are stored. */
  p?: Record<string, any>;

  /** Input buffer index (where this node reads from) */
  i?: number;

  /** Output buffer index (where this node writes to) */
  o: number;

  /** Second input buffer index (only for blend nodes) */
  i2?: number;

  /** Interactive parameters - parameter names that should have knobs on interact page */
  x?: Record<string, number>;
}

/**
 * Complete serialized pattern format
 */
export interface SerializedPattern {
  /** Array of nodes in execution order (excluding the final 'output' node) */
  nodes: SerializedNode[];

  /** Metadata about the pattern */
  meta: {
    name?: string;
    /** The buffer index that the ESP32 should treat as the final output for display */
    output: number;
  };
}

interface SortResult {
  orderedNodes: Node[]; // All nodes, including output, in execution order
}

// Constants for deserialization layout
const NODE_HEIGHT = 50; // Standard node height
const VERTICAL_SPACING = 70; // Increased spacing for clearer visualization

/**
 * Determines which lane a node is in based on its x position
 * @param node - The node to check
 * @returns The buffer index (0, 1, or 2) corresponding to the lane
 */
function getNodeLaneBuffer(node: Node): number {
  // Get closest lane
  const x = node.position.x;
  const laneValues = [LANES.LEFT, LANES.CENTER, LANES.RIGHT];
  
  // Find the closest lane
  const closestLane = laneValues.reduce((closest, lane) => 
    Math.abs(x - lane) < Math.abs(x - closest) ? lane : closest, laneValues[0]);
  
  // Map lane to buffer index
  if (closestLane === LANES.LEFT) return 0;
  if (closestLane === LANES.CENTER) return 1;
  return 2; // RIGHT lane
}

/**
 * Get lane X position from buffer index
 * @param bufferIndex - The buffer index (0, 1, or 2)
 * @returns The X position for the corresponding lane
 */
function getLaneFromBuffer(bufferIndex: number): number {
  // Ensure bufferIndex is a valid number
  if (!Number.isFinite(bufferIndex) || Number.isNaN(bufferIndex)) {
    console.warn(`⚠️ Invalid buffer index: ${bufferIndex}, defaulting to center lane`);
    return LANES.CENTER;
  }
  
  if (bufferIndex === 0) return LANES.LEFT;
  if (bufferIndex === 1) return LANES.CENTER;
  return LANES.RIGHT;
}

/**
 * Performs a topological sort on the nodes to determine execution order.
 * 
 * @param nodes - The nodes in the pattern
 * @param edges - The edges connecting the nodes
 * @returns Object containing ordered nodes
 */
function topologicalSort(nodes: Node[], edges: Edge[]): SortResult {
  // Build adjacency + indegree
  const graph: Map<string, string[]> = new Map();
  const inDeg: Map<string, number> = new Map();
  nodes.forEach(n => {
    graph.set(n.id, []);
    inDeg.set(n.id, 0);
  });
  edges.forEach(e => {
    graph.get(e.source)?.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  });

  // Kahn queue seeded with zero-indegree nodes (keep original insertion order)
  const queue: string[] = nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0).map(n => n.id);
  const orderedNodeIds: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    orderedNodeIds.push(nodeId);

    for (const dependentId of graph.get(nodeId) || []) {
      inDeg.set(dependentId, (inDeg.get(dependentId) ?? 0) - 1);
      if ((inDeg.get(dependentId) ?? 0) === 0) {
        queue.push(dependentId);
      }
    }
  }

  if (orderedNodeIds.length !== nodes.length) {
    console.warn('Cycle detected or disconnected nodes. Serialization might be affected.');
    nodes.forEach(node => {
      if (!orderedNodeIds.includes(node.id)) {
        orderedNodeIds.push(node.id); // Add unreached nodes, order might be arbitrary
      }
    });
  }

  const orderedNodes = orderedNodeIds.map(id => nodes.find(node => node.id === id)!);

  /* ------------------------------------------------------------------
   * SECOND PASS — DETERMINISTIC GENERATOR PLACEMENT
   *
   * Generators (nodes with no incoming edges) can safely be executed at
   * any time before their first consumer.  To guarantee buffers are not
   * overwritten too early we move every generator **immediately before**
   * its earliest consumer in the current order.
   * ------------------------------------------------------------------ */
  const idToIndex = new Map<string, number>();
  orderedNodes.forEach((n, idx) => idToIndex.set(n.id, idx));

  const isGenerator = (n: Node) => !edges.some(e => e.target === n.id);

  // Build generator → earliest consumer index map
  const genConsumers: { node: Node; consumerIdx: number }[] = [];
  edges.forEach(e => {
    const src = orderedNodes[idToIndex.get(e.source)!];
    if (!isGenerator(src)) return;
    const tgtIdx = idToIndex.get(e.target)!;
    const existing = genConsumers.find(gc => gc.node.id === src.id);
    if (!existing || tgtIdx < existing.consumerIdx) {
      if (existing) existing.consumerIdx = tgtIdx;
      else genConsumers.push({ node: src, consumerIdx: tgtIdx });
    }
  });

  // Sort generators by earliest consumer so moves are stable front-to-back
  genConsumers.sort((a, b) => a.consumerIdx - b.consumerIdx);

  genConsumers.forEach(({ node, consumerIdx }) => {
    let curIdx = idToIndex.get(node.id)!;
    const desiredPos = consumerIdx - 1; // right before consumer
    if (curIdx >= desiredPos) return;   // already late enough

    // Remove and reinsert
    orderedNodes.splice(curIdx, 1);
    orderedNodes.splice(desiredPos, 0, node);

    // Re-index map after move
    orderedNodes.forEach((n, i) => idToIndex.set(n.id, i));
  });

  return { orderedNodes };
}

/**
 * Serializes a pattern graph into a compact format suitable for BLE transmission.
 * 
 * @param allNodes - All nodes in the pattern
 * @param allEdges - All edges connecting the nodes
 * @param currentNodeParameters - Map of node parameters
 * @param patternName - Optional name for the pattern
 * @returns Serialized pattern object
 */
export function serializePattern(
  allNodes: Node[],
  allEdges: Edge[],
  currentNodeParameters: Map<string, Map<string, any>>, // Actual parameters from the Svelte store
  patternName?: string
): SerializedPattern {
  // Step 1: Sort nodes topologically to determine execution order
  const { orderedNodes: orderedNodesFullGraph } = topologicalSort(allNodes, allEdges);

  /**
   * Helper – does this node write back to one of the buffers it reads?
   * If so, it may clobber the buffer for other consumers and therefore
   * should be executed AFTER nodes that merely read that buffer.
   */
  const overwritesRead = (n: Node): boolean => {
    const def = getNodeDefinition(n.data.type as string);
    if (!def) return false;
    const outBuf = getNodeLaneBuffer(n);

    // Find incoming edges to discover buffers consumed
    const incoming = allEdges.filter(e => e.target === n.id);

    /* ------------------------------------------------------------------
     * A node that has **no incoming edges** is a generator.  Generators
     * never overwrite a buffer they read from because they do not read
     * anything at all, so we can return early.
     * ------------------------------------------------------------------ */
    if (incoming.length === 0) return false;

    // Single-input node
    if (n.data.type !== 'blend') {
      const srcNode = allNodes.find(nd => nd.id === incoming[0].source);
      return srcNode ? getNodeLaneBuffer(srcNode) === outBuf : false;
    }

    // Blend node – two inputs
    const src1 = incoming.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
    const src2 = incoming.find(e => e.targetHandle === 'input-2');
    const buf1 = src1 ? getNodeLaneBuffer(allNodes.find(nd => nd.id === src1.source)!) : undefined;
    const buf2 = src2 ? getNodeLaneBuffer(allNodes.find(nd => nd.id === src2.source)!) : undefined;
    return buf1 === outBuf || buf2 === outBuf;
  };

  /**
   * Re-order nodes that share the same dependency level so that
   * buffer-overwriters execute after non-overwriters.
   * We rely on the fact that Array.sort in V8 is stable.
   */
  const reorderForBufferConflicts = (nodes: Node[]): Node[] => {
    return nodes
      .map((n, idx) => ({
        n,
        priority: overwritesRead(n) ? 1 : 0,
        idx
      }))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority; // non-overwriter first
        return a.idx - b.idx; // keep original order (stable)
      })
      .map(v => v.n);
  };

  /* ------------------------------------------------------------------
   * The topological sort above already respects real data dependencies.
   * Extra re-ordering for "buffer overwrite" was too aggressive and
   * broke valid dependency chains (e.g. putting a blend before the
   * Raindrops node it actually needs).  We bring it back in a *scoped*
   * manner: nodes are only re-ordered **within the same dependency
   * level** so true dependencies are never violated.
   * ------------------------------------------------------------------ */

  /* --- 1. compute dependency level for every node ------------------ */
  const levelMap = new Map<string, number>();        // nodeId -> level
  const indegTmp = new Map<string, number>();
  allNodes.forEach(n => indegTmp.set(n.id, 0));
  allEdges.forEach(e => indegTmp.set(e.target, (indegTmp.get(e.target) ?? 0) + 1));

  const q: string[] = [];
  indegTmp.forEach((v, id) => { if (v === 0) { q.push(id); levelMap.set(id, 0);} });
  while (q.length) {
    const id = q.shift()!;
    const lvl = levelMap.get(id)!;
    allEdges
      .filter(e => e.source === id)
      .forEach(e => {
        const next = e.target;
        const newLvl = lvl + 1;
        // keep max level reached
        levelMap.set(next, Math.max(levelMap.get(next) ?? 0, newLvl));
        indegTmp.set(next, (indegTmp.get(next) ?? 0) - 1);
        if (indegTmp.get(next) === 0) q.push(next);
      });
  }

  /* --- 2. apply reader-first ordering WITHIN each level, in place -----
   *
   * `orderedNodesFullGraph` already places each generator immediately before
   * its earliest consumer (see topologicalSort's second pass).  That placement
   * is essential: when two nodes write the *same* buffer (e.g. two generators
   * both feeding buffer 1), the deserializer resolves each consumer's input to
   * the **nearest preceding writer** of that buffer, so a writer must stay next
   * to the consumer it feeds.  Collapsing nodes into strict level-order would
   * hoist every generator to the front and let one same-buffer writer shadow
   * another — silently rewiring the graph on round-trip.
   *
   * So we keep the topo order as the backbone and only reorder nodes **among
   * the slots their own level already occupies**: within a level we still put
   * pure readers ahead of in-place overwriters of the same buffer, but we never
   * move a node across levels (which would undo generator placement). For
   * simple patterns where the topo order already equals level order this is
   * identical to the previous behaviour.
   * ------------------------------------------------------------------ */
  const positionsByLevel = new Map<number, number[]>();
  orderedNodesFullGraph.forEach((n, pos) => {
    const lvl = levelMap.get(n.id) ?? 0;
    if (!positionsByLevel.has(lvl)) positionsByLevel.set(lvl, []);
    positionsByLevel.get(lvl)!.push(pos);
  });

  const conflictSafeOrder: Node[] = [...orderedNodesFullGraph];
  positionsByLevel.forEach((positions) => {
    const group = positions.map(pos => orderedNodesFullGraph[pos]);

    // Only reorder when this level mixes readers and in-place overwriters;
    // otherwise preserve the topo order (e.g. all generators) untouched.
    const hasWriter = group.some(overwritesRead);
    const hasReader = group.some(n => !overwritesRead(n));
    if (!hasWriter || !hasReader) return;

    const orderedGroup = group
      .map((n, idx) => ({ n, priority: overwritesRead(n) ? 1 : 0, idx }))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority; // readers first
        return a.idx - b.idx; // stable for same priority
      })
      .map(v => v.n);

    // Write the reordered group back into the exact slots this level occupied,
    // leaving every other level's position (and generator placement) intact.
    positions.forEach((pos, i) => { conflictSafeOrder[pos] = orderedGroup[i]; });
  });
  
  // Step 2: Find output node and determine final output buffer
  let finalOutputBufferIndex = 0; // Default output buffer
  const outputNode = allNodes.find(n => n.data.type === 'output');
  
  if (outputNode) {
    const inputEdgesToOutputNode = allEdges.filter(edge => edge.target === outputNode.id);
    if (inputEdgesToOutputNode.length > 0) {
      const sourceNodeId = inputEdgesToOutputNode[0].source;
      const sourceNode = allNodes.find(n => n.id === sourceNodeId);
      if (sourceNode) {
        finalOutputBufferIndex = getNodeLaneBuffer(sourceNode);
      }
    }
  }
  
  // Step 3: Filter out output node for serialization
  const nodesToSerialize = conflictSafeOrder.filter(node => node.data.type !== 'output');
  
  // Get interactive parameters once before serialization
  const currentInteractiveParams = get(interactiveParameters);

  // Step 4: Create serialized nodes with lane-based buffer assignment
  const serializedNodes: SerializedNode[] = nodesToSerialize.map((node) => {
    const nodeDefinition = getNodeDefinition(node.data.type as string);
    if (!nodeDefinition) {
      console.error(`FATAL: No definition for node type ${node.data.type} during serialization.`);
      return null;
    }
    
    // Determine output buffer based on node lane
    const outputBuffer = getNodeLaneBuffer(node);
    
    // Extract parameters that differ from defaults
    const params: Record<string, any> = {};
    const actualNodeParamsMap = currentNodeParameters.get(node.id);
    
    if (actualNodeParamsMap && nodeDefinition.params) {
      nodeDefinition.params.forEach((paramDef: Parameter) => {
        const actualValue = actualNodeParamsMap.get(paramDef.name);
        // Only store if value exists and is different from default
        if (actualValue !== undefined && actualValue !== paramDef.default) {
          params[paramDef.name] = actualValue;
        }
      });
    }
    
    // Create serialized node with output buffer
    const serializedNode: SerializedNode = {
      t: node.data.type as string,
      o: outputBuffer
    };
    
    // Find input buffer(s)
    const inputEdges = allEdges.filter(edge => edge.target === node.id);
    if (inputEdges.length > 0) {
      // For blend nodes, handle dual inputs
      if (node.data.type === 'blend') {
        const input1Edge = inputEdges.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
        const input2Edge = inputEdges.find(e => e.targetHandle === 'input-2');
        
        if (input1Edge) {
          const input1Node = allNodes.find(n => n.id === input1Edge.source);
          if (input1Node) {
            serializedNode.i = getNodeLaneBuffer(input1Node);
          }
        }
        
        if (input2Edge) {
          const input2Node = allNodes.find(n => n.id === input2Edge.source);
          if (input2Node) {
            serializedNode.i2 = getNodeLaneBuffer(input2Node);
          }
        }
      } else {
        // For regular nodes, just one input
        const inputEdge = inputEdges[0];
        const inputNode = allNodes.find(n => n.id === inputEdge.source);
        if (inputNode) {
          serializedNode.i = getNodeLaneBuffer(inputNode);
        }
      }
    }
    
    // Add parameters if any
    if (Object.keys(params).length > 0) {
      serializedNode.p = params;
    }
    
    // Add interactive parameters if any
    const nodeInteractiveParams = currentInteractiveParams.get(node.id);
    if (nodeInteractiveParams) {
      const interactiveFlags: Record<string, number> = {};
      let order = 0;
      
      for (const [paramName, isInteractive] of nodeInteractiveParams.entries()) {
        if (isInteractive) {
          interactiveFlags[paramName] = order++;
        }
      }
      
      if (Object.keys(interactiveFlags).length > 0) {
        serializedNode.x = interactiveFlags;
      }
    }
    
    return serializedNode;
  }).filter(Boolean) as SerializedNode[];
  
  return {
    nodes: serializedNodes,
    meta: {
      name: patternName,
      output: finalOutputBufferIndex,
    },
  };
}

/**
 * Finds the source node index for a given target node and input buffer
 * @param serializedNodes - All serialized nodes
 * @param targetIndex - Index of the target node
 * @param inputBuffer - Input buffer index to find source for
 * @returns Index of the source node, or undefined if not found
 */
function findSourceNodeIndex(
  serializedNodes: SerializedNode[],
  targetIndex: number,
  inputBuffer: number
): number | undefined {
  // Look backwards through nodes to find the LAST node BEFORE the current node that outputs to this buffer
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (serializedNodes[i].o === inputBuffer) {
      return i;
    }
  }
  return undefined;
}

/**
 * Calculates dependency levels for nodes based on input/output relationships
 * @param serializedNodes - The serialized nodes
 * @returns Map of node index to its dependency level (0 = no dependencies)
 */
function calculateDependencyLevels(
  serializedNodes: SerializedNode[]
): Map<number, number> {
  // Build dependency graph: nodeIndex -> list of indices it depends on
  const dependencies = new Map<number, number[]>();
  
  // For each node, find its dependencies based on input buffers
  serializedNodes.forEach((node, nodeIndex) => {
    const nodeDeps: number[] = [];
    
    // Find primary input dependency
    if (node.i !== undefined) {
      const sourceIndex = findSourceNodeIndex(serializedNodes, nodeIndex, node.i);
      if (sourceIndex !== undefined) {
        nodeDeps.push(sourceIndex);
      }
    }
    
    // Find secondary input dependency (for blend nodes)
    if (node.i2 !== undefined) {
      const sourceIndex = findSourceNodeIndex(serializedNodes, nodeIndex, node.i2);
      if (sourceIndex !== undefined && !nodeDeps.includes(sourceIndex)) {
        nodeDeps.push(sourceIndex);
      }
    }
    
    dependencies.set(nodeIndex, nodeDeps);
  });
  
  // Calculate levels using BFS
  const levels = new Map<number, number>();
  const visited = new Set<number>();
  const queue: { index: number, level: number }[] = [];
  
  // Start with nodes that have no dependencies
  serializedNodes.forEach((_, index) => {
    const deps = dependencies.get(index) || [];
    if (deps.length === 0) {
      queue.push({ index, level: 0 });
      visited.add(index);
    }
  });
  
  // Process queue
  while (queue.length > 0) {
    const { index, level } = queue.shift()!;
    levels.set(index, level);
    
    // Find nodes that depend on this one
    serializedNodes.forEach((_, depIndex) => {
      const deps = dependencies.get(depIndex) || [];
      if (deps.includes(index) && !visited.has(depIndex)) {
        // Calculate max level of all dependencies
        const depLevel = Math.max(
          level + 1,
          ...deps
            .filter(d => levels.has(d))
            .map(d => levels.get(d)! + 1)
        );
        
        // Only add to queue if all dependencies have been processed
        const allDepsProcessed = deps.every(d => levels.has(d));
        if (allDepsProcessed) {
          queue.push({ index: depIndex, level: depLevel });
          visited.add(depIndex);
        }
      }
    });
  }
  
  // Handle any remaining nodes (cycles or disconnected)
  serializedNodes.forEach((_, index) => {
    if (!levels.has(index)) {
      levels.set(index, 0); // Default to level 0 for disconnected nodes
    }
  });
  
  // Validate dependency levels
  for (const [index, level] of levels.entries()) {
    if (Number.isNaN(level)) {
      console.error(`❌ NaN level detected for node index ${index}!`);
      levels.set(index, 0); // Fix with fallback level
    }
  }
  
  return levels;
}

/**
 * Deserializes a pattern from the compact format back into nodes and edges.
 * 
 * @param serializedPattern - The serialized pattern
 * @returns Object containing reconstructed nodes, edges, and parameters
 */
export interface DeserializeOptions {
  /**
   * Whether to apply this pattern's interactive-parameter flags to the GLOBAL
   * interactiveParameters store. True for the real editor/interact load; MUST be
   * false for isolated previews (patterns page), which otherwise clear+rewrite
   * the shared store keyed to their own node IDs and trigger an autosave that
   * strips the live pattern's interactive flags.
   */
  applyInteractiveParameters?: boolean;
}

export function deserializePattern(
  serializedPattern: SerializedPattern,
  options: DeserializeOptions = {}
): { nodes: Node[]; edges: Edge[]; nodeParameters: Map<string, Map<string, any>> } {
  const applyInteractiveParameters = options.applyInteractiveParameters ?? true;

  // Clear existing interactive parameters before loading new pattern (global load only)
  if (applyInteractiveParameters) {
    interactiveParameters.set(new Map());
  }
  const svelteFlowNodes: Node[] = [];
  const svelteFlowEdges: Edge[] = [];
  const newNodeParameters = new Map<string, Map<string, any>>();
  
  // Handle edge case: empty patterns
  if (!serializedPattern.nodes || serializedPattern.nodes.length === 0) {
    return { nodes: [], edges: [], nodeParameters: newNodeParameters };
  }
  
  // Step 1: Calculate dependency levels for proper vertical positioning
  const dependencyLevels = calculateDependencyLevels(serializedPattern.nodes);
  // Track every occupied (lane, row) slot so no two nodes ever land on top of each
  // other. IMPORTANT: a node's X is its output-buffer lane (the serializer reads
  // position.x to recover the buffer), so we must NOT move nodes sideways to avoid
  // overlap — that would silently reassign their buffer. Instead, when a lane+row is
  // taken (e.g. two generators both writing buffer 0, or a stacked node landing on a
  // genuine next-level node), we push DOWN to the next free row in the same lane. Y
  // isn't used by serialization, so this is purely cosmetic. Key: `${laneX}:${row}`.
  const occupiedSlots = new Set<string>();
  const placeRow = (laneX: number, level: number): number => {
    let row = level;
    while (occupiedSlots.has(`${laneX}:${row}`)) row++;
    occupiedSlots.add(`${laneX}:${row}`);
    return 50 + row * (NODE_HEIGHT + VERTICAL_SPACING);
  };

  // Maps each ORIGINAL serialized-node index to the SvelteFlow node created for
  // it. Unknown node types are skipped (not pushed), so positional indices into
  // svelteFlowNodes no longer line up with serializedPattern.nodes once anything
  // is skipped. Edge reconstruction must resolve nodes through this map, not by
  // positional index, or edges get wired to the wrong nodes.
  const indexToNode = new Map<number, Node>();

  // Step 2: Create nodes based on serialized data
  serializedPattern.nodes.forEach((sNode, index) => {
    const nodeDefinition = getNodeDefinition(sNode.t);
    if (!nodeDefinition) {
      console.warn(`Unknown node type during deserialization: ${sNode.t}`);
      console.warn('Available node types:', NODE_TYPES.map(nt => nt.type));
      console.warn('This might be due to WASM operators not being loaded yet. Consider retrying after WASM is ready.');
      return;
    }
    
    const nodeId = `deserialized_${sNode.t}_${Date.now()}_${index}`;
    
    // Position node by output-buffer lane (x) and dependency level (y). X is the lane
    // for the node's output buffer and must stay exact. If that lane+row is already
    // taken, placeRow pushes this node down to the next free row in the same lane so
    // it never overlaps another node (and never sideways into a different buffer).
    const level = dependencyLevels.get(index) || 0;
    let rawXPos = getLaneFromBuffer(sNode.o);
    let rawYPos = placeRow(rawXPos, level);

    // Validate and fix position calculations
    if (Number.isNaN(rawXPos) || Number.isNaN(rawYPos)) {
      console.error(`❌ NaN detected in node positions! sNode.o=${sNode.o}, level=${level}, xPos=${rawXPos}, yPos=${rawYPos}`);
      console.error('Node data:', sNode);
      
      // Fallback to safe default positions to prevent SVG errors
      rawXPos = Number.isNaN(rawXPos) ? 175 : rawXPos; // Default to center lane
      rawYPos = Number.isNaN(rawYPos) ? 50 : rawYPos;  // Default to top level
      console.warn(`🛟 Using fallback positions: x=${rawXPos}, y=${rawYPos}`);
    }
    
    // Ensure positions are valid numbers before creating node
    const safeX = Number.isFinite(rawXPos) ? rawXPos : 175;
    const safeY = Number.isFinite(rawYPos) ? rawYPos : 50;
    
    // Create node
    const newNode = createNodeFromType(nodeDefinition, nodeId, { x: safeX, y: safeY });
    
    // Set parameters
    const currentParamsForNode = new Map<string, any>();
    nodeDefinition.params.forEach(paramDef => {
      // Start with defaults
      currentParamsForNode.set(paramDef.name, paramDef.default);
    });
    
    // Override with serialized values - handle parameter conversion for WASM compatibility
    if (sNode.p) {
      for (const paramName in sNode.p) {
        const paramDef = nodeDefinition.params.find(p => p.name === paramName);
        if (paramDef) {
          let value = sNode.p[paramName];
          
          // Handle parameter type conversions for WASM compatibility
          if (paramDef.type === 'range' && typeof value === 'boolean') {
            // Convert boolean to range value for WASM bool parameters
            value = value ? 1 : 0;
          } else if (paramDef.type === 'integer' && typeof value === 'string') {
            // Convert string to integer
            value = parseInt(value) || paramDef.default;
          } else if (paramDef.type === 'float' && typeof value === 'string') {
            // Convert string to float
            value = parseFloat(value) || paramDef.default;
          }
          
          currentParamsForNode.set(paramName, value);
        } else {
          console.warn(`Node type ${sNode.t} has serialized param ${paramName} not in its definition.`);
        }
      }
    }
    
    // Store parameters
    newNodeParameters.set(nodeId, currentParamsForNode);
    
    // Restore interactive parameters (global load only; previews must not touch
    // the shared interactiveParameters store).
    if (sNode.x && applyInteractiveParameters) {
      for (const paramName in sNode.x) {
        setParameterInteractive(nodeId, paramName, true);
      }
    }
    
    // For visual consistency in PatternNode if it reads data.parameters directly
    newNode.data.parameters = Object.fromEntries(currentParamsForNode.entries());
    
    // Add node to collection, keyed by its original serialized index
    svelteFlowNodes.push(newNode);
    indexToNode.set(index, newNode);
  });
  
  // Step 3: Create edges based on input/output buffer relationships
  serializedPattern.nodes.forEach((sNode, targetIndex) => {
    // Resolve the target node by its original index. If it was skipped (unknown
    // type), there is no node to wire to.
    const targetNode = indexToNode.get(targetIndex);
    if (!targetNode) return;

    const targetNodeId = targetNode.id;

    // Create edge for primary input
    if (sNode.i !== undefined) {
      // Find the source node by looking backwards for the most recent node that outputs to this buffer
      const sourceIndex = findSourceNodeIndex(serializedPattern.nodes, targetIndex, sNode.i);
      const sourceNode = sourceIndex !== undefined ? indexToNode.get(sourceIndex) : undefined;

      if (sourceNode) {
        const sourceNodeId = sourceNode.id;
        svelteFlowEdges.push({
          id: `e_${sourceNodeId}_${targetNodeId}_i1_${Date.now()}`,
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: 'output',
          targetHandle: (sNode.t === 'blend') ? 'input-1' : 'input',
        });
      }
    }

    // Create edge for secondary input (blend nodes only)
    if (sNode.t === 'blend' && sNode.i2 !== undefined) {
      // Find the source node by looking backwards for the most recent node that outputs to this buffer
      const sourceIndex = findSourceNodeIndex(serializedPattern.nodes, targetIndex, sNode.i2);
      const sourceNode = sourceIndex !== undefined ? indexToNode.get(sourceIndex) : undefined;

      if (sourceNode) {
        const sourceNodeId = sourceNode.id;
        svelteFlowEdges.push({
          id: `e_${sourceNodeId}_${targetNodeId}_i2_${Date.now()}`,
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: 'output',
          targetHandle: 'input-2',
        });
      }
    }
  });
  
  // Step 4: Add output node
  const outputDef = getNodeDefinition('output');
  if (outputDef) {
    const outputNodeId = `deserialized_output_${Date.now()}`;
    
    // Find the maximum dependency level to place output node at the bottom
    const maxLevel = Math.max(...Array.from(dependencyLevels.values())) + 1;
    
    // Find the correct lane for the output node based on the final output buffer
    const finalOutputBuffer = serializedPattern.meta?.output !== undefined ? serializedPattern.meta.output : 0;
    
    // Position output node in the same lane as the final output buffer (pushed to a
    // free row if needed, same as every other node).
    const outputX = getLaneFromBuffer(finalOutputBuffer);
    const outputNode = createNodeFromType(outputDef, outputNodeId, {
      x: outputX,
      y: placeRow(outputX, maxLevel)
    });
    
    // Add output node parameters (none for output node)
    newNodeParameters.set(outputNodeId, new Map());
    
    // Add output node
    svelteFlowNodes.push(outputNode);
    
    // Find the node that outputs to the final output buffer
    
    // Find the last node that writes to this buffer
    let sourceForOutput: string | undefined;
    for (let i = serializedPattern.nodes.length - 1; i >= 0; i--) {
      const node = serializedPattern.nodes[i];
      const created = indexToNode.get(i); // skip unknown/uncreated nodes
      if (node.o === finalOutputBuffer && created) {
        sourceForOutput = created.id;
        break;
      }
    }
    
    // Connect output node to the source node
    if (sourceForOutput) {
      svelteFlowEdges.push({
        id: `e_${sourceForOutput}_${outputNodeId}_out`,
        source: sourceForOutput,
        target: outputNodeId,
        sourceHandle: 'output',
        targetHandle: 'input',
      });
    }
  } else {
    console.warn('Output node definition not found. This might be due to WASM operators not being loaded yet.');
  }
  
  return {
    nodes: svelteFlowNodes,
    edges: svelteFlowEdges,
    nodeParameters: newNodeParameters,
  };
}

/**
 * Waits for WASM operators to be loaded before deserializing a pattern.
 * This prevents issues when deserializing before the WASM module is ready.
 * 
 * @param serializedPattern - The serialized pattern
 * @param maxWaitMs - Maximum time to wait for WASM (default: 5000ms)
 * @returns Promise that resolves with deserialized pattern or rejects on timeout
 */
export async function deserializePatternWhenReady(
  serializedPattern: SerializedPattern,
  maxWaitMs: number = 5000,
  options: DeserializeOptions = {}
): Promise<{ nodes: Node[]; edges: Edge[]; nodeParameters: Map<string, Map<string, any>> }> {
  // Helper to check if WASM operators are actually loaded
  // We need more than just the output node, and we need at least one pattern operator
  const isWasmReady = () => {
    if (NODE_TYPES.length <= 1) return false;
    // Also verify that actual pattern operators are loaded (not just output)
    const hasPatternOperator = NODE_TYPES.some(nt => nt.type !== 'output' && nt.type !== '');
    return hasPatternOperator;
  };
  
  // Check if WASM operators are already loaded
  if (isWasmReady()) {
    return deserializePattern(serializedPattern, options);
  }
  
  // Wait for WASM to be ready.
  //
  // Two readiness signals race here: a 50ms poll and the `wasmReady` event. The
  // previous implementation never cancelled one when the other (or the timeout)
  // won, so it leaked the poll timer and the event listener, kept polling
  // forever after a timeout, and could run deserialize (with its side effects)
  // even after the promise had already rejected. A single `settled` guard plus a
  // shared `cleanup()` invoked on every exit path fixes all of that.
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(maxWaitTimeout);
      if (pollHandle !== null) {
        clearTimeout(pollHandle);
        pollHandle = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('wasmReady', onWasmReady);
      }
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(deserializePattern(serializedPattern, options));
      } catch (error) {
        reject(error);
      }
    };

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const maxWaitTimeout = setTimeout(() => {
      finishReject(new Error(`WASM operators not loaded within ${maxWaitMs}ms. Falling back to basic deserialization.`));
    }, maxWaitMs);

    const poll = () => {
      if (settled) return;
      if (isWasmReady()) {
        finishResolve();
      } else {
        pollHandle = setTimeout(poll, 50);
      }
    };

    // Hoisted so cleanup() can reference it before this point.
    function onWasmReady() {
      // Don't deserialize immediately — wait a tick for NODE_TYPES to be
      // populated by flowStore's own wasmReady handler.
      setTimeout(() => {
        if (!settled && isWasmReady()) {
          finishResolve();
        }
      }, 10);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('wasmReady', onWasmReady);
    }

    poll();
  });
}

/**
 * Compresses a serialized pattern for BLE transmission.
 * Currently returns JSON string, but could be enhanced with LZ4 compression.
 * 
 * @param serializedPattern - The pattern to compress
 * @returns Compressed string representation
 */
export function compressPattern(serializedPattern: SerializedPattern): string {
  const jsonString = JSON.stringify(serializedPattern);
  return jsonString;
}

/**
 * Decompresses a pattern string back into a serialized pattern object.
 * 
 * @param compressedString - The compressed pattern string
 * @returns Deserialized pattern object
 */
export function decompressPattern(compressedString: string): SerializedPattern {
  try {
    return JSON.parse(compressedString) as SerializedPattern;
  } catch (error) {
    console.error('Failed to decompress/parse pattern string:', error);
    throw new Error('Invalid pattern JSON format');
  }
}

/**
 * Estimates the size of a serialized pattern in bytes.
 * 
 * @param serializedPattern - The serialized pattern
 * @returns Size estimate in bytes
 */
export function estimatePatternSize(serializedPattern: SerializedPattern): number {
  try {
    const jsonString = JSON.stringify(serializedPattern);
    return new TextEncoder().encode(jsonString).length;
  } catch (e) {
    console.error("Error estimating pattern size:", e);
    return Infinity;
  }
}
