import { writable } from 'svelte/store';
import type { Node, Edge, Connection } from '@xyflow/svelte';
import { NATIVE_OPERATOR_DEFINITIONS, renderNativeOperator } from './wasmOperators';

// Global start time for synchronized animations across all nodes
export const globalStartTime = writable<number>(performance.now());

// Parameter types
export type ParameterType = 'float' | 'range' | 'integer' | 'hue' | 'color' | 'select';

export interface Parameter {
  label: string;
  name: string;
  type: ParameterType;
  default: any;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

// Store for parameter values - keyed by nodeId, then by parameter name
export const nodeParameters = writable<Map<string, Map<string, any>>>(new Map());

// Helper function to get parameter value for a node
export function getNodeParameter(nodeId: string, paramName: string, defaultValue: any): any {
  let currentParams: Map<string, Map<string, any>> = new Map();
  nodeParameters.subscribe(params => currentParams = params)();
  
  const nodeParams = currentParams.get(nodeId);
  if (nodeParams && nodeParams.has(paramName)) {
    return nodeParams.get(paramName);
  }
  return defaultValue;
}

// Helper function to set parameter value for a node
export function setNodeParameter(nodeId: string, paramName: string, value: any): void {
  nodeParameters.update(params => {
    if (!params.has(nodeId)) {
      params.set(nodeId, new Map());
    }
    params.get(nodeId)!.set(paramName, value);
    return params;
  });
}

// Helper function to ensure all parameters are initialized for a node
export function ensureNodeParametersInitialized(nodeId: string, nodeType: string): void {
  const nodeDefinition = getNodeDefinition(nodeType);
  if (!nodeDefinition) return;
  
  nodeParameters.update(params => {
    if (!params.has(nodeId)) {
      params.set(nodeId, new Map());
    }
    
    const nodeParams = params.get(nodeId)!;
    
    // Initialize any missing parameters with their default values
    nodeDefinition.params.forEach(param => {
      if (!nodeParams.has(param.name)) {
        nodeParams.set(param.name, param.default);
      }
    });
    
    return params;
  });
}

// Helper function for HSL to RGB conversion
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = l - c / 2;
  
  let r = 0, g = 0, b = 0;
  
  if (0 <= h && h < 1/6) {
    r = c; g = x; b = 0;
  } else if (1/6 <= h && h < 2/6) {
    r = x; g = c; b = 0;
  } else if (2/6 <= h && h < 3/6) {
    r = 0; g = c; b = x;
  } else if (3/6 <= h && h < 4/6) {
    r = 0; g = x; b = c;
  } else if (4/6 <= h && h < 5/6) {
    r = x; g = 0; b = c;
  } else if (5/6 <= h && h < 1) {
    r = c; g = 0; b = x;
  }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// Helper function for HSV to RGB conversion
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = v - c;
  
  let r = 0, g = 0, b = 0;
  
  if (0 <= h && h < 1/6) {
    r = c; g = x; b = 0;
  } else if (1/6 <= h && h < 2/6) {
    r = x; g = c; b = 0;
  } else if (2/6 <= h && h < 3/6) {
    r = 0; g = c; b = x;
  } else if (3/6 <= h && h < 4/6) {
    r = 0; g = x; b = c;
  } else if (4/6 <= h && h < 5/6) {
    r = x; g = 0; b = c;
  } else if (5/6 <= h && h < 1) {
    r = c; g = 0; b = x;
  }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// Helper function to convert hex color to RGB
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16)
  ] : [255, 255, 255];
}

// Type for render function parameters
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  totalTime: number; // Total elapsed time in seconds since start
  deltaTime: number; // Time elapsed since last frame in seconds
  width: number;
  height: number;
  getInputNodes: () => any;
  getNodeOutput: (nodeId: string) => ImageData | null;
  nodeId: string;
}

// Type for node definition
export interface NodeDefinition {
  name: string;
  type: string;
  params: Parameter[];
  render: (context: RenderContext) => void;
}

// Helper function to try rendering with native WASM operators
async function tryRenderNativeOperator(
  operatorType: string, 
  totalTime: number, 
  deltaTime: number, 
  width: number, 
  height: number, 
  nodeId: string,
  getNodeOutput?: (nodeId: string) => ImageData | null,
  getInputNodes?: () => any
): Promise<ImageData | null> {
  const nativeOperator = NATIVE_OPERATOR_DEFINITIONS.find(p => p.type === operatorType);
  if (!nativeOperator) {
    console.warn(`Native operator not found: ${operatorType}`);
    return null;
  }

  // Map parameters from node to native operator format
  const parameters = nativeOperator.params.map(param =>
    getNodeParameter(nodeId, param.name, param.default)
  );

  // Extract input buffers for blend operations
  nativeOperator.params.forEach((param, index) => {
    const value = getNodeParameter(nodeId, param.name, param.default);
    parameters[index] = value;
  });

  let inputBuffer1: ImageData | null = null;
  let inputBuffer2: ImageData | null = null;

  // Handle input buffers for blend operations
  if (operatorType === 'blend') {
    const inputs = getInputNodes?.() || {};
    if (inputs.input1) {
      inputBuffer1 = getNodeOutput?.(inputs.input1.id) || null;
    }
    if (inputs.input2) {
      inputBuffer2 = getNodeOutput?.(inputs.input2.id) || null;
    }
  } else {
    // For non-blend operations, pass single input as first buffer
    const inputs = getInputNodes?.() || {};
    if (inputs.input) {
      inputBuffer1 = getNodeOutput?.(inputs.input.id) || null;
    }
  }

  try {
    // Call the native WASM operator
    const operatorName = operatorType as import('./wasmOperators').OperatorType;
    const result = await renderNativeOperator(
      operatorName, // Use the operator type directly 
      width,
      height,
      totalTime * 1000, // Convert to milliseconds
      parameters.reduce((acc, val, idx) => {
        const paramName = nativeOperator.params[idx].name as keyof import('./wasmOperators').NativeOperatorParams;
        acc[paramName] = val;
        return acc;
      }, {} as import('./wasmOperators').NativeOperatorParams),
      inputBuffer1,
      inputBuffer2
    );
    return result;
  } catch (error) {
    console.error('Native operator render failed:', error);
    return null;
  }
}

// Define LED operator node types with their render functions
// Note: Output is first (index 0) so it's not shown in dropdown, operator nodes start from index 1
export const NODE_TYPES: NodeDefinition[] = [
  {
    name: 'Output',
    type: 'output',
    params: [],
    render: () => {
      // Output node doesn't render anything - it just passes through input
    }
  },
  
  // Convert native FastLED operators to the simplified format
  ...NATIVE_OPERATOR_DEFINITIONS.map(nativeOperator => ({
    name: nativeOperator.name,
    type: nativeOperator.type,
    params: nativeOperator.params.map(param => ({
      label: param.label,
      name: param.name,
      type: param.type as ParameterType,
      default: param.default,
      min: param.min,
      max: param.max,
      options: param.options
    })),
    render: ({ ctx, totalTime, deltaTime, width, height, nodeId, getInputNodes, getNodeOutput }: RenderContext) => {
      // For native operators, we'll render a placeholder that shows they're loading
      // The actual native rendering will be handled elsewhere
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, width, height);
      
      // Draw loading text
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Ø', width / 2, height / 2);
      
      // Try to render with WASM if available
      tryRenderNativeOperator(nativeOperator.type, totalTime, deltaTime, width, height, nodeId, getNodeOutput, getInputNodes)
        .then((imageData: ImageData | null) => {
          if (imageData) {
            ctx.putImageData(imageData, 0, 0);
            
            // CRITICAL: Update the node output store after WASM rendering completes
            const outputData = ctx.getImageData(0, 0, width, height);
            nodeOutputs.update(outputs => {
              outputs.set(nodeId, outputData);
              return outputs;
            });
          }
        })
        .catch((error) => {
          console.error(`Error rendering ${nativeOperator.type}:`, error);
        });
    }
  }))
];

// Helper function to get node definition by type
export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_TYPES.find(node => node.type === type);
}

// Define the 3 vertical lanes for node snapping
const LANES = {
  LEFT: 25,
  CENTER: 175,
  RIGHT: 325
};

// Helper function to get which buffer/lane a node is in (0-based indexing)
export function getNodeBuffer(node: Node): number {
  const x = node.position.x;
  const distances = [
    Math.abs(x - LANES.LEFT),
    Math.abs(x - LANES.CENTER), 
    Math.abs(x - LANES.RIGHT)
  ];
  return distances.indexOf(Math.min(...distances)); // Return 0, 1, or 2 (0-based)
}

// Helper function to validate buffer constraints for connections
export function validateBufferConnection(connection: Edge | Connection, nodes: Node[], edges: Edge[]): boolean {
  const target = nodes.find((node) => node.id === connection.target);
  const source = nodes.find((node) => node.id === connection.source);
  
  if (!target || !source) return false;
  
  const sourceBuffer = getNodeBuffer(source);
  const targetBuffer = getNodeBuffer(target);
  
  // Check if source already outputs to this target's lane
  // Exclude the current connection being validated to avoid self-rejection
  const existingOutputsToTargetLane = edges.filter(edge => {
    if (edge.source !== connection.source) return false;
    if (edge.id === (connection as Edge).id) return false; // Exclude self when validating existing edge
    const edgeTarget = nodes.find(n => n.id === edge.target);
    return edgeTarget && getNodeBuffer(edgeTarget) === targetBuffer;
  });
  
  if (existingOutputsToTargetLane.length > 0) {
    return false;
  }
  
  // Special rules for blend nodes
      if (target.data.type === 'blend') {
    const targetHandleId = connection.targetHandle;
    
    // For blend node's second input (input-2), must be from different buffer
    if (targetHandleId === 'input-2' && sourceBuffer === targetBuffer) {
      return false;
    }
  }
  
  return true;
}

// Enhanced connection validation that includes buffer constraints
export function isValidConnectionWithBuffers(connection: Edge | Connection, nodes: Node[], edges: Edge[]): boolean {
  const target = nodes.find((node) => node.id === connection.target);
  const source = nodes.find((node) => node.id === connection.source);
  
  if (!target || !source) return false;
  
  // Prevent self-loops
  if (target.id === source.id) return false;
  
  // Check buffer constraints first
  if (!validateBufferConnection(connection, nodes, edges)) return false;
  
  // Check existing connection limits
  const targetHandleId = connection.targetHandle;
  const isBlendNode = target.data.type === 'blend';
  
  if (isBlendNode) {
    // For blend nodes, each handle can only have one connection
    const existingConnections = edges.filter(edge => 
      edge.target === connection.target && 
      edge.targetHandle === targetHandleId &&
      edge.id !== (connection as Edge).id // Exclude self when validating existing edge
    );
    if (existingConnections.length >= 1) return false;
  } else {
    // For non-blend nodes, only allow one total input connection
    const allTargetConnections = edges.filter(edge => 
      edge.target === connection.target &&
      edge.id !== (connection as Edge).id // Exclude self when validating existing edge
    );
    if (allTargetConnections.length >= 1) return false;
  }
  
  // Check for cycles (existing logic)
  const hasCycle = (node: Node, visited = new Set<string>()): boolean => {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    
    for (const edge of edges) {
      if (edge.source === node.id) {
        const outgoer = nodes.find(n => n.id === edge.target);
        if (outgoer) {
          if (outgoer.id === source.id) return true;
          if (hasCycle(outgoer, visited)) return true;
        }
      }
    }
    return false;
  };
  
  if (hasCycle(target)) return false;
  
  return true;
}

// Helper function to create a node from a node type
export function createNodeFromType(nodeType: NodeDefinition, id: string, position: { x: number, y: number }): Node {
  // Initialize node parameters with default values
  const nodeParams = new Map<string, any>();
  nodeType.params.forEach(param => {
    nodeParams.set(param.name, param.default);
  });
  
  // Set the parameters in the store
  nodeParameters.update(params => {
    params.set(id, nodeParams);
    return params;
  });
  
  return {
    id,
    type: 'pattern',
    position,
    data: { 
      label: nodeType.name,
      type: nodeType.type
    },
    style: ''
  };
}

// Create persistent stores for nodes and edges - will be initialized from patterns
export const flowNodes = writable<Node[]>([]);
export const flowEdges = writable<Edge[]>([]);

// Subscribe to changes to check dirty state
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
function debounceCheckDirty() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(checkPatternDirty, 100);
}

flowNodes.subscribe(() => debounceCheckDirty());
flowEdges.subscribe(() => debounceCheckDirty());
nodeParameters.subscribe(() => debounceCheckDirty());

// Keep track of next available ID
export const nextNodeId = writable(3);

// Dirty state tracking
export const isDirty = writable<boolean>(false);
let originalPatternState: string | null = null;

// Mark pattern as clean (after save or load)
export function markPatternClean(): void {
  const currentState = JSON.stringify(serializeCurrentPattern());
  originalPatternState = currentState;
  isDirty.set(false);
}

// Check if pattern is dirty
export function checkPatternDirty(): void {
  if (originalPatternState === null) {
    isDirty.set(false);
    return;
  }
  
  const currentState = JSON.stringify(serializeCurrentPattern());
  isDirty.set(currentState !== originalPatternState);
}

// Shared store for node outputs so nodes can access each other's rendered data
export const nodeOutputs = writable<Map<string, ImageData>>(new Map());

// Export lanes for use in components
export { LANES };

// Helper function to delete a node and handle rewiring
export function deleteNode(nodeId: string): void {
  // Get current state
  let currentNodes: Node[] = [];
  let currentEdges: Edge[] = [];
  
  flowNodes.subscribe(nodes => currentNodes = nodes)();
  flowEdges.subscribe(edges => currentEdges = edges)();
  
  // Find the node to delete
  const nodeToDelete = currentNodes.find(n => n.id === nodeId);
  if (!nodeToDelete) return;
  
  // Check if it's a blend node
  const isBlendNode = nodeToDelete.data.type === 'blend';
  
  // Get edges connected to this node
  const inputEdges = currentEdges.filter(edge => edge.target === nodeId);
  const outputEdges = currentEdges.filter(edge => edge.source === nodeId);
  
  // If not a blend node and has both input and output connections, rewire them
  if (!isBlendNode && inputEdges.length > 0 && outputEdges.length > 0) {
    // For non-blend nodes, there should be only one input edge
    const inputEdge = inputEdges[0];
    
    // Create new edges connecting the input node directly to all output nodes
    const newEdges = outputEdges.map((outputEdge, index) => ({
      id: `e${inputEdge.source}-${outputEdge.target}-${Date.now()}-${index}`,
      source: inputEdge.source,
      target: outputEdge.target,
      sourceHandle: inputEdge.sourceHandle,
      targetHandle: outputEdge.targetHandle
    }));
    
    // Update edges: remove old edges and add new rewired edges
    flowEdges.update(edges => {
      // Remove all edges connected to the deleted node
      const filteredEdges = edges.filter(edge => 
        edge.source !== nodeId && edge.target !== nodeId
      );
      // Add new rewired edges
      return [...filteredEdges, ...newEdges];
    });
  } else {
    // For blend nodes or nodes without both input/output, just remove connected edges
    flowEdges.update(edges => 
      edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
    );
  }
  
  // Remove the node
  flowNodes.update(nodes => nodes.filter(n => n.id !== nodeId));
  
  // Clean up node parameters
  nodeParameters.update(params => {
    params.delete(nodeId);
    return params;
  });
} 
// Pattern serialization imports and utilities
import type { SerializedPattern } from './patternSerializer';
import { serializePattern, deserializePattern, estimatePatternSize, compressPattern } from './patternSerializer';
import { syncPatternToAllDevices } from './ble';

// Pattern serialization utilities
export function serializeCurrentPattern(patternName?: string): SerializedPattern {
  let currentNodes: Node[] = [];
  let currentEdges: Edge[] = [];
  let currentParams: Map<string, Map<string, any>> = new Map();

  flowNodes.subscribe(nodes => currentNodes = nodes)();
  flowEdges.subscribe(edges => currentEdges = edges)();
  nodeParameters.subscribe(params => currentParams = params)();

  return serializePattern(currentNodes, currentEdges, currentParams, patternName);
}

export function loadSerializedPattern(serializedPattern: SerializedPattern): void {
  const { nodes, edges, nodeParameters: newNodeParameters } = deserializePattern(serializedPattern);
  
  // Update all stores with new pattern
  nodeParameters.set(newNodeParameters);
  flowNodes.set(nodes);
  flowEdges.set(edges);
  
  // Set next node ID to be higher than any existing node ID
  const numericIds = nodes.map(n => parseInt(n.id.replace(/\D+/g, ''), 10)).filter(v => !isNaN(v));
  const maxId = numericIds.length ? Math.max(...numericIds) : 0;
  nextNodeId.set(maxId + 1);
  
  // Mark pattern as clean after loading
  markPatternClean();
}

// Initialize flow with default pattern if no patterns exist
export function initializeDefaultPattern(): void {
  // Create default nodes
  const defaultNodes: Node[] = [
    createNodeFromType(NODE_TYPES[1], '1', { x: LANES.CENTER, y: 100 }),        // First operator node (rainbow)
    createNodeFromType(NODE_TYPES[0], '2', { x: LANES.CENTER, y: 250 })         // Output node
  ];

  // Create default edge
  const defaultEdges: Edge[] = [
    { 
      id: 'e1-2', 
      source: '1', 
      target: '2', 
    }
  ];

  // Set the stores
  flowNodes.set(defaultNodes);
  flowEdges.set(defaultEdges);
  nextNodeId.set(3);
  
  // Mark as clean after initialization
  markPatternClean();
}

// Initialize an empty pattern with just the output node (for when all patterns are deleted)
export function initializeEmptyPattern(): void {
  // Reset all stores first
  nodeParameters.set(new Map());
  
  // Create default output node only
  const outputNode: Node = createNodeFromType(NODE_TYPES[0], '1', { x: LANES.CENTER, y: 250 });

  // Set the stores with just the output node
  flowNodes.set([outputNode]);
  flowEdges.set([]);
  nextNodeId.set(2);
  
  // Mark as clean after initialization
  markPatternClean();
}

export function getPatternSizeEstimate(): number {
  const pattern = serializeCurrentPattern();
  return estimatePatternSize(pattern);
}

export function getPatternForBLE(): string {
  const pattern = serializeCurrentPattern();
  return compressPattern(pattern);
}

// Automatic pattern sync when pattern changes
let lastPatternHash: string | null = null;
let syncTimeout: NodeJS.Timeout | null = null;

function syncPatternIfChanged() {
  try {
    const currentPattern = serializeCurrentPattern();
    const currentHash = JSON.stringify(currentPattern);
    
    if (lastPatternHash && lastPatternHash !== currentHash) {
      console.log('🔄 Pattern changed, scheduling sync...');
      
      // Clear existing timeout if any
      if (syncTimeout) {
        clearTimeout(syncTimeout);
      }
      
      // Debounce pattern sync to avoid excessive calls during editing
      syncTimeout = setTimeout(async () => {
        try {
          console.log('⚡ Executing pattern sync to devices');
          await syncPatternToAllDevices();
          // Logging is now handled in the BLE module based on device connection status
        } catch (error) {
          console.error('Failed to auto-sync pattern:', error);
        }
      }, 500); // 500ms debounce
    }
    
    lastPatternHash = currentHash;
  } catch (error) {
    console.error('Error in pattern sync check:', error);
  }
}

// Subscribe to pattern changes for auto-sync
flowNodes.subscribe(() => syncPatternIfChanged());
flowEdges.subscribe(() => syncPatternIfChanged());
nodeParameters.subscribe(() => syncPatternIfChanged());
