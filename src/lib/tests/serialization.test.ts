/**
 * Pattern Serialization Tests
 * 
 * This file contains tests to verify the serialization and deserialization
 * of LED patterns for transmission to ESP32 devices.
 * 
 * Run with: npx ts-node src/lib/tests/serialization.test.ts
 */

import type { Node, Edge } from '@xyflow/svelte';
import { MarkerType } from '@xyflow/svelte';
import { 
  serializePattern, 
  deserializePattern,
  type SerializedPattern 
} from '../patternSerializer';
import { NODE_TYPES, LANES } from '../flowStore';

// Simple test framework
const tests: { name: string; fn: () => boolean }[] = [];
let passedTests = 0;
let failedTests = 0;

function test(name: string, fn: () => boolean) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string): boolean {
  if (!condition) {
    console.error(`  ❌ ${message}`);
    return false;
  }
  return true;
}

function assertDeepEqual(a: any, b: any, message: string): boolean {
  try {
    const stringA = JSON.stringify(a);
    const stringB = JSON.stringify(b);
    if (stringA !== stringB) {
      console.error(`  ❌ ${message}`);
      console.error(`     Expected: ${stringA}`);
      console.error(`     Received: ${stringB}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`  ❌ ${message} (Error comparing objects: ${error})`);
    return false;
  }
}

// Helper to create nodes and edges for testing
function createTestNode(id: string, type: string, x: number, y: number, params: Record<string, any> = {}): Node {
  const nodeType = NODE_TYPES.find(nt => nt.type === type);
  if (!nodeType) {
    throw new Error(`Unknown node type: ${type}`);
  }
  
  return {
    id,
    type: 'pattern', // Assuming all test nodes are of the 'pattern' SvelteFlow type
    position: { x, y },
    data: { 
      label: nodeType.name,
      type: nodeType.type, // This is the actual pattern type (e.g., 'rainbow')
      parameters: params  // Store provided params here
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

// Test 1: Basic serialization of a simple pattern
test('Basic serialization of a simple pattern', () => {
  // Create a simple rainbow -> output pattern
  const nodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.CENTER, 100, { speed: 0.2, saturation: 0.8 }),
    createTestNode('2', 'output', LANES.CENTER, 200)
  ];
  
  const edges: Edge[] = [
    createTestEdge('e1-2', '1', '2')
  ];

  // Create currentNodeParameters map
  const currentNodeParameters = new Map<string, Map<string, any>>();
  nodes.forEach(node => {
    const paramMap = new Map<string, any>();
    if (node.data.parameters) {
      for (const key in node.data.parameters) {
        paramMap.set(key, (node.data.parameters as any)[key]);
      }
    }
    currentNodeParameters.set(node.id, paramMap);
  });
  
  // Serialize the pattern
  const serialized = serializePattern(nodes, edges, currentNodeParameters);
  
  // Verify serialization
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 1, // Output node is not included in serialized.nodes
    `Serialized pattern should have 1 node (output node excluded). Got: ${serialized.nodes.length}`
  );
  
  passed = passed && assert(
    serialized.nodes.some(n => n.t === 'rainbow'),
    'Serialized pattern should contain a rainbow node'
  );
    
  // Check that parameters were preserved
  const rainbowNode = serialized.nodes.find(n => n.t === 'rainbow');
  passed = passed && assert(
    rainbowNode?.p?.speed === 0.2 && rainbowNode?.p?.saturation === 0.8,
    'Rainbow node parameters should be preserved'
  );
  
  // Check buffer assignments
  passed = passed && assert(
    typeof rainbowNode?.o === 'number',
    'Rainbow node should have an output buffer assigned'
  );
  
  return passed;
});

// Test 2: Deserialization back to the correct nodes and edges
test('Deserialization back to the correct nodes and edges', () => {
  // Create a serialized pattern
  const serialized: SerializedPattern = {
    nodes: [
      { t: 'rainbow', p: { speed: 0.3, angle: 45 }, o: 1 },
    ],
    meta: { output: 1, name: "Test Pattern" } 
  };
  
  // Deserialize the pattern
  const { nodes, edges, nodeParameters } = deserializePattern(serialized);
  
  // Verify deserialization
  let passed = true;
  
  passed = passed && assert(
    nodes.length === 2, 
    `Deserialized pattern should have 2 nodes (rainbow + final output). Got: ${nodes.length}`
  );
  
  passed = passed && assert(
    edges.length === 1,
    `Deserialized pattern should have 1 edge (rainbow to final output). Got: ${edges.length}`
  );
  
  // Check node types
  const rainbowNode = nodes.find(n => n.data.type === 'rainbow');
  const outputNode = nodes.find(n => n.data.type === 'output'); 
  
  passed = passed && assert(!!rainbowNode, 'Rainbow node should be present');
  passed = passed && assert(!!outputNode, 'Final output node should be present');
  
  passed = passed && assert(
    (rainbowNode?.data.parameters as any)?.speed === 0.3 && 
    (rainbowNode?.data.parameters as any)?.angle === 45,
    'Rainbow node parameters should be preserved'
  );
  
  passed = passed && assert(
    edges[0].source === rainbowNode?.id && edges[0].target === outputNode?.id,
    'Edge should connect rainbow to final output'
  );
  
  return passed;
});

// Test 3: Complex patterns with blend nodes
test('Complex patterns with blend nodes', () => {
  const nodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.LEFT, 100, { speed: 0.2 }),
    createTestNode('2', 'gradient', LANES.RIGHT, 100, { color1: '#ff0000', color2: '#0000ff' }),
    createTestNode('3', 'blend', LANES.CENTER, 200, { opacity: 0.7, blendMode: 'multiply' }),
    createTestNode('4', 'output', LANES.CENTER, 300) 
  ];
  
  const edges: Edge[] = [
    createTestEdge('e1-3', '1', '3', 'output', 'input-1'),
    createTestEdge('e2-3', '2', '3', 'output', 'input-2'),
    createTestEdge('e3-4', '3', '4')
  ];

  const currentNodeParameters = new Map<string, Map<string, any>>();
  nodes.forEach(node => {
    const paramMap = new Map<string, any>();
    if (node.data.parameters) {
      for (const key in node.data.parameters) {
        paramMap.set(key, (node.data.parameters as any)[key]);
      }
    }
    currentNodeParameters.set(node.id, paramMap);
  });
  
  const serialized = serializePattern(nodes, edges, currentNodeParameters);
  
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 3, 
    `Serialized pattern should have 3 nodes. Got: ${serialized.nodes.length}`
  );
  
  const blendNode = serialized.nodes.find(n => n.t === 'blend');
  passed = passed && assert(!!blendNode, 'Blend node should be present');
  
  passed = passed && assert(
    blendNode?.p?.opacity === 0.7 && blendNode?.p?.blendMode === 'multiply',
    'Blend node parameters should be preserved'
  );
  
  passed = passed && assert(
    typeof blendNode?.i !== 'undefined' && typeof blendNode?.i2 !== 'undefined',
    'Blend node should have two input buffers'
  );
  
  return passed;
});

// Test 4: Round-trip serialization/deserialization integrity
test('Round-trip serialization/deserialization integrity', () => {
  const originalNodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.LEFT, 100, { speed: 0.2, saturation: 0.9 }),
    createTestNode('2', 'perlin_noise', LANES.RIGHT, 100, { scale: 0.5, octaves: 4 }),
    createTestNode('3', 'blend', LANES.CENTER, 200, { opacity: 0.6 }),
    createTestNode('4', 'output', LANES.CENTER, 300) 
  ];
  
  const originalEdges: Edge[] = [
    createTestEdge('e1-3', '1', '3', 'output', 'input-1'),
    createTestEdge('e2-3', '2', '3', 'output', 'input-2'),
    createTestEdge('e3-4', '3', '4')
  ];

  const currentNodeParameters = new Map<string, Map<string, any>>();
  originalNodes.forEach(node => {
    const paramMap = new Map<string, any>();
    if (node.data.parameters) {
      for (const key in node.data.parameters) {
        paramMap.set(key, (node.data.parameters as any)[key]);
      }
    }
    currentNodeParameters.set(node.id, paramMap);
  });
  
  const serialized = serializePattern(originalNodes, originalEdges, currentNodeParameters, "RoundTripTest");
  
  const { nodes: roundTripNodes, edges: roundTripEdges, nodeParameters: roundTripNodeParameters } = deserializePattern(serialized);
  
  const reserializedPattern = serializePattern(roundTripNodes, roundTripEdges, roundTripNodeParameters, "RoundTripTest");
  
  const { meta: _, ...serializedWithoutMeta } = serialized;
  const { meta: __, ...reserializedWithoutMeta } = reserializedPattern;
  
  return assertDeepEqual(
    serializedWithoutMeta,
    reserializedWithoutMeta,
    'Round-trip serialization should preserve pattern structure'
  );
});

// Test 5: Edge cases - empty pattern
test('Empty pattern serialization', () => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const currentNodeParameters = new Map<string, Map<string, any>>();
  
  const serialized = serializePattern(nodes, edges, currentNodeParameters);
  
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 0,
    'Serialized empty pattern should have 0 nodes'
  );
  
  const { nodes: deserializedNodes, edges: deserializedEdges } = deserializePattern(serialized);
  
  passed = passed && assert(
    deserializedNodes.length === 1 && deserializedNodes[0].data.type === 'output' && deserializedEdges.length === 0,
    `Deserialized empty pattern should have 1 output node and 0 edges. Got nodes: ${deserializedNodes.length}, edges: ${deserializedEdges.length}`
  );
  
  return passed;
});

// Test 6: Edge cases - pattern with nodes but no connections
test('Pattern with nodes but no connections', () => {
  const nodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.LEFT, 100),
    createTestNode('2', 'gradient', LANES.CENTER, 100),
    createTestNode('3', 'output', LANES.RIGHT, 100) 
  ];
  
  const edges: Edge[] = [];
  const currentNodeParameters = new Map<string, Map<string, any>>();
   nodes.forEach(node => { 
    const paramMap = new Map<string, any>();
    if (node.data.parameters) {
      for (const key in node.data.parameters) {
        paramMap.set(key, (node.data.parameters as any)[key]);
      }
    }
    currentNodeParameters.set(node.id, paramMap);
  });

  const serialized = serializePattern(nodes, edges, currentNodeParameters);
  
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 2, 
    `Serialized pattern should have 2 nodes. Got: ${serialized.nodes.length}`
  );
  
  const rainbowNode = serialized.nodes.find(n => n.t === 'rainbow');
  passed = passed && assert(
    typeof rainbowNode?.o === 'number' && typeof rainbowNode?.i === 'undefined',
    'Rainbow node should have output buffer but no input buffer'
  );
  
  const { nodes: deserializedNodes, edges: deserializedEdges } = deserializePattern(serialized);
  
  passed = passed && assert(
    deserializedNodes.length === 3 && deserializedEdges.length === 0,
    `Deserialized pattern should have 3 nodes and 0 edges. Got nodes: ${deserializedNodes.length}, edges: ${deserializedEdges.length}`
  );
  
  return passed;
});

// Run all tests
console.log('Running pattern serialization tests...\n');

tests.forEach(({ name, fn }) => {
  console.log(`Testing: ${name}`);
  try {
    const passed = fn();
    if (passed) {
      console.log(`  ✅ Passed\n`);
      passedTests++;
    } else {
      console.log(`  ❌ Failed\n`);
      failedTests++;
    }
  } catch (error) {
    console.error(`  ❌ Error: ${error}\n`);
    failedTests++;
  }
});

// Report results
console.log(`Test Results: ${passedTests} passed, ${failedTests} failed`);
if (failedTests === 0) {
  console.log('✅ All tests passed!');
} else {
  console.log('❌ Some tests failed.');
  process.exit(1); // Exit with error code if tests fail
}
