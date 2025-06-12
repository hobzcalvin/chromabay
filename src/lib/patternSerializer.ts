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
  const graph: Map<string, string[]> = new Map(); // nodeId -> list of targetNodeIds
  const inDegree: Map<string, number> = new Map(); // nodeId -> in-degree count

  /* ------------------------------------------------------------------
   * 1. Pre-compute whether each node **overwrites** one of the buffers it
   *    reads.  These nodes should be processed **after** non-overwriters
   *    when several nodes share the same dependency level.
   * ------------------------------------------------------------------ */
  const overwrites: Record<string, boolean> = {};
  const laneBuf = (n: Node) => getNodeLaneBuffer(n);

  const incomingFor = (targetId: string) =>
    edges.filter(e => e.target === targetId);

  /* ------------------------------------------------------------------
   * Phase 0: determine dependency (execution) level for every node
   * (distance from generators).  We run a simple BFS starting from
   * zero-in-degree nodes to assign levels.
   * ------------------------------------------------------------------ */
  const depLevel = new Map<string, number>();
  const tmpQueue: string[] = [];
  nodes.forEach(n => {
    if ((inDegree.get(n.id) || 0) === 0) {
      depLevel.set(n.id, 0);
      tmpQueue.push(n.id);
    }
  });
  while (tmpQueue.length) {
    const cur = tmpQueue.shift()!;
    const curLvl = depLevel.get(cur)!;
    for (const tgt of graph.get(cur) || []) {
      if (!depLevel.has(tgt) || depLevel.get(tgt)! < curLvl + 1) {
        depLevel.set(tgt, curLvl + 1);
        tmpQueue.push(tgt);
      }
    }
  }

  /* ------------------------------------------------------------------
   * For tie-breaking between generators: compute the earliest consumer
   * level.  For a node with outgoing edges, consumerLevel = minimum
   * depLevel of its direct consumers; if no outgoing edges give Infinity
   * so it will be scheduled last.
   * ------------------------------------------------------------------ */
  const earliestConsumerLevel: Record<string, number> = {};
  nodes.forEach(n => {
    const outs = graph.get(n.id) || [];
    if (outs.length === 0) {
      earliestConsumerLevel[n.id] = Number.MAX_SAFE_INTEGER;
    } else {
      earliestConsumerLevel[n.id] = Math.min(
        ...outs.map(o => depLevel.get(o) ?? Number.MAX_SAFE_INTEGER)
      );
    }
  });

  nodes.forEach(n => {
    const outBuf = laneBuf(n);
    const ins   = incomingFor(n.id);

    if (ins.length === 0) {
      overwrites[n.id] = false;
      return;
    }

    if (n.data.type !== 'blend') {
      const src = nodes.find(s => s.id === ins[0].source);
      overwrites[n.id] = src ? laneBuf(src) === outBuf : false;
      return;
    }

    // blend – two inputs
    const in1 = ins.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
    const in2 = ins.find(e => e.targetHandle === 'input-2');
    const buf1 = in1 ? laneBuf(nodes.find(s => s.id === in1.source)!) : undefined;
    const buf2 = in2 ? laneBuf(nodes.find(s => s.id === in2.source)!) : undefined;
    overwrites[n.id] = buf1 === outBuf || buf2 === outBuf;
  });

  nodes.forEach(node => {
    graph.set(node.id, []);
    inDegree.set(node.id, 0);
  });

  edges.forEach(edge => {
    graph.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  });

  // Helper to (re)sort the queue so non-overwriters come first
  const sortQueue = (q: string[]) =>
    q.sort((a, b) => {
      const pa = overwrites[a] ? 1 : 0;
      const pb = overwrites[b] ? 1 : 0;
      if (pa !== pb) return pa - pb;          // non-overwriter first
      // Tie-breaker 1: node whose earliest consumer is at lower level
      const ea = earliestConsumerLevel[a];
      const eb = earliestConsumerLevel[b];
      if (ea !== eb) return ea - eb;

      return a.localeCompare(b);              // stable fallback
    });

  const queue: string[] = sortQueue(
    nodes.filter(n => (inDegree.get(n.id) || 0) === 0).map(n => n.id)
  );
  const orderedNodeIds: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    orderedNodeIds.push(nodeId);

    for (const dependentId of graph.get(nodeId) || []) {
      inDegree.set(dependentId, (inDegree.get(dependentId) || 0) - 1);
      if ((inDegree.get(dependentId) || 0) === 0) {
        queue.push(dependentId);
        sortQueue(queue);
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
    const inEdges = allEdges.filter(e => e.target === n.id);
    if (inEdges.length === 0) return false;

    // Single-input node
    if (n.data.type !== 'blend') {
      const srcNode = allNodes.find(nd => nd.id === inEdges[0].source);
      return srcNode ? getNodeLaneBuffer(srcNode) === outBuf : false;
    }

    // Blend node – two inputs
    const src1 = inEdges.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
    const src2 = inEdges.find(e => e.targetHandle === 'input-2');
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
   * Extra re-ordering for “buffer overwrite” was too aggressive and
   * broke valid dependency chains (e.g. putting a blend before the
   * Raindrops node it actually needs).  We therefore keep the pure
   * topological order here.
   * ------------------------------------------------------------------ */

  const conflictSafeOrder = orderedNodesFullGraph;
  
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
  
  return levels;
}

/**
 * Deserializes a pattern from the compact format back into nodes and edges.
 * 
 * @param serializedPattern - The serialized pattern
 * @returns Object containing reconstructed nodes, edges, and parameters
 */
export function deserializePattern(
  serializedPattern: SerializedPattern
): { nodes: Node[]; edges: Edge[]; nodeParameters: Map<string, Map<string, any>> } {
  const svelteFlowNodes: Node[] = [];
  const svelteFlowEdges: Edge[] = [];
  const newNodeParameters = new Map<string, Map<string, any>>();
  
  // Step 1: Calculate dependency levels for proper vertical positioning
  const dependencyLevels = calculateDependencyLevels(serializedPattern.nodes);
  
  // Step 2: Create nodes based on serialized data
  serializedPattern.nodes.forEach((sNode, index) => {
    const nodeDefinition = getNodeDefinition(sNode.t);
    if (!nodeDefinition) {
      console.warn(`Unknown node type during deserialization: ${sNode.t}`);
      return;
    }
    
    const nodeId = `deserialized_${sNode.t}_${Date.now()}_${index}`;
    
    // Position node based on its output buffer (x) and dependency level (y)
    const xPos = getLaneFromBuffer(sNode.o);
    const level = dependencyLevels.get(index) || 0;
    const yPos = 50 + level * (NODE_HEIGHT + VERTICAL_SPACING);
    
    // Create node
    const newNode = createNodeFromType(nodeDefinition, nodeId, { x: xPos, y: yPos });
    
    // Set parameters
    const currentParamsForNode = new Map<string, any>();
    nodeDefinition.params.forEach(paramDef => {
      // Start with defaults
      currentParamsForNode.set(paramDef.name, paramDef.default);
    });
    
    // Override with serialized values
    if (sNode.p) {
      for (const paramName in sNode.p) {
        if (currentParamsForNode.has(paramName)) {
          currentParamsForNode.set(paramName, sNode.p[paramName]);
        } else {
          console.warn(`Node type ${sNode.t} has serialized param ${paramName} not in its definition.`);
        }
      }
    }
    
    // Store parameters
    newNodeParameters.set(nodeId, currentParamsForNode);
    
    // For visual consistency in PatternNode if it reads data.parameters directly
    newNode.data.parameters = Object.fromEntries(currentParamsForNode.entries());
    
    // Add node to collection
    svelteFlowNodes.push(newNode);
  });
  
  // Step 3: Create edges based on input/output buffer relationships
  serializedPattern.nodes.forEach((sNode, targetIndex) => {
    const targetNodeId = svelteFlowNodes[targetIndex].id;
    
    // Create edge for primary input
    if (sNode.i !== undefined) {
      // Find the source node by looking backwards for the most recent node that outputs to this buffer
      const sourceIndex = findSourceNodeIndex(serializedPattern.nodes, targetIndex, sNode.i);
      
      if (sourceIndex !== undefined) {
        const sourceNodeId = svelteFlowNodes[sourceIndex].id;
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
      
      if (sourceIndex !== undefined) {
        const sourceNodeId = svelteFlowNodes[sourceIndex].id;
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
    
    // Position output node at the bottom center
    const outputNode = createNodeFromType(outputDef, outputNodeId, {
      x: LANES.CENTER,
      y: 50 + maxLevel * (NODE_HEIGHT + VERTICAL_SPACING)
    });
    
    // Add output node parameters (none for output node)
    newNodeParameters.set(outputNodeId, new Map());
    
    // Add output node
    svelteFlowNodes.push(outputNode);
    
    // Find the node that outputs to the final output buffer
    const finalOutputBuffer = serializedPattern.meta?.output !== undefined ? serializedPattern.meta.output : 0;
    
    // Find the last node that writes to this buffer
    let sourceForOutput: string | undefined;
    for (let i = serializedPattern.nodes.length - 1; i >= 0; i--) {
      const node = serializedPattern.nodes[i];
      if (node.o === finalOutputBuffer) {
        sourceForOutput = svelteFlowNodes[i].id;
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
  }
  
  return {
    nodes: svelteFlowNodes,
    edges: svelteFlowEdges,
    nodeParameters: newNodeParameters,
  };
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
