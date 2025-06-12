/**
 * Pattern Serialization Tests
 * 
 * This file contains tests to verify the serialization and deserialization
 * of LED patterns for transmission to ESP32 devices.
 * 
 * Run with: npx ts-node src/lib/tests/serialization.test.ts
 */

import type { Node, Edge } from '@xyflow/svelte';
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
    type: 'pattern',
    position: { x, y },
    data: { 
      label: nodeType.name,
      type: nodeType.type,
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
      type: 'arrowclosed',
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
  
  // Serialize the pattern
  const serialized = serializePattern(nodes, edges);
  
  // Verify serialization
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 2,
    'Serialized pattern should have 2 nodes'
  );
  
  passed = passed && assert(
    serialized.nodes.some(n => n.t === 'rainbow'),
    'Serialized pattern should contain a rainbow node'
  );
  
  passed = passed && assert(
    serialized.nodes.some(n => n.t === 'output'),
    'Serialized pattern should contain an output node'
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
      { t: 'output', i: 1, o: 0 }
    ]
  };
  
  // Deserialize the pattern
  const { nodes, edges } = deserializePattern(serialized);
  
  // Verify deserialization
  let passed = true;
  
  passed = passed && assert(
    nodes.length === 2,
    'Deserialized pattern should have 2 nodes'
  );
  
  passed = passed && assert(
    edges.length === 1,
    'Deserialized pattern should have 1 edge'
  );
  
  // Check node types
  const rainbowNode = nodes.find(n => n.data.type === 'rainbow');
  const outputNode = nodes.find(n => n.data.type === 'output');
  
  passed = passed && assert(!!rainbowNode, 'Rainbow node should be present');
  passed = passed && assert(!!outputNode, 'Output node should be present');
  
  // Check parameters
  passed = passed && assert(
    rainbowNode?.data.parameters?.speed === 0.3 && 
    rainbowNode?.data.parameters?.angle === 45,
    'Rainbow node parameters should be preserved'
  );
  
  // Check edge connection
  passed = passed && assert(
    edges[0].source === rainbowNode?.id && edges[0].target === outputNode?.id,
    'Edge should connect rainbow to output'
  );
  
  return passed;
});

// Test 3: Complex patterns with blend nodes
test('Complex patterns with blend nodes', () => {
  // Create a pattern with blend nodes
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
  
  // Serialize the pattern
  const serialized = serializePattern(nodes, edges);
  
  // Verify serialization
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 4,
    'Serialized pattern should have 4 nodes'
  );
  
  // Check blend node
  const blendNode = serialized.nodes.find(n => n.t === 'blend');
  passed = passed && assert(!!blendNode, 'Blend node should be present');
  
  passed = passed && assert(
    blendNode?.p?.opacity === 0.7 && blendNode?.p?.blendMode === 'multiply',
    'Blend node parameters should be preserved'
  );
  
  // Check that blend node has two input buffers
  passed = passed && assert(
    typeof blendNode?.i !== 'undefined' && typeof blendNode?.i2 !== 'undefined',
    'Blend node should have two input buffers'
  );
  
  return passed;
});

// Test 4: Round-trip serialization/deserialization integrity
test('Round-trip serialization/deserialization integrity', () => {
  // Create an original pattern
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
  
  // Serialize the pattern
  const serialized = serializePattern(originalNodes, originalEdges);
  
  // Deserialize back to nodes and edges
  const { nodes: roundTripNodes, edges: roundTripEdges } = deserializePattern(serialized);
  
  // Serialize again
  const reserializedPattern = serializePattern(roundTripNodes, roundTripEdges);
  
  // Verify integrity by comparing the two serialized patterns
  // (Ignoring meta fields like timestamps)
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
  
  // Serialize the pattern
  const serialized = serializePattern(nodes, edges);
  
  // Verify serialization
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 0,
    'Serialized empty pattern should have 0 nodes'
  );
  
  // Deserialize back to nodes and edges
  const { nodes: deserializedNodes, edges: deserializedEdges } = deserializePattern(serialized);
  
  passed = passed && assert(
    deserializedNodes.length === 0 && deserializedEdges.length === 0,
    'Deserialized empty pattern should have 0 nodes and 0 edges'
  );
  
  return passed;
});

// Test 6: Edge cases - pattern with nodes but no connections
test('Pattern with nodes but no connections', () => {
  // Create nodes without connections
  const nodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.LEFT, 100),
    createTestNode('2', 'gradient', LANES.CENTER, 100),
    createTestNode('3', 'output', LANES.RIGHT, 100)
  ];
  
  const edges: Edge[] = [];
  
  // Serialize the pattern
  const serialized = serializePattern(nodes, edges);
  
  // Verify serialization
  let passed = true;
  
  passed = passed && assert(
    serialized.nodes.length === 3,
    'Serialized pattern should have 3 nodes'
  );
  
  // Check that nodes have output buffers but no input buffers
  const rainbowNode = serialized.nodes.find(n => n.t === 'rainbow');
  passed = passed && assert(
    typeof rainbowNode?.o === 'number' && typeof rainbowNode?.i === 'undefined',
    'Nodes should have output buffers but no input buffers'
  );
  
  // Deserialize back to nodes and edges
  const { nodes: deserializedNodes, edges: deserializedEdges } = deserializePattern(serialized);
  
  passed = passed && assert(
    deserializedNodes.length === 3 && deserializedEdges.length === 0,
    'Deserialized pattern should have 3 nodes and 0 edges'
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
  process.exit(1);
}
