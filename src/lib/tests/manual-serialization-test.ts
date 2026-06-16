/**
 * Manual Pattern Serialization Test
 * 
 * This file is for manually creating and testing the serialization
 * and deserialization of complex LED patterns.
 * 
 * Run with: npx ts-node src/lib/tests/manual-serialization-test.ts
 */

import type { Node, Edge } from '@xyflow/svelte';
import { MarkerType } from '@xyflow/svelte'; // Added MarkerType import
import { 
  serializePattern, 
  deserializePattern, 
  compressPattern, 
  decompressPattern,
  estimatePatternSize,
  type SerializedPattern 
} from '../patternSerializer';
import { NODE_TYPES, LANES, type NodeDefinition, getNodeDefinition, createNodeFromType } from '../flowStore';

// Helper to create nodes and edges for testing
function createTestNode(id: string, type: string, x: number, y: number, params: Record<string, any> = {}): Node {
  const nodeType = NODE_TYPES.find(nt => nt.type === type);
  if (!nodeType) {
    throw new Error(`Unknown node type: ${type}`);
  }
  
  return {
    id,
    type: 'pattern', // SvelteFlow node type
    position: { x, y },
    data: { 
      label: nodeType.name,
      type: nodeType.type, // Actual pattern type (e.g., 'rainbow')
      parameters: params 
    },
    style: ''
  };
}

function createTestEdge(id: string, source: string, target: string, sourceHandle = 'output', targetHandle = 'input'): Edge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    style: 'stroke-width: 3; stroke: #666;',
    markerEnd: {
      type: MarkerType.ArrowClosed, 
      color: '#666'
    }
  };
}

// --- Define your complex pattern here ---
const manualNodes: Node[] = [
  createTestNode('gen1', 'rainbow', LANES.LEFT, 50, { speed: 0.1, saturation: 1.0 }),
  createTestNode('gen2', 'gradient', LANES.RIGHT, 50, { color1: '#FF0000', color2: '#00FF00', speed: 0.2 }),
  createTestNode('op1', 'blur', LANES.LEFT, 150, { amount: 0.5 }),
  createTestNode('blend1', 'blend', LANES.CENTER, 250, { opacity: 0.7, blendMode: 'add' }),
  createTestNode('op2', 'strobe', LANES.CENTER, 350, { onColor: '#FFFFFF', offColor: '#000000', frequency: 2 }),
  createTestNode('output1', 'output', LANES.CENTER, 450) // Final output node
];

const manualEdges: Edge[] = [
  createTestEdge('e-gen1-op1', 'gen1', 'op1'),
  createTestEdge('e-op1-blend1', 'op1', 'blend1', 'output', 'input-1'),
  createTestEdge('e-gen2-blend1', 'gen2', 'blend1', 'output', 'input-2'),
  createTestEdge('e-blend1-op2', 'blend1', 'op2'),
  createTestEdge('e-op2-output1', 'op2', 'output1')
];

// Populate currentNodeParameters for the manual test case
const manualCurrentNodeParameters = new Map<string, Map<string, any>>();
manualNodes.forEach(node => {
    const nodeDef = getNodeDefinition(node.data.type as string);
    const paramMap = new Map<string, any>();
    if (nodeDef && nodeDef.params) {
        nodeDef.params.forEach(pDef => {
            paramMap.set(pDef.name, (node.data.parameters as any)?.[pDef.name] ?? pDef.default);
        });
    } else if (node.data.parameters) { // For nodes like 'output' that might not have formal defs but carry data
        for (const key in node.data.parameters) {
            paramMap.set(key, (node.data.parameters as any)[key]);
        }
    }
    manualCurrentNodeParameters.set(node.id, paramMap);
});


// --- Perform Serialization ---
console.log('Serializing manual pattern...');
const serializedPattern = serializePattern(manualNodes, manualEdges, manualCurrentNodeParameters, "My Manual Test Pattern");
console.log('Serialized Pattern:', JSON.stringify(serializedPattern, null, 2));

// --- Estimate Size ---
const estimatedSize = estimatePatternSize(serializedPattern);
console.log(`\nEstimated size of serialized pattern: ${estimatedSize} bytes`);

// --- Compress (currently just JSON stringify) ---
const compressedPattern = compressPattern(serializedPattern);
console.log('\nCompressed Pattern (JSON string):', compressedPattern);
console.log(`Length of compressed string: ${compressedPattern.length} characters`);

// --- Decompress ---
const decompressedPattern = decompressPattern(compressedPattern);
console.log('\nDecompressed Pattern (should match serialized):', JSON.stringify(decompressedPattern, null, 2));

// --- Deserialize back to SvelteFlow nodes/edges ---
console.log('\nDeserializing pattern back to SvelteFlow format...');
const { 
  nodes: deserializedNodes, 
  edges: deserializedEdges, 
  nodeParameters: deserializedNodeParameters 
} = deserializePattern(decompressedPattern);

console.log(`\nDeserialized Nodes (${deserializedNodes.length}):`);
deserializedNodes.forEach(node => {
  console.log(`  Node ID: ${node.id}, Type: ${node.data.type}, Position: (${node.position.x}, ${node.position.y})`);
  const params = deserializedNodeParameters.get(node.id);
  if (params && params.size > 0) {
    console.log('    Parameters:', Object.fromEntries(params));
  }
});

console.log(`\nDeserialized Edges (${deserializedEdges.length}):`);
deserializedEdges.forEach(edge => {
  console.log(`  Edge ID: ${edge.id}, Source: ${edge.source} -> Target: ${edge.target}`);
});

// --- Verification (simple checks) ---
if (serializedPattern.nodes.length === manualNodes.length -1) { // -1 because 'output' node is not in serialized.nodes
  console.log('\n✅ Node count in serialized pattern is correct (excluding output node).');
} else {
  console.error(`\n❌ Node count mismatch. Expected ${manualNodes.length -1}, Got ${serializedPattern.nodes.length}`);
}

// Check if the final output buffer in meta matches the output of the node connected to 'output1'
const outputNodeSourceId = manualEdges.find(e => e.target === 'output1')?.source;
const outputNodeSource = manualNodes.find(n => n.id === outputNodeSourceId); // Fixed typo here
let expectedFinalOutputBuffer = 0;
if (outputNodeSource) {
    // This needs to use the same logic as serializePattern to determine the buffer
    // For simplicity, let's assume the node connected to output1 is 'op2' and it's in a specific lane.
    // This part of the test might need more sophisticated logic to truly verify meta.output
    const op2Node = manualNodes.find(n => n.id === 'op2');
    if (op2Node) {
        // Determine lane of op2
        if (op2Node.position.x === LANES.LEFT) expectedFinalOutputBuffer = 0;
        else if (op2Node.position.x === LANES.CENTER) expectedFinalOutputBuffer = 1;
        else expectedFinalOutputBuffer = 2;
    }
}

if (serializedPattern.meta.output === expectedFinalOutputBuffer) {
    console.log(`✅ Meta output buffer index (${serializedPattern.meta.output}) seems correct.`);
} else {
    console.error(`❌ Meta output buffer index mismatch. Expected around ${expectedFinalOutputBuffer}, Got ${serializedPattern.meta.output}`);
}


console.log('\nManual serialization test complete.');
console.log('Review the output above for correctness.');

// Example of how to use this for further testing:
// 1. Copy the `compressedPattern` string.
// 2. Send it to your ESP32 via BLE (e.g., using the ChromaBay app's write characteristic feature).
// 3. Observe the ESP32's behavior and serial logs to see if it correctly interprets the pattern.
