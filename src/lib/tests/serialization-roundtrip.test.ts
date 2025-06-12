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
 * - Perlin Noise (middle)
 * - Raindrops (right)
 * - Moving Blob (left)
 * - Two Blend nodes (middle and bottom right)
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
  getNodeDefinition
} from '../flowStore';

// Test utilities
const TEST_PATTERN_NAME = 'Complex Test Pattern';
const VERBOSE_LOGGING = true; // Set to true for detailed test output

function log(...args: any[]): void {
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
}

// Helper to create node parameters map
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
    else if (JSON.stringify(val1) !== JSON.stringify(val2)) {
      return false;
    }
  }
  
  return true;
}

// Helper to find an edge between two nodes with specific handles
function findEdge(
  edges: Edge[], 
  sourceId: string, 
  targetId: string, 
  sourceHandle: string = 'output',
  targetHandle?: string
): Edge | undefined {
  return edges.find(e => 
    e.source === sourceId && 
    e.target === targetId && 
    e.sourceHandle === sourceHandle &&
    (targetHandle ? e.targetHandle === targetHandle : true)
  );
}

// Verify edges match the expected connections
function verifyEdgeConnections(edges: Edge[], expectedConnections: {source: string, target: string, sourceHandle?: string, targetHandle?: string}[]): boolean {
  if (edges.length !== expectedConnections.length) {
    log(`❌ Edge count mismatch: expected ${expectedConnections.length}, got ${edges.length}`);
    return false;
  }
  
  for (const expected of expectedConnections) {
    const edge = findEdge(
      edges, 
      expected.source, 
      expected.target,
      expected.sourceHandle || 'output',
      expected.targetHandle
    );
    
    if (!edge) {
      log(`❌ Missing edge: ${expected.source} -> ${expected.target} (${expected.targetHandle || 'input'})`);
      return false;
    }
  }
  
  return true;
}

// Main test function
function runRoundtripTest(): boolean {
  log('🧪 Starting pattern serialization round-trip test');
  
  // 1. Create the test pattern matching the exact structure provided by the user
  log('📝 Creating test pattern with 7 nodes and custom connections');
  
  // Create nodes with the exact structure from $flowNodes
  const testNodes: Node[] = [
    {
      "id": "1",
      "type": "pattern",
      "position": {
        "x": 25,
        "y": -430
      },
      "data": {
        "label": "Rainbow",
        "type": "rainbow",
        "parameters": {
          "speed": 0.2,
          "saturation": 0.9,
          "value": 1.0,
          "angle": 45
        }
      },
      "style": ""
    },
    {
      "id": "2",
      "type": "pattern",
      "position": {
        "x": 175,
        "y": 262
      },
      "data": {
        "label": "Output",
        "type": "output"
      },
      "style": ""
    },
    {
      "id": "3",
      "type": "pattern",
      "position": {
        "x": 175,
        "y": -168.36556147115445
      },
      "data": {
        "label": "Perlin Noise",
        "type": "perlin_noise",
        "parameters": {
          "speed": 75,
          "scale": 0.4,
          "intensity": 1.0,
          "octaves": 4
        }
      },
      "style": ""
    },
    {
      "id": "4",
      "type": "pattern",
      "position": {
        "x": 325,
        "y": -164.32671453388474
      },
      "data": {
        "label": "Moving Blob",
        "type": "moving_blob",
        "parameters": {
          "speed": 1.5,
          "size": 0.3,
          "color": "#00ffff"
        }
      },
      "style": ""
    },
    {
      "id": "5",
      "type": "pattern",
      "position": {
        "x": 25,
        "y": -98.93572303584531
      },
      "data": {
        "label": "Raindrops",
        "type": "raindrops",
        "parameters": {
          "speed": 60,
          "count": 12,
          "size": 0.025,
          "color": "#ffffff"
        }
      },
      "style": ""
    },
    {
      "id": "6",
      "type": "pattern",
      "position": {
        "x": 25,
        "y": 9.043766986553123
      },
      "data": {
        "label": "Blend",
        "type": "blend",
        "parameters": {
          "opacity": 0.7,
          "blendMode": "multiply"
        }
      },
      "style": ""
    },
    {
      "id": "7",
      "type": "pattern",
      "position": {
        "x": 175,
        "y": 106.27063819316709
      },
      "data": {
        "label": "Blend",
        "type": "blend",
        "parameters": {
          "opacity": 0.6,
          "blendMode": "screen"
        }
      },
      "style": ""
    }
  ];
  
  // Create edges with the exact structure from $flowEdges
  const testEdges: Edge[] = [
    {
      "source": "3",
      "sourceHandle": "output",
      "target": "6",
      "targetHandle": "input-2",
      "id": "xy-edge__3output-6input-2"
    },
    {
      "source": "5",
      "sourceHandle": "output",
      "target": "6",
      "targetHandle": "input-1",
      "id": "xy-edge__5output-6input-1"
    },
    {
      "source": "1",
      "sourceHandle": "output",
      "target": "5",
      "targetHandle": "input",
      "id": "xy-edge__1output-5input"
    },
    {
      "source": "4",
      "sourceHandle": "output",
      "target": "7",
      "targetHandle": "input-2",
      "id": "xy-edge__4output-7input-2"
    },
    {
      "source": "1",
      "sourceHandle": "output",
      "target": "4",
      "targetHandle": "input",
      "id": "xy-edge__1output-4input"
    },
    {
      "source": "6",
      "sourceHandle": "output",
      "target": "7",
      "targetHandle": "input-1",
      "id": "xy-edge__6output-7input-1"
    },
    {
      "source": "7",
      "sourceHandle": "output",
      "target": "2",
      "targetHandle": "input",
      "id": "xy-edge__7output-2input"
    }
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
  if (serializedPattern.meta.output === undefined) {
    log('❌ meta.output should be defined');
    testsPassed = false;
  } else {
    log(`✅ Output buffer set to: ${serializedPattern.meta.output}`);
  }
  
  // Check pattern name
  if (serializedPattern.meta.name !== TEST_PATTERN_NAME) {
    log(`❌ Expected pattern name "${TEST_PATTERN_NAME}", got "${serializedPattern.meta.name}"`);
    testsPassed = false;
  } else {
    log(`✅ Pattern name correctly set to: ${serializedPattern.meta.name}`);
  }
  
  // Check that created/modified timestamps are NOT included
  if ('created' in serializedPattern.meta || 'modified' in serializedPattern.meta) {
    log('❌ meta should not include created/modified timestamps');
    testsPassed = false;
  } else {
    log('✅ meta correctly excludes created/modified timestamps');
  }
  
  // Check node parameters are included
  const rainbowNode = serializedPattern.nodes.find(n => n.t === 'rainbow');
  if (!rainbowNode || !rainbowNode.p || rainbowNode.p.speed !== 0.2) {
    log('❌ Node parameters not correctly serialized');
    testsPassed = false;
  } else {
    log('✅ Node parameters correctly serialized');
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
  const requiredTypes = {
    'rainbow': 1,
    'perlin_noise': 1,
    'raindrops': 1,
    'moving_blob': 1,
    'blend': 2,
    'output': 1
  };
  
  Object.entries(requiredTypes).forEach(([type, count]) => {
    if ((nodeTypeCounts[type] || 0) !== count) {
      log(`❌ Expected ${count} ${type} node(s), got ${nodeTypeCounts[type] || 0}`);
      testsPassed = false;
    } else {
      log(`✅ Correct number of ${type} nodes: ${nodeTypeCounts[type]}`);
    }
  });
  
  // Check edge connections
  log('🔍 Verifying edge connections...');
  
  // Expected connections based on the original test edges
  const expectedConnections = [
    { source: findNodeByType(deserializedNodes, 'perlin_noise')?.id, target: findBlendNodeByIndex(deserializedNodes, 0)?.id, targetHandle: 'input-2' },
    { source: findNodeByType(deserializedNodes, 'raindrops')?.id, target: findBlendNodeByIndex(deserializedNodes, 0)?.id, targetHandle: 'input-1' },
    { source: findNodeByType(deserializedNodes, 'rainbow')?.id, target: findNodeByType(deserializedNodes, 'raindrops')?.id, targetHandle: 'input' },
    { source: findNodeByType(deserializedNodes, 'moving_blob')?.id, target: findBlendNodeByIndex(deserializedNodes, 1)?.id, targetHandle: 'input-2' },
    { source: findNodeByType(deserializedNodes, 'rainbow')?.id, target: findNodeByType(deserializedNodes, 'moving_blob')?.id, targetHandle: 'input' },
    { source: findBlendNodeByIndex(deserializedNodes, 0)?.id, target: findBlendNodeByIndex(deserializedNodes, 1)?.id, targetHandle: 'input-1' },
    { source: findBlendNodeByIndex(deserializedNodes, 1)?.id, target: findNodeByType(deserializedNodes, 'output')?.id, targetHandle: 'input' }
  ];
  
  // Filter out any undefined connections (in case node lookup failed)
  const validExpectedConnections = expectedConnections.filter(
    conn => conn.source && conn.target
  ) as {source: string, target: string, sourceHandle?: string, targetHandle?: string}[];
  
  const edgesValid = verifyEdgeConnections(deserializedEdges, validExpectedConnections);
  if (!edgesValid) {
    testsPassed = false;
  } else {
    log('✅ All edge connections correctly recreated');
  }
  
  // Check parameter preservation
  log('🔍 Verifying parameter preservation...');
  
  // Check a few key parameters
  const rainbowNodeDeserialized = findNodeByType(deserializedNodes, 'rainbow');
  if (rainbowNodeDeserialized) {
    const rainbowParams = deserializedParams.get(rainbowNodeDeserialized.id);
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
  
  const blendNodes = findNodesByType(deserializedNodes, 'blend');
  if (blendNodes.length > 0) {
    const blend1Params = deserializedParams.get(blendNodes[0].id);
    if (!blend1Params) {
      log('❌ First blend node parameters not found');
      testsPassed = false;
    } else {
      const opacity = blend1Params.get('opacity');
      const blendMode = blend1Params.get('blendMode');
      
      if (opacity === undefined || opacity !== 0.7) {
        log(`❌ First blend node opacity should be 0.7, got ${opacity}`);
        testsPassed = false;
      } else {
        log(`✅ First blend node opacity correctly preserved: ${opacity}`);
      }
      
      if (blendMode === undefined || blendMode !== 'multiply') {
        log(`❌ First blend node blendMode should be 'multiply', got ${blendMode}`);
        testsPassed = false;
      } else {
        log(`✅ First blend node blendMode correctly preserved: ${blendMode}`);
      }
    }
    
    if (blendNodes.length > 1) {
      const blend2Params = deserializedParams.get(blendNodes[1].id);
      if (!blend2Params) {
        log('❌ Second blend node parameters not found');
        testsPassed = false;
      } else {
        const opacity = blend2Params.get('opacity');
        const blendMode = blend2Params.get('blendMode');
        
        if (opacity === undefined || opacity !== 0.6) {
          log(`❌ Second blend node opacity should be 0.6, got ${opacity}`);
          testsPassed = false;
        } else {
          log(`✅ Second blend node opacity correctly preserved: ${opacity}`);
        }
        
        if (blendMode === undefined || blendMode !== 'screen') {
          log(`❌ Second blend node blendMode should be 'screen', got ${blendMode}`);
          testsPassed = false;
        } else {
          log(`✅ Second blend node blendMode correctly preserved: ${blendMode}`);
        }
      }
    }
  }
  
  // Check vertical positioning (top-down flow)
  log('🔍 Verifying top-down node positioning...');
  
  // Verify that nodes are positioned in a top-down flow
  const isTopDown = verifyTopDownFlow(deserializedNodes, deserializedEdges);
  if (!isTopDown) {
    log('❌ Nodes are not properly arranged in top-down flow');
    testsPassed = false;
  } else {
    log('✅ Nodes are properly arranged in top-down flow');
  }
  
  // 6. Test against the specific JSON format provided by the user
  log('🔍 Testing against specific JSON format...');
  /*  Indices (0-based) of nodes as they appear in the array:
      0 – rainbow
      1 – perlin_noise
      2 – raindrops
      3 – moving_blob
      4 – blend (first)
      5 – blend (second)
  */
  const testJson = `{
    "nodes":[
      { "t":"rainbow","o":0 },
      { "t":"perlin_noise","o":1 },
      { "t":"raindrops","o":0, "i":0, "s":0 },
      { "t":"moving_blob","o":2, "i":0, "s":0 },
      { "t":"blend","o":0, "i":0, "s":2, "i2":1, "s2":1 },
      { "t":"blend","o":1, "i":0, "s":4, "i2":2, "s2":3 }
    ],
    "meta":{"output":1}
  }`;
  
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
    const hasAllTypes = Object.keys(requiredTypes).every(type => 
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
      // Count edges going to blend nodes
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

// Helper to find a node by type
function findNodeByType(nodes: Node[], type: string): Node | undefined {
  return nodes.find(n => n.data.type === type);
}

// Helper to find all nodes of a specific type
function findNodesByType(nodes: Node[], type: string): Node[] {
  return nodes.filter(n => n.data.type === type);
}

// Helper to find a blend node by index
function findBlendNodeByIndex(nodes: Node[], index: number): Node | undefined {
  const blendNodes = findNodesByType(nodes, 'blend');
  return blendNodes[index];
}

// Helper to verify top-down flow
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
