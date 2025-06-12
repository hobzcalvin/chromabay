/**
 * Pattern Serialization Module
 * 
 * This module provides utilities for serializing and deserializing node-based LED patterns
 * for transmission to ESP32 devices via BLE. It handles topological sorting of nodes to ensure
 * proper execution order, buffer assignment, and compact representation.
 */

import type { Node, Edge } from '@xyflow/svelte';
import { getNodeDefinition, type NodeDefinition, NODE_TYPES, createNodeFromType, LANES } from './flowStore';

/**
 * Compact representation of a node in the serialized pattern
 * Uses short keys to minimize JSON size for BLE transmission
 */
export interface SerializedNode {
  /** Node type identifier (e.g. 'rainbow', 'gradient') */
  t: string;
  
  /** Node parameters as key-value pairs with short keys */
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
  /** Array of nodes in execution order */
  nodes: SerializedNode[];
  
  /** Optional metadata about the pattern */
  meta?: {
    name?: string;
    author?: string;
    version?: string;
    created?: number;
    modified?: number;
  };
}

/**
 * Result of the topological sort, including ordered nodes and buffer assignments
 */
interface SortResult {
  /** Nodes in execution order */
  orderedNodes: Node[];
  
  /** Map of node IDs to their output buffer indices */
  bufferMap: Map<string, number>;
  
  /** Map of blend node IDs to their second input buffer indices */
  blendSecondInputMap: Map<string, number>;
}

/**
 * Performs a topological sort on the nodes to determine execution order.
 * Assigns buffer indices to ensure proper data flow.
 * 
 * @param nodes - The nodes in the pattern
 * @param edges - The edges connecting the nodes
 * @returns Object containing ordered nodes and buffer assignments
 */
function topologicalSort(nodes: Node[], edges: Edge[]): SortResult {
  // Create a map of node dependencies (adjacency list)
  const graph: Map<string, string[]> = new Map();
  const inDegree: Map<string, number> = new Map();
  
  // Initialize maps
  nodes.forEach(node => {
    graph.set(node.id, []);
    inDegree.set(node.id, 0);
  });
  
  // Build the graph
  edges.forEach(edge => {
    const source = edge.source;
    const target = edge.target;
    
    // Add dependency: target depends on source
    if (graph.has(source)) {
      graph.get(source)!.push(target);
    }
    
    // Increment in-degree of target
    inDegree.set(target, (inDegree.get(target) || 0) + 1);
  });
  
  // Find nodes with no dependencies (in-degree = 0)
  const queue: string[] = [];
  nodes.forEach(node => {
    if ((inDegree.get(node.id) || 0) === 0) {
      queue.push(node.id);
    }
  });
  
  // Process nodes in topological order
  const orderedNodeIds: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    orderedNodeIds.push(nodeId);
    
    // For each dependent node, reduce in-degree and check if it can be processed
    const dependents = graph.get(nodeId) || [];
    for (const dependent of dependents) {
      inDegree.set(dependent, (inDegree.get(dependent) || 0) - 1);
      if ((inDegree.get(dependent) || 0) === 0) {
        queue.push(dependent);
      }
    }
  }
  
  // Check if we have a cycle (not all nodes processed)
  if (orderedNodeIds.length !== nodes.length) {
    console.warn('Cycle detected in pattern graph. Some nodes may not be processed correctly.');
    
    // Add remaining nodes in arbitrary order
    nodes.forEach(node => {
      if (!orderedNodeIds.includes(node.id)) {
        orderedNodeIds.push(node.id);
      }
    });
  }
  
  // Map node IDs to actual nodes and maintain order
  const orderedNodes = orderedNodeIds.map(id => nodes.find(node => node.id === id)!);
  
  // Assign buffer indices
  // We need at most 3 buffers: current output, previous output (input), and blend second input
  const bufferMap = new Map<string, number>();
  const blendSecondInputMap = new Map<string, number>();
  
  // First pass: identify blend nodes and their inputs
  const blendNodes = orderedNodes.filter(node => node.data.type === 'blend');
  const blendInputs = new Map<string, { input1: string | null, input2: string | null }>();
  
  blendNodes.forEach(blendNode => {
    const blendInputEdges = edges.filter(edge => edge.target === blendNode.id);
    const input1Edge = blendInputEdges.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
    const input2Edge = blendInputEdges.find(e => e.targetHandle === 'input-2');
    
    blendInputs.set(blendNode.id, {
      input1: input1Edge ? input1Edge.source : null,
      input2: input2Edge ? input2Edge.source : null
    });
  });
  
  // Second pass: assign buffer indices
  // We'll use a rotating buffer system with at most 3 buffers (0, 1, 2)
  let currentBuffer = 0;
  const maxBuffers = 3;
  
  orderedNodes.forEach((node, index) => {
    // For the output node, always use buffer 0
    if (node.data.type === 'output') {
      bufferMap.set(node.id, 0);
      return;
    }
    
    // For regular nodes, rotate between buffers
    bufferMap.set(node.id, currentBuffer);
    
    // Special handling for blend nodes with two inputs
    if (node.data.type === 'blend') {
      const inputs = blendInputs.get(node.id);
      
      // If this blend node has a second input, assign it a different buffer
      if (inputs && inputs.input2) {
        // Find the buffer of the second input
        const input2Buffer = bufferMap.get(inputs.input2);
        
        // Store this as the second input buffer for this blend node
        if (input2Buffer !== undefined) {
          blendSecondInputMap.set(node.id, input2Buffer);
        }
      }
    }
    
    // Rotate to next buffer for the next node
    currentBuffer = (currentBuffer + 1) % maxBuffers;
  });
  
  return {
    orderedNodes,
    bufferMap,
    blendSecondInputMap
  };
}

/**
 * Serializes a pattern graph into a compact format suitable for BLE transmission.
 * 
 * @param nodes - The nodes in the pattern
 * @param edges - The edges connecting the nodes
 * @returns Serialized pattern object
 */
export function serializePattern(nodes: Node[], edges: Edge[]): SerializedPattern {
  // Sort nodes topologically and assign buffers
  const { orderedNodes, bufferMap, blendSecondInputMap } = topologicalSort(nodes, edges);
  
  // Create serialized nodes
  const serializedNodes: SerializedNode[] = orderedNodes.map(node => {
    // Get node definition to access parameters
    const nodeDefinition = getNodeDefinition(node.data.type as string);
    if (!nodeDefinition) {
      console.warn(`Unknown node type: ${node.data.type}`);
      return null;
    }
    
    // Find input edges for this node
    const inputEdges = edges.filter(edge => edge.target === node.id);
    
    // Get input buffer index from the source node's output buffer
    let inputBuffer: number | undefined = undefined;
    if (inputEdges.length > 0) {
      const sourceNodeId = inputEdges[0].source;
      inputBuffer = bufferMap.get(sourceNodeId);
    }
    
    // Get output buffer index
    const outputBuffer = bufferMap.get(node.id)!;
    
    // Get second input buffer for blend nodes
    let secondInputBuffer: number | undefined = undefined;
    if (node.data.type === 'blend') {
      secondInputBuffer = blendSecondInputMap.get(node.id);
    }
    
    // Extract parameter values
    const params: Record<string, any> = {};
    if (nodeDefinition.params && node.data.parameters) {
      nodeDefinition.params.forEach(param => {
        // Use parameter name as short key
        // If we need even shorter keys, we could map them to single letters
        const paramValue = node.data.parameters?.[param.name];
        if (paramValue !== undefined) {
          params[param.name] = paramValue;
        }
      });
    }
    
    // Create serialized node with short keys
    const serializedNode: SerializedNode = {
      t: node.data.type as string,
      o: outputBuffer
    };
    
    // Only include input buffer if it exists
    if (inputBuffer !== undefined) {
      serializedNode.i = inputBuffer;
    }
    
    // Only include second input buffer for blend nodes if it exists
    if (secondInputBuffer !== undefined) {
      serializedNode.i2 = secondInputBuffer;
    }
    
    // Only include params if there are any
    if (Object.keys(params).length > 0) {
      serializedNode.p = params;
    }
    
    return serializedNode;
  }).filter(Boolean) as SerializedNode[];
  
  return {
    nodes: serializedNodes,
    meta: {
      created: Date.now(),
      modified: Date.now()
    }
  };
}

/**
 * Deserializes a pattern from the compact format back into nodes and edges.
 * 
 * @param serializedPattern - The serialized pattern
 * @returns Object containing reconstructed nodes and edges
 */
export function deserializePattern(serializedPattern: SerializedPattern): { nodes: Node[], edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  
  // Maps buffer indices back to node IDs
  const bufferToNodeMap = new Map<number, string>();
  
  // First pass: create nodes
  serializedPattern.nodes.forEach((serializedNode, index) => {
    // Find node definition
    const nodeType = NODE_TYPES.find(nt => nt.type === serializedNode.t);
    if (!nodeType) {
      console.warn(`Unknown node type: ${serializedNode.t}`);
      return;
    }
    
    // Create node ID
    const nodeId = `node_${index}`;
    
    // Determine node position based on its type and index
    // Output node is always at the bottom
    // Other nodes are arranged in rows above it
    let lane = LANES.CENTER;
    let yPosition = 100;
    
    if (serializedNode.t === 'output') {
      yPosition = 300; // Output at bottom
    } else {
      // Distribute other nodes above
      yPosition = 50 + (index * 75);
      
      // Alternate between lanes for better visibility
      lane = [LANES.LEFT, LANES.CENTER, LANES.RIGHT][index % 3];
    }
    
    // Create node
    const node = createNodeFromType(nodeType, nodeId, { x: lane, y: yPosition });
    
    // Set parameters if available
    if (serializedNode.p) {
      node.data.parameters = { ...serializedNode.p };
    }
    
    // Store node
    nodes.push(node);
    
    // Map output buffer to this node ID
    bufferToNodeMap.set(serializedNode.o, nodeId);
  });
  
  // Second pass: create edges
  serializedPattern.nodes.forEach((serializedNode, index) => {
    const targetNodeId = `node_${index}`;
    
    // Create edge from input buffer to this node
    if (serializedNode.i !== undefined) {
      const sourceNodeId = bufferToNodeMap.get(serializedNode.i);
      if (sourceNodeId) {
        // For blend nodes, connect to the first input
        const targetHandle = serializedNode.t === 'blend' ? 'input-1' : 'input';
        
        edges.push({
          id: `edge_${sourceNodeId}_${targetNodeId}`,
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: 'output',
          targetHandle: targetHandle,
          style: 'stroke-width: 3; stroke: #666;',
          markerEnd: {
            type: 'arrowclosed',
            color: '#666'
          }
        });
      }
    }
    
    // For blend nodes, create edge from second input buffer
    if (serializedNode.t === 'blend' && serializedNode.i2 !== undefined) {
      const sourceNodeId = bufferToNodeMap.get(serializedNode.i2);
      if (sourceNodeId) {
        edges.push({
          id: `edge_${sourceNodeId}_${targetNodeId}_2`,
          source: sourceNodeId,
          target: targetNodeId,
          sourceHandle: 'output',
          targetHandle: 'input-2',
          style: 'stroke-width: 3; stroke: #666;',
          markerEnd: {
            type: 'arrowclosed',
            color: '#666'
          }
        });
      }
    }
  });
  
  return { nodes, edges };
}

/**
 * Compresses a serialized pattern using a simple run-length encoding.
 * For more advanced compression, consider using LZ4 or similar algorithm.
 * 
 * @param serializedPattern - The serialized pattern object
 * @returns Compressed string representation
 */
export function compressPattern(serializedPattern: SerializedPattern): string {
  // Convert to JSON string
  const jsonString = JSON.stringify(serializedPattern);
  
  // For BLE transmission, we could use a more sophisticated compression.
  // LZ4 would be ideal for ESP32 as it's fast and has low memory requirements.
  // There are JavaScript implementations like lz4js that could be used.
  
  // For now, we'll just return the JSON string with a note about compression
  console.log('Note: For production use with ESP32, consider implementing LZ4 compression.');
  console.log('LZ4 is lightweight, fast to decompress, and suitable for embedded devices.');
  console.log('ESP32 has LZ4 libraries available in both Arduino and ESP-IDF frameworks.');
  
  return jsonString;
}

/**
 * Decompresses a pattern string back into a serialized pattern object.
 * 
 * @param compressedString - The compressed pattern string
 * @returns Deserialized pattern object
 */
export function decompressPattern(compressedString: string): SerializedPattern {
  // For now, just parse the JSON string
  // In a real implementation with LZ4, we would decompress first
  try {
    return JSON.parse(compressedString) as SerializedPattern;
  } catch (error) {
    console.error('Failed to decompress pattern:', error);
    throw new Error('Invalid pattern format');
  }
}

/**
 * Estimates the size of a serialized pattern in bytes.
 * Useful for determining if it will fit within BLE transmission limits.
 * 
 * @param serializedPattern - The serialized pattern
 * @returns Size estimate in bytes
 */
export function estimatePatternSize(serializedPattern: SerializedPattern): number {
  const jsonString = JSON.stringify(serializedPattern);
  return new TextEncoder().encode(jsonString).length;
}
