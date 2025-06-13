/**
 * Pattern Serialization Test: Manual UI Simulation & Buffer Conflict Resolution
 *
 * This test manually constructs a pattern graph (nodes and edges) as it would
 * be created and managed within the editor UI. It then serializes this graph
 * and verifies that the node ordering correctly handles a specific buffer
 * conflict scenario, ensuring that nodes that overwrite a buffer are placed
 * after nodes that only read from it.
 *
 * The pattern involves:
 * - 'strobe' (generator, outputs to lane 0)
 * - 'moving_blob' (reads from strobe, outputs to lane 1)
 * - 'raindrops' (reads from strobe, outputs to lane 2)
 * - 'sparkle' (reads from strobe, outputs to lane 0 - this is the buffer conflict)
 *
 * Expected serialized order: [strobe, moving_blob, raindrops, sparkle]
 * (Sparkle, being an overwriter of buffer 0, should come last among the nodes
 * that read from strobe's output on buffer 0).
 */

import type { Node, Edge } from '@xyflow/svelte';
import {
  serializePattern,
  deserializePattern,
  type SerializedPattern
} from '../patternSerializer';
import {
  NODE_TYPES,
  LANES,
  getNodeDefinition,
  getNodeBuffer
} from '../flowStore';

// Test utilities
function log(...args: any[]): void {
  // Set to true for detailed test output, false for quiet
  const VERBOSE_LOGGING = true;
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
}

// Helper to create test nodes mimicking UI creation
function createTestNode(
  id: string,
  type: string,
  x: number,
  y: number,
  customParams: Record<string, any> = {}
): Node {
  const nodeType = NODE_TYPES.find(nt => nt.type === type);
  if (!nodeType) {
    throw new Error(`Unknown node type: ${type}`);
  }

  return {
    id,
    type: 'pattern', // All pattern nodes have type 'pattern' in SvelteFlow
    position: { x, y },
    data: {
      label: nodeType.name,
      type: nodeType.type,
      // Parameters are typically managed by flowStore, but we can simulate them here
      parameters: customParams
    },
    style: ''
  };
}

// Helper to create test edges
function createTestEdge(
  source: string,
  target: string,
  sourceHandle: string = 'output',
  targetHandle: string = 'input'
): Edge {
  return {
    id: `e_${source}-${target}_${sourceHandle}-${targetHandle}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    style: 'stroke-width: 3; stroke: #666;', // Default style
    markerEnd: {
      type: 'arrowclosed',
      color: '#666'
    }
  };
}

// Helper to create a node parameters map from test nodes
function createNodeParametersMap(
  nodes: Node[]
): Map<string, Map<string, any>> {
  const paramsMap = new Map<string, Map<string, any>>();

  nodes.forEach(node => {
    const nodeType = NODE_TYPES.find(nt => nt.type === node.data.type);
    if (!nodeType) return;

    const nodeParams = new Map<string, any>();

    // Set default values first
    nodeType.params.forEach(param => {
      nodeParams.set(param.name, param.default);
    });

    // Override with custom values from node.data.parameters
    if (node.data.parameters) {
      Object.entries(node.data.parameters).forEach(([key, value]) => {
        nodeParams.set(key, value);
      });
    }

    paramsMap.set(node.id, nodeParams);
  });

  return paramsMap;
}

function runManualSerializationTest(): boolean {
  log('🧪 Starting manual UI simulation serialization test');
  let testsPassed = true;

  try {
    // 1. Manually create the pattern as if in the editor UI
    log('📝 Creating test pattern nodes and edges...');

    const testNodes: Node[] = [
      createTestNode('strobe_node', 'strobe', LANES.LEFT, 100),
      createTestNode('moving_blob_node', 'moving_blob', LANES.CENTER, 200),
      createTestNode('raindrops_node', 'raindrops', LANES.RIGHT, 200),
      createTestNode('sparkle_node', 'sparkle', LANES.LEFT, 300),
      createTestNode('output_node', 'output', LANES.CENTER, 400) // Output node
    ];

    const testEdges: Edge[] = [
      createTestEdge('strobe_node', 'moving_blob_node'),
      createTestEdge('strobe_node', 'raindrops_node'),
      createTestEdge('strobe_node', 'sparkle_node'),
      // In Grant's scenario the final output buffer is lane 1, produced by
      // `moving_blob`. Therefore we connect **moving_blob** to the output
      // node instead of `sparkle`.
      createTestEdge('moving_blob_node', 'output_node')
    ];

    // Create the node parameters map as flowStore would
    const nodeParametersMap = createNodeParametersMap(testNodes);

    // 2. Serialize the manually created pattern
    log('🔄 Serializing manually created pattern...');
    const serializedPattern = serializePattern(
      testNodes,
      testEdges,
      nodeParametersMap,
      'Manual Buffer Conflict Test'
    );

    log('📊 Re-serialized pattern structure:', JSON.stringify(serializedPattern, null, 2));

    // 3. Verify the node ordering for buffer conflict resolution
    log('🔍 Verifying node ordering for buffer conflict...');
    const reSerializedNodes = serializedPattern.nodes;

    const strobeIdx = reSerializedNodes.findIndex(n => n.t === 'strobe');
    const movingBlobIdx = reSerializedNodes.findIndex(n => n.t === 'moving_blob');
    const raindropsIdx = reSerializedNodes.findIndex(n => n.t === 'raindrops');
    const sparkleIdx = reSerializedNodes.findIndex(n => n.t === 'sparkle');

    if (strobeIdx === -1 || movingBlobIdx === -1 || raindropsIdx === -1 || sparkleIdx === -1) {
      log('❌ Could not find all required nodes for ordering check.');
      testsPassed = false;
    } else {
      // Strobe should be first among these four
      if (strobeIdx > movingBlobIdx || strobeIdx > raindropsIdx || strobeIdx > sparkleIdx) {
        log('❌ Strobe node is not positioned correctly (should be earliest).');
        testsPassed = false;
      } else {
        log('✅ Strobe node positioned correctly.');
      }

      // Sparkle (overwriter) should come after moving_blob and raindrops (readers)
      if (sparkleIdx < movingBlobIdx || sparkleIdx < raindropsIdx) {
        log('❌ Sparkle node is positioned too early (should be after readers).');
        testsPassed = false;
      } else {
        log('✅ Sparkle node positioned correctly after readers.');
      }

      // Verify the exact expected order: [strobe, moving_blob, raindrops, sparkle]
      // (moving_blob and raindrops order relative to each other doesn't matter,
      // but they must be after strobe and before sparkle)
      const expectedOrder = ['strobe', 'moving_blob', 'raindrops', 'sparkle'];
      const actualOrder = reSerializedNodes
        .filter(n => expectedOrder.includes(n.t))
        .map(n => n.t);

      // Check if strobe is first
      if (actualOrder[0] !== 'strobe') {
        log(`❌ Expected strobe first, got ${actualOrder[0]}`);
        testsPassed = false;
      }

      // Check if sparkle is last
      if (actualOrder[actualOrder.length - 1] !== 'sparkle') {
        log(`❌ Expected sparkle last, got ${actualOrder[actualOrder.length - 1]}`);
        testsPassed = false;
      }

      // Check that moving_blob and raindrops are between strobe and sparkle
      const readers = actualOrder.slice(1, actualOrder.length - 1);
      if (!readers.includes('moving_blob') || !readers.includes('raindrops')) {
        log('❌ moving_blob or raindrops not correctly positioned between strobe and sparkle.');
        testsPassed = false;
      } else {
        log('✅ moving_blob and raindrops correctly positioned between strobe and sparkle.');
      }
    }

  } catch (error) {
    log('❌ An error occurred during the test:', error);
    testsPassed = false;
  }

  log(`\n🏁 Manual UI Simulation Test ${testsPassed ? 'PASSED' : 'FAILED'}`);
  return testsPassed;
}

// Run the test
try {
  const testResult = runManualSerializationTest();
  if (!testResult) {
    process.exit(1); // Exit with error code if test fails
  }
} catch (error) {
  console.error('❌ TEST EXECUTION ERROR:', error);
  process.exit(1); // Exit with error code on unexpected errors
}
