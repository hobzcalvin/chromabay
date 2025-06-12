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
  createNodeFromType, // This function should correctly set default parameters
  LANES,
  type Parameter,
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
  bufferMap: Map<string, number>; // Node ID -> Output Buffer Index
  blendSecondInputMap: Map<string, number>; // Blend Node ID -> Second Input Buffer Index for its sNode.i2
}

// Constants for deserialization layout
// const NODE_WIDTH = 100; // Standard node width from PatternNode.svelte (approx)
const NODE_HEIGHT = 50; // Standard node height
const VERTICAL_SPACING = 50; // Increased spacing
const HORIZONTAL_SPACING = 75; // Spacing between lanes or for jitter

function topologicalSort(nodes: Node[], edges: Edge[]): SortResult {
  const graph: Map<string, string[]> = new Map(); // nodeId -> list of targetNodeIds
  const inDegree: Map<string, number> = new Map(); // nodeId -> in-degree count

  nodes.forEach(node => {
    graph.set(node.id, []);
    inDegree.set(node.id, 0);
  });

  edges.forEach(edge => {
    graph.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  });

  const queue: string[] = nodes.filter(node => (inDegree.get(node.id) || 0) === 0).map(n => n.id);
  const orderedNodeIds: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    orderedNodeIds.push(nodeId);

    for (const dependentId of graph.get(nodeId) || []) {
      inDegree.set(dependentId, (inDegree.get(dependentId) || 0) - 1);
      if ((inDegree.get(dependentId) || 0) === 0) {
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

  // Buffer assignment
  const bufferMap = new Map<string, number>(); // node.id -> its output buffer index
  const blendSecondInputMap = new Map<string, number>(); // blend_node.id -> buffer index of its second input source

  const MAX_BUFFERS = 3; // ESP32 typically uses 2 or 3 buffers
  let nextAvailableBufferPoolIndex = 0;
  const nodeEffectiveOutputBuffer = new Map<string, number>(); // Stores which buffer a node effectively writes its output to

  orderedNodes.forEach(node => {
    if (node.data.type === 'output') {
      // Output node consumes a buffer, doesn't produce a new one in the chain for serialization
      return;
    }

    let assignedOutputBuffer = nextAvailableBufferPoolIndex;
    
    // A very basic heuristic to try and avoid outputting to a buffer that is an input to the current node
    // This is not a full-fledged register allocation but a simple attempt.
    const inputEdges = edges.filter(e => e.target === node.id);
    const inputBufferIndices = inputEdges.map(e => nodeEffectiveOutputBuffer.get(e.source)).filter(b => b !== undefined) as number[];

    let attempts = 0;
    while(inputBufferIndices.includes(assignedOutputBuffer) && attempts < MAX_BUFFERS) {
        assignedOutputBuffer = (assignedOutputBuffer + 1) % MAX_BUFFERS;
        attempts++;
    }
    if (attempts >= MAX_BUFFERS && inputBufferIndices.includes(assignedOutputBuffer)) {
        console.warn(`Buffer assignment conflict for node ${node.id}. Could not find a free buffer.`);
        // Fallback: just use the next one, ESP32 might need to handle this with copies if it's a true conflict
    }


    nodeEffectiveOutputBuffer.set(node.id, assignedOutputBuffer);
    bufferMap.set(node.id, assignedOutputBuffer);
    nextAvailableBufferPoolIndex = (assignedOutputBuffer + 1) % MAX_BUFFERS;

    // For blend nodes, identify the buffer of their second input source
    if (node.data.type === 'blend') {
      const input2Edge = inputEdges.find(e => e.targetHandle === 'input-2');
      if (input2Edge) {
        const input2SourceBuffer = nodeEffectiveOutputBuffer.get(input2Edge.source);
        if (input2SourceBuffer !== undefined) {
          blendSecondInputMap.set(node.id, input2SourceBuffer);
        }
      }
    }
  });

  return { orderedNodes, bufferMap, blendSecondInputMap };
}

export function serializePattern(
  allNodes: Node[],
  allEdges: Edge[],
  currentNodeParameters: Map<string, Map<string, any>>, // Actual parameters from the Svelte store
  patternName?: string
): SerializedPattern {
  const {
    orderedNodes: orderedNodesFullGraph, // Includes output node
    bufferMap, // node.id -> its output buffer index
    blendSecondInputMap,
  } = topologicalSort(allNodes, allEdges);

  let finalOutputBufferIndex = 0; // Default: ESP32 uses buffer 0 for display
  const outputNode = allNodes.find(n => n.data.type === 'output');

  if (outputNode) {
    const inputEdgesToOutputNode = allEdges.filter(edge => edge.target === outputNode.id);
    if (inputEdgesToOutputNode.length > 0) {
      const sourceNodeId = inputEdgesToOutputNode[0].source; // Output node has one input
      const sourceOutputBuffer = bufferMap.get(sourceNodeId);
      if (sourceOutputBuffer !== undefined) {
        finalOutputBufferIndex = sourceOutputBuffer;
      } else {
        console.warn(`Output node's source (${sourceNodeId}) has no assigned output buffer. Defaulting meta.output.`);
      }
    } else {
      console.warn("Output node found but has no inputs. Defaulting meta.output.");
    }
  } else if (orderedNodesFullGraph.length > 0) {
    // If no explicit output node, consider the output of the last non-output node in the sorted list
    const lastNodeBeforePotentialImplicitOutput = orderedNodesFullGraph.filter(n => n.data.type !== 'output').pop();
    if (lastNodeBeforePotentialImplicitOutput) {
        const lastNodeBuffer = bufferMap.get(lastNodeBeforePotentialImplicitOutput.id);
        if (lastNodeBuffer !== undefined) {
            finalOutputBufferIndex = lastNodeBuffer;
        }
    }
  }


  const nodesToSerialize = orderedNodesFullGraph.filter(node => node.data.type !== 'output');

  const serializedNodes: SerializedNode[] = nodesToSerialize.map(node => {
    const nodeDefinition = getNodeDefinition(node.data.type as string);
    if (!nodeDefinition) {
      // This case should ideally not be reached if graph is validated before serialization
      console.error(`FATAL: No definition for node type ${node.data.type} during serialization.`);
      return null;
    }

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

    let primaryInputBuffer: number | undefined = undefined;
    const inputEdgesToCurrentNode = allEdges.filter(edge => edge.target === node.id);

    if (node.data.type === 'blend') {
      const input1Edge = inputEdgesToCurrentNode.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
      if (input1Edge) {
        primaryInputBuffer = bufferMap.get(input1Edge.source);
      }
    } else { // For non-blend, non-generator nodes
      if (inputEdgesToCurrentNode.length > 0) {
        primaryInputBuffer = bufferMap.get(inputEdgesToCurrentNode[0].source);
      }
    }
    
    const nodeOutputBuffer = bufferMap.get(node.id);
    if (nodeOutputBuffer === undefined) {
        console.error(`FATAL: Node ${node.id} (${node.data.type}) has no output buffer assigned in bufferMap.`);
        // This indicates a flaw in topologicalSort's bufferMap population for non-output nodes.
        // As a fallback, though incorrect:
        // nodeOutputBuffer = 0; 
        return null; // Critical error, skip this node
    }


    const serializedNode: SerializedNode = {
      t: node.data.type as string,
      o: nodeOutputBuffer,
    };

    if (primaryInputBuffer !== undefined) {
      serializedNode.i = primaryInputBuffer;
    }

    if (node.data.type === 'blend') {
      const i2Buffer = blendSecondInputMap.get(node.id); // This map stores the *source buffer index* for i2
      if (i2Buffer !== undefined) {
        serializedNode.i2 = i2Buffer;
      }
    }

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

export function deserializePattern(
  serializedPattern: SerializedPattern
): { nodes: Node[]; edges: Edge[]; nodeParameters: Map<string, Map<string, any>> } {
  const svelteFlowNodes: Node[] = [];
  const svelteFlowEdges: Edge[] = [];
  const newNodeParameters = new Map<string, Map<string, any>>();

  const outputBufferToSourceNodeIdMap = new Map<number, string>(); // Stores: bufferIndex -> nodeId that wrote to it

  serializedPattern.nodes.forEach((sNode, index) => {
    const nodeDefinition = getNodeDefinition(sNode.t);
    if (!nodeDefinition) {
      console.warn(`Unknown node type during deserialization: ${sNode.t}`);
      return;
    }

    const nodeId = `deserialized_${sNode.t}_${Date.now()}_${index}`; // More unique ID

    // Positioning: Top-down, trying to use lanes
    const laneKeys = Object.keys(LANES) as Array<keyof typeof LANES>;
    // Try to place in a lane based on its output buffer, or cycle through lanes
    const laneIndex = sNode.o % laneKeys.length;
    const xPos = LANES[laneKeys[laneIndex]] + (Math.random() * HORIZONTAL_SPACING / 2 - HORIZONTAL_SPACING / 4);
    const yPos = 50 + index * (NODE_HEIGHT + VERTICAL_SPACING);

    // Create SvelteFlow node. createNodeFromType should initialize default parameters.
    // The parameters will then be managed by the newNodeParameters map.
    const newNode = createNodeFromType(nodeDefinition, nodeId, { x: xPos, y: yPos });

    // Prepare parameters for this node
    const currentParamsForNode = new Map<string, any>();
    nodeDefinition.params.forEach(paramDef => { // Start with defaults
      currentParamsForNode.set(paramDef.name, paramDef.default);
    });
    if (sNode.p) { // Override with serialized values
      for (const paramName in sNode.p) {
        if (currentParamsForNode.has(paramName)) { // Ensure param exists in definition
          currentParamsForNode.set(paramName, sNode.p[paramName]);
        } else {
          console.warn(`Node type ${sNode.t} has serialized param ${paramName} not in its definition.`);
        }
      }
    }
    newNodeParameters.set(nodeId, currentParamsForNode);
    // For visual consistency in PatternNode if it reads data.parameters directly:
    newNode.data.parameters = Object.fromEntries(currentParamsForNode.entries());


    svelteFlowNodes.push(newNode);

    // Create Edges
    // Primary Input
    if (sNode.i !== undefined) {
      const sourceNodeId = outputBufferToSourceNodeIdMap.get(sNode.i);
      if (sourceNodeId) {
        svelteFlowEdges.push({
          id: `e_${sourceNodeId}_${nodeId}_i1_${Date.now()}`,
          source: sourceNodeId,
          target: nodeId,
          sourceHandle: 'output', // Default output handle name
          targetHandle: (sNode.t === 'blend') ? 'input-1' : 'input', // Default input handle names
        });
      } else {
        console.warn(`Deserialization: Source node for input buffer ${sNode.i} (node ${nodeId}, type ${sNode.t}) not found.`);
      }
    }

    // Secondary Input (for Blend nodes)
    if (sNode.t === 'blend' && sNode.i2 !== undefined) {
      const sourceNodeId_i2 = outputBufferToSourceNodeIdMap.get(sNode.i2);
      if (sourceNodeId_i2) {
        svelteFlowEdges.push({
          id: `e_${sourceNodeId_i2}_${nodeId}_i2_${Date.now()}`,
          source: sourceNodeId_i2,
          target: nodeId,
          sourceHandle: 'output',
          targetHandle: 'input-2',
        });
      } else {
        console.warn(`Deserialization: Source node for secondary input buffer ${sNode.i2} (blend node ${nodeId}) not found.`);
      }
    }

    // Update map: this node (nodeId) now provides output for buffer sNode.o
    outputBufferToSourceNodeIdMap.set(sNode.o, nodeId);
  });

  /* ------------------------------------------------------------------
   * 2. Inject OUTPUT node (not part of the compact list)
   * ------------------------------------------------------------------ */
  const outputDef = getNodeDefinition('output');
  if (outputDef) {
    const outputNodeId = `deserialized_output_${Date.now()}`;

    /*  Position it centred under the last row */
    const maxY =
      svelteFlowNodes.reduce((m, n) => Math.max(m, n.position.y), 0) +
      NODE_HEIGHT +
      VERTICAL_SPACING;
    const outputX = LANES.CENTER;

    const outputNode = createNodeFromType(outputDef, outputNodeId, {
      x: outputX,
      y: maxY,
    });

    // Output node has no adjustable parameters
    newNodeParameters.set(outputNodeId, new Map());

    svelteFlowNodes.push(outputNode);

    /* Connect the node that wrote to meta.output buffer → output node  */
    const finalBufIdx =
      serializedPattern.meta?.output !== undefined
        ? serializedPattern.meta.output
        : 0;
    const sourceForOutput = outputBufferToSourceNodeIdMap.get(finalBufIdx);
    if (sourceForOutput) {
      svelteFlowEdges.push({
        id: `e_${sourceForOutput}_${outputNodeId}_out`,
        source: sourceForOutput,
        target: outputNodeId,
        sourceHandle: 'output',
        targetHandle: 'input',
      });
    } else {
      console.warn(
        `deserializePattern: Could not find source node for meta.output buffer ${finalBufIdx}`,
      );
    }
  } else {
    console.error(
      'deserializePattern: Output node definition missing – cannot create final node.',
    );
  }

  return {
    nodes: svelteFlowNodes,
    edges: svelteFlowEdges,
    nodeParameters: newNodeParameters,
  };
}

export function compressPattern(serializedPattern: SerializedPattern): string {
  const jsonString = JSON.stringify(serializedPattern);
  // console.log('Note: For production use with ESP32, consider implementing LZ4 compression.');
  return jsonString;
}

export function decompressPattern(compressedString: string): SerializedPattern {
  try {
    return JSON.parse(compressedString) as SerializedPattern;
  } catch (error) {
    console.error('Failed to decompress/parse pattern string:', error);
    throw new Error('Invalid pattern JSON format');
  }
}

export function estimatePatternSize(serializedPattern: SerializedPattern): number {
  try {
    const jsonString = JSON.stringify(serializedPattern);
    return new TextEncoder().encode(jsonString).length;
  } catch (e) {
    console.error("Error estimating pattern size:", e);
    return Infinity;
  }
}
