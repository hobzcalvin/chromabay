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
  
  // No explicit Output node anymore — the graph is just the pattern's own nodes.
  passed = passed && assert(
    nodes.length === 1,
    `Deserialized pattern should have 1 node (rainbow; no Output node). Got: ${nodes.length}`
  );

  passed = passed && assert(
    edges.length === 0,
    `Deserialized pattern should have 0 edges (no Output node to wire). Got: ${edges.length}`
  );

  // Check node types
  const rainbowNode = nodes.find(n => n.data.type === 'rainbow');
  const outputNode = nodes.find(n => n.data.type === 'output');

  passed = passed && assert(!!rainbowNode, 'Rainbow node should be present');
  passed = passed && assert(!outputNode, 'There should be no Output node');
  
  passed = passed && assert(
    (rainbowNode?.data.parameters as any)?.speed === 0.3 &&
    (rainbowNode?.data.parameters as any)?.angle === 45,
    'Rainbow node parameters should be preserved'
  );

  // (No Output node → no edge to assert; the rainbow is itself the inferred display terminal.)

  return passed;
});

// Test 3: Complex patterns with blend nodes
test('Complex patterns with blend nodes', () => {
  const nodes: Node[] = [
    createTestNode('1', 'rainbow', LANES.LEFT, 100, { speed: 60 }),
    createTestNode('2', 'gradient', LANES.RIGHT, 100, { start_hue: 64, end_hue: 192 }),
    createTestNode('3', 'blend', LANES.CENTER, 200, { opacity: 0.7, blend_mode: 2 }),
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
    blendNode?.p?.opacity === 0.7 && blendNode?.p?.blend_mode === 2,
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
    createTestNode('1', 'rainbow', LANES.LEFT, 100, { speed: 60, saturation: 200 }),
    createTestNode('2', 'perlinnoise', LANES.RIGHT, 100, { scale: 0.5, speed: 25 }),
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
  
  // deserializePattern returns an empty graph for empty input by design; the
  // caller (loadSerializedPattern in flowStore) detects 0 nodes and injects a
  // default pattern instead. The serializer itself does not synthesize nodes.
  passed = passed && assert(
    deserializedNodes.length === 0 && deserializedEdges.length === 0,
    `Deserialized empty pattern should be empty (default-pattern fallback lives in the caller). Got nodes: ${deserializedNodes.length}, edges: ${deserializedEdges.length}`
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
  
  // No explicit Output node: the display target is inferred from a terminal node. Both
  // disconnected nodes are terminals, so the serializer picks one deterministically — meta.output
  // is a real lane buffer (>= 0), not the old "black" sentinel.
  passed = passed && assert(
    serialized.meta.output >= 0,
    `Unwired multi-node pattern should infer a terminal buffer (>=0). Got: ${serialized.meta.output}`
  );

  const { nodes: deserializedNodes, edges: deserializedEdges } = deserializePattern(serialized);

  // Deserialization reconstructs the 2 real nodes and no edges (no Output node to wire).
  passed = passed && assert(
    deserializedNodes.length === 2 && deserializedEdges.length === 0,
    `Deserialized pattern should have 2 nodes and 0 edges (no Output node). Got nodes: ${deserializedNodes.length}, edges: ${deserializedEdges.length}`
  );

  passed = passed && assert(
    !deserializedNodes.some(n => n.data.type === 'output'),
    'There should be no reconstructed Output node'
  );

  return passed;
});

// Test 7: An unknown node type in the MIDDLE of the list must not misalign edges.
// Regression: deserialization used to index svelteFlowNodes positionally, but
// unknown types are skipped (not pushed), so once one is skipped the positions
// no longer match serializedPattern.nodes — edges got wired to the wrong nodes
// (or dropped). Deserialization must resolve nodes by their original index.
test('Deserialization handles an unknown node type mid-list without misaligning edges', () => {
  const serialized: SerializedPattern = {
    nodes: [
      { t: 'definitely_not_a_real_operator', o: 0 }, // index 0 — unknown, skipped on load
      { t: 'rainbow', o: 0 },                         // index 1
      { t: 'blend', o: 1, i: 0, i2: 0 },              // index 2 — reads buffer 0 (rainbow)
    ],
    meta: { output: 1, name: 'UnknownMidList' },
  };

  const { nodes, edges } = deserializePattern(serialized);

  let passed = true;

  const rainbow = nodes.find(n => n.data.type === 'rainbow');
  const blend = nodes.find(n => n.data.type === 'blend');
  const output = nodes.find(n => n.data.type === 'output');

  passed = passed && assert(!!rainbow && !!blend && !output,
    'rainbow and blend should be present; there is no reconstructed Output node');
  passed = passed && assert(
    !nodes.some(n => n.data.type === 'definitely_not_a_real_operator'),
    'the unknown node type should be dropped, not created'
  );

  // The blend reads buffer 0, whose only writer is the rainbow node. Its input
  // edge(s) must originate from rainbow — not a positionally-shifted wrong node.
  const blendInputEdges = edges.filter(e => e.target === blend?.id);
  passed = passed && assert(blendInputEdges.length > 0,
    'blend should have its input edge(s) reconstructed');
  passed = passed && assert(
    blendInputEdges.every(e => e.source === rainbow?.id),
    'every blend input edge should originate from the rainbow node'
  );

  // No edge may dangle: every endpoint must be a node that actually exists.
  const nodeIds = new Set(nodes.map(n => n.id));
  passed = passed && assert(
    edges.every(e => nodeIds.has(e.source) && nodeIds.has(e.target)),
    'all edges must reference existing nodes (no dangling references to the dropped node)'
  );

  return passed;
});

// Bridge the self-collected `tests` into Vitest. Operator definitions are loaded
// from the real WASM module by the test harness setup (see harness/setup.ts), so
// these run fully headless.
import { describe, it, expect } from 'vitest';

describe('pattern serialization', () => {
  for (const { name, fn } of tests) {
    it(name, () => {
      expect(fn()).toBe(true);
    });
  }
});
