/**
 * Pattern Serialization Round-Trip Test
 * 
 * This test validates the serialization and deserialization process by:
 * 1. Creating a complex pattern with multiple nodes and connections
 * 2. Setting custom parameter values
 * 3. Serializing the pattern
 * 4. Deserializing it back
 * 5. Verifying all nodes, edges, and parameters are preserved
 * 
 * The test pattern matches the "before" image with:
 * - Rainbow (top left)
 * - Perlin Noise (top center)
 * - Raindrops (top right)
 * - Moving Blob (bottom left)
 * - Two Blend nodes (bottom center and bottom right)
 * - Output node (connected to the second blend)
 */

import { 
  serializePattern, 
  deserializePattern,
  type SerializedPattern
} from '../patternSerializer';
import type { Node, Edge } from '@xyflow/svelte';
import { 
  NODE_TYPES, 
  LANES, 
  type NodeDefinition,
  type Parameter
} from '../flowStore';

// Test utilities
const TEST_PATTERN_NAME = 'Complex Test Pattern';
const VERBOSE_LOGGING = true; // Set to true for detailed test output

function log(...args: any[]): void {
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
}

// Helper to create test nodes with specific positions and parameters
function createTestNode(
  id: string, 
  type: string, 
  x: number, 
  y: number, 
  params: Record<string, any> = {}
): Node {
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

// Helper to create test edges with proper handles
function createTestEdge(
  id: string, 
  source: string, 
  target: string, 
  sourceHandle = 'output', 
  targetHandle = 'input'
): Edge {
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

// Helper to create a node parameters map
function createNodeParametersMap(
  nodes: Node[]
): Map<string, Map<string, any>> {
  const paramsMap = new Map<string, Map<string, any>>();
  
  nodes.forEach(node => {
    const nodeType = NODE_TYPES.find(nt => nt.type === node.data.type);
    if (!nodeType) return;
    
    const nodeParams = new Map<string, any>();
    
    // Set default values first
    nodeType.params.forEach((param: Parameter) => {
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

// Helper to compare two maps deeply
function areMapsEqual(map1: Map<any, any>, map2: Map<any, any>): boolean {
  if (map1.size !== map2.size) return false;
  
  for (const [key, val1] of map1) {
    const val2 = map2.get(key);
    
    // If values are Maps, recursively compare
    if (val1 instanceof Map && val2 instanceof Map) {
      if (!areMapsEqual(val1, val2)) return false;
    } 
    // Otherwise do direct comparison
    else if (val1 !== val2) {
      return false;
    }
  }
  
  return true;
}

// Helper to find an edge between two nodes
function findEdge(
  edges: Edge[], 
  sourceId: string, 
  targetId: string, 
  targetHandle?: string
): Edge | undefined {
  return edges.find(e => 
    e.source === sourceId && 
    e.target === targetId && 
    (targetHandle ? e.targetHandle === targetHandle : true)
  );
}

// Helper to verify node vertical ordering
function verifyTopDownFlow(nodes: Node[], edges: Edge[]): boolean {
  // Build a dependency graph
  const dependencyGraph = new Map<string, string[]>();
  
  // Initialize the graph
  nodes.forEach(node => {
    dependencyGraph.set(node.id, []);
  });
  
  // Add dependencies
  edges.forEach(edge => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    
    if (sourceNode && targetNode) {
      dependencyGraph.get(targetNode.id)?.push(sourceNode.id);
    }
  });
  
  // Check if each node is positioned below its dependencies
  let valid = true;
  nodes.forEach(node => {
    const dependencies = dependencyGraph.get(node.id) || [];
    
    dependencies.forEach(depId => {
      const depNode = nodes.find(n => n.id === depId);
      if (depNode && depNode.position.y >= node.position.y) {
        log(`❌ Node ${node.id} (${node.data.type}) is positioned above its dependency ${depId} (${depNode.data.type})`);
        valid = false;
      }
    });
  });
  
  return valid;
}

// Main test function
function runRoundtripTest(): boolean {
  log('🧪 Starting pattern serialization round-trip test');
  
  // 1. Create the test pattern matching the "before" image
  log('📝 Creating test pattern with 7 nodes and custom connections');
  
  // Create nodes with specific positions and parameters
  // Positioning based on the "before" image:
  // - Rainbow and Moving Blob in left lane (buffer 0)
  // - Perlin Noise in center lane (buffer 1)
  // - Raindrops in right lane (buffer 2)
  // - First Blend in center lane (buffer 1)
  // - Second Blend in right lane (buffer 2)
  const testNodes: Node[] = [
    createTestNode('rainbow', 'rainbow', LANES.LEFT, 100, { 
      speed: 0.2, 
      saturation: 0.9,
      angle: 45
    }),
    createTestNode('perlin', 'perlin_noise', LANES.CENTER, 100, { 
      speed: 75, 
      scale: 0.4,
      octaves: 4
    }),
    createTestNode('raindrops', 'raindrops', LANES.RIGHT, 100, { 
      speed: 60, 
      count: 12,
      color: '#ffffff'
    }),
    createTestNode('blob', 'moving_blob', LANES.LEFT, 300, { 
      speed: 1.5, 
      size: 0.3,
      color: '#00ffff'
    }),
    createTestNode('blend1', 'blend', LANES.CENTER, 300, { 
      opacity: 0.7, 
      blendMode: 'multiply'
    }),
    createTestNode('blend2', 'blend', LANES.RIGHT, 400, { 
      opacity: 0.6, 
      blendMode: 'screen'
    }),
    createTestNode('output', 'output', LANES.CENTER, 500)
  ];
  
  // Create edges matching the "before" image
  const testEdges: Edge[] = [
    // First blend node connections - takes inputs from Raindrops and Perlin
    createTestEdge('e-raindrops-blend1', 'raindrops', 'blend1', 'output', 'input-1'),
    createTestEdge('e-perlin-blend1', 'perlin', 'blend1', 'output', 'input-2'),
    
    // Second blend node connections - takes inputs from first Blend and Moving Blob
    createTestEdge('e-blend1-blend2', 'blend1', 'blend2', 'output', 'input-1'),
    createTestEdge('e-blob-blend2', 'blob', 'blend2', 'output', 'input-2'),
    
    // Output connection - connects to the second blend
    createTestEdge('e-blend2-output', 'blend2', 'output')
  ];
  
  // Create node parameters map
  const nodeParamsMap = createNodeParametersMap(testNodes);
  
  // 2. Serialize the pattern
  log('🔄 Serializing pattern...');
  const serializedPattern = serializePattern(testNodes, testEdges, nodeParamsMap, TEST_PATTERN_NAME);
  
  log('📊 Serialized pattern structure:', JSON.stringify(serializedPattern, null, 2));
  
  // 3. Verify serialized pattern structure
  log('🔍 Verifying serialized pattern structure...');
  
  let testsPassed = true;
  
  // Check node count (output node should be excluded)
  if (serializedPattern.nodes.length !== testNodes.length - 1) {
    log(`❌ Expected ${testNodes.length - 1} serialized nodes, got ${serializedPattern.nodes.length}`);
    testsPassed = false;
  } else {
    log(`✅ Correct number of serialized nodes: ${serializedPattern.nodes.length}`);
  }
  
  // Check that output node is excluded
  if (serializedPattern.nodes.some(n => n.t === 'output')) {
    log('❌ Output node should be excluded from serialized nodes array');
    testsPassed = false;
  } else {
    log('✅ Output node correctly excluded from serialized nodes');
  }
  
  // Check meta.output is set correctly
  const expectedOutputBuffer = serializedPattern.meta.output;
  log(`🔄 Output buffer set to: ${expectedOutputBuffer}`);
  
  // Check pattern name
  if (serializedPattern.meta.name !== TEST_PATTERN_NAME) {
    log(`❌ Expected pattern name "${TEST_PATTERN_NAME}", got "${serializedPattern.meta.name}"`);
    testsPassed = false;
  } else {
    log(`✅ Pattern name correctly set to: ${serializedPattern.meta.name}`);
  }
  
  // 4. Deserialize the pattern
  log('🔄 Deserializing pattern...');
  const { nodes: deserializedNodes, edges: deserializedEdges, nodeParameters: deserializedParams } = 
    deserializePattern(serializedPattern);
  
  log(`📊 Deserialized ${deserializedNodes.length} nodes and ${deserializedEdges.length} edges`);
  
  // 5. Verify deserialized pattern
  log('🔍 Verifying deserialized pattern...');
  
  // Check node count (output node should be added back)
  if (deserializedNodes.length !== testNodes.length) {
    log(`❌ Expected ${testNodes.length} deserialized nodes, got ${deserializedNodes.length}`);
    testsPassed = false;
  } else {
    log(`✅ Correct number of deserialized nodes: ${deserializedNodes.length}`);
  }
  
  // Check edge count
  if (deserializedEdges.length !== testEdges.length) {
    log(`❌ Expected ${testEdges.length} deserialized edges, got ${deserializedEdges.length}`);
    testsPassed = false;
  } else {
    log(`✅ Correct number of deserialized edges: ${deserializedEdges.length}`);
  }
  
  // Check node types
  const nodeTypeCounts: Record<string, number> = {};
  deserializedNodes.forEach(node => {
    const type = node.data.type;
    nodeTypeCounts[type] = (nodeTypeCounts[type] || 0) + 1;
  });
  
  log('📊 Deserialized node types:', nodeTypeCounts);
  
  // Check for required node types
  const requiredTypes = ['rainbow', 'perlin_noise', 'raindrops', 'moving_blob', 'blend', 'output'];
  requiredTypes.forEach(type => {
    const expectedCount = type === 'blend' ? 2 : 1;
    if ((nodeTypeCounts[type] || 0) !== expectedCount) {
      log(`❌ Expected ${expectedCount} ${type} node(s), got ${nodeTypeCounts[type] || 0}`);
      testsPassed = false;
    } else {
      log(`✅ Correct number of ${type} nodes: ${nodeTypeCounts[type]}`);
    }
  });
  
  // Check edge connections
  log('🔍 Verifying edge connections...');
  
  // Find nodes by type
  const findNodeByType = (nodes: Node[], type: string): Node | undefined => {
    return nodes.find(n => n.data.type === type);
  };
  
  const findBlendNodes = (nodes: Node[]): Node[] => {
    return nodes.filter(n => n.data.type === 'blend');
  };
  
  // Get node references
  const outputNode = findNodeByType(deserializedNodes, 'output');
  const rainbowNode = findNodeByType(deserializedNodes, 'rainbow');
  const perlinNode = findNodeByType(deserializedNodes, 'perlin_noise');
  const raindropsNode = findNodeByType(deserializedNodes, 'raindrops');
  const blobNode = findNodeByType(deserializedNodes, 'moving_blob');
  const blendNodes = findBlendNodes(deserializedNodes);
  
  if (!outputNode || !rainbowNode || !perlinNode || !raindropsNode || !blobNode || blendNodes.length !== 2) {
    log('❌ Not all required nodes were found in deserialized result');
    testsPassed = false;
  }
  
  if (outputNode && blendNodes.length >= 2) {
    // Check if output node is connected to a blend node
    const blendToOutput = deserializedEdges.some(e => 
      e.target === outputNode.id && 
      blendNodes.some(bn => bn.id === e.source)
    );
    
    if (!blendToOutput) {
      log('❌ Output node should be connected to a blend node');
      testsPassed = false;
    } else {
      log('✅ Output node correctly connected to blend node');
    }
    
    // Check if blend nodes have dual inputs
    blendNodes.forEach((blendNode, index) => {
      const blendInputs = deserializedEdges.filter(e => e.target === blendNode.id);
      
      if (blendInputs.length !== 2) {
        log(`❌ Blend node ${index + 1} should have exactly 2 inputs, has ${blendInputs.length}`);
        testsPassed = false;
      } else {
        const hasInput1 = blendInputs.some(e => e.targetHandle === 'input-1');
        const hasInput2 = blendInputs.some(e => e.targetHandle === 'input-2');
        
        if (!hasInput1 || !hasInput2) {
          log(`❌ Blend node ${index + 1} should have both input-1 and input-2 connections`);
          testsPassed = false;
        } else {
          log(`✅ Blend node ${index + 1} has correct dual input connections`);
        }
      }
    });
  }
  
  // Check parameter preservation
  log('🔍 Verifying parameter preservation...');
  
  // Check a few key parameters
  if (rainbowNode) {
    const rainbowParams = deserializedParams.get(rainbowNode.id);
    if (!rainbowParams) {
      log('❌ Rainbow node parameters not found');
      testsPassed = false;
    } else {
      const speed = rainbowParams.get('speed');
      if (speed !== 0.2) {
        log(`❌ Rainbow node speed should be 0.2, got ${speed}`);
        testsPassed = false;
      } else {
        log('✅ Rainbow node parameters correctly preserved');
      }
    }
  }
  
  if (blendNodes.length > 0) {
    const blend1Params = deserializedParams.get(blendNodes[0].id);
    if (!blend1Params) {
      log('❌ First blend node parameters not found');
      testsPassed = false;
    } else {
      const opacity = blend1Params.get('opacity');
      const blendMode = blend1Params.get('blendMode');
      
      if (opacity === undefined || (opacity !== 0.7 && opacity !== 0.6)) {
        log(`❌ Blend node opacity should be 0.7 or 0.6, got ${opacity}`);
        testsPassed = false;
      } else {
        log(`✅ Blend node opacity correctly preserved: ${opacity}`);
      }
      
      if (blendMode === undefined || (blendMode !== 'multiply' && blendMode !== 'screen')) {
        log(`❌ Blend node blendMode should be 'multiply' or 'screen', got ${blendMode}`);
        testsPassed = false;
      } else {
        log(`✅ Blend node blendMode correctly preserved: ${blendMode}`);
      }
    }
  }
  
  // Check top-down flow
  log('🔍 Verifying top-down node positioning...');
  const topDownValid = verifyTopDownFlow(deserializedNodes, deserializedEdges);
  if (!topDownValid) {
    log('❌ Nodes are not properly arranged in top-down flow');
    testsPassed = false;
  } else {
    log('✅ Nodes are properly arranged in top-down flow');
  }
  
  // 6. Test against the specific JSON format provided by the user
  log('🔍 Testing against specific JSON format...');
  const testJson = `{"nodes":[{"t":"rainbow","o":0},{"t":"perlin_noise","o":1},{"t":"moving_blob","o":2,"i":0},{"t":"raindrops","o":1,"i":0},{"t":"blend","o":2,"i":1,"i2":1},{"t":"blend","o":0,"i":2,"i2":2}],"meta":{"output":0}}`;
  
  try {
    const parsedJson = JSON.parse(testJson);
    const { nodes, edges, nodeParameters } = deserializePattern(parsedJson);
    
    log(`📊 Parsed test JSON into ${nodes.length} nodes and ${edges.length} edges`);
    
    if (nodes.length !== 7) { // 6 pattern nodes + 1 output node
      log(`❌ Test JSON should deserialize to 7 nodes, got ${nodes.length}`);
      testsPassed = false;
    } else {
      log('✅ Test JSON deserialized to correct number of nodes');
    }
    
    // Check if we have all required node types
    const hasAllTypes = requiredTypes.every(type => 
      nodes.some(n => n.data.type === type)
    );
    
    if (!hasAllTypes) {
      log('❌ Test JSON deserialization missing some required node types');
      testsPassed = false;
    } else {
      log('✅ Test JSON deserialized with all required node types');
    }
    
    // Check if blend nodes have dual inputs
    const blendNodesFromJson = nodes.filter(n => n.data.type === 'blend');
    if (blendNodesFromJson.length !== 2) {
      log(`❌ Test JSON should have 2 blend nodes, got ${blendNodesFromJson.length}`);
      testsPassed = false;
    } else {
      const blendEdges = edges.filter(e => 
        blendNodesFromJson.some(bn => bn.id === e.target)
      );
      
      if (blendEdges.length !== 4) { // 2 inputs per blend node
        log(`❌ Test JSON should have 4 edges to blend nodes, got ${blendEdges.length}`);
        testsPassed = false;
      } else {
        log('✅ Test JSON deserialized with correct blend node connections');
      }
    }
    
  } catch (error) {
    log('❌ Failed to parse or deserialize test JSON:', error);
    testsPassed = false;
  }
  
  // Final result
  log(`\n🏁 Round-trip test ${testsPassed ? 'PASSED' : 'FAILED'}`);
  return testsPassed;
}

// Run the test
try {
  const testResult = runRoundtripTest();
  console.log(`\n${testResult ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  
  // For automated testing environments
  if (!testResult) {
    process.exit(1);
  }
} catch (error) {
  console.error('❌ TEST ERROR:', error);
  process.exit(1);
}
