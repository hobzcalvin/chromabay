import { writable, get } from 'svelte/store';
import type { Node, Edge, Connection } from '@xyflow/svelte';
import { clearNodeInteractiveParameters } from './stores/interactiveStore';
import { renderConfig, type RenderConfig } from './renderConfig';

// Global start time for synchronized animations across all nodes
export const globalStartTime = writable<number>(Date.now());

// Update global start time to current timestamp when patterns change
export function resetGlobalStartTime(): void {
  globalStartTime.set(Date.now());
}

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

// Auto-save timeout for debouncing
let autoSaveTimeout: ReturnType<typeof setTimeout> | undefined;

// True only when the global flow store actually holds an editable pattern.
// serializeCurrentPattern drops the output node, so an empty store — or one with
// just the output node — serializes to 0 nodes. That state means "no pattern is
// loaded into the editor" (e.g. the patterns page renders isolated previews and
// never populates the global store), NOT "the user cleared the pattern".
function hasEditablePattern(): boolean {
  return get(flowNodes).some(n => (n.data as { type?: string })?.type !== 'output');
}

// Centralized auto-save function with debouncing
export function triggerAutoSave(reason: string): void {
  // Never autosave while a pattern is being loaded. loadSerializedPattern bulk-
  // mutates the editor stores (nodeParameters/flowNodes/flowEdges .set), which
  // fires the store subscriptions below and would schedule a save of transient,
  // mid-load state — and serializeCurrentPattern uses the *current* pattern name,
  // so a load-triggered save can persist the just-loaded content under the
  // previous pattern's name and clobber it. syncPatternIfChanged already guards
  // on patternLoading; autosave must too.
  if (patternLoading) return;

  // Never autosave an empty editor over the stored pattern. This is the
  // "current pattern cleared on reload" bug: visiting the patterns page (which
  // never loads a pattern into the global store) let the initial subscription
  // fire an autosave of 0 nodes, clobbering the real current pattern.
  if (!hasEditablePattern()) return;

  clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    // A load may have started, or the editor emptied, in the 500ms since this
    // was scheduled — don't persist over the stored pattern.
    if (patternLoading || !hasEditablePattern()) return;
    try {
      const { saveCurrentPattern } = await import('$lib/stores/patternsStore');
      const { currentPatternName } = await import('$lib/stores/patternsStore');
      const { get } = await import('svelte/store');

      const currentName = get(currentPatternName);
      const serialized = serializeCurrentPattern(currentName);
      await saveCurrentPattern(serialized);

      console.log(`📊 Auto-saved pattern after ${reason}`);
    } catch (error) {
      console.error('❌ Failed to auto-save pattern:', error);
    }
  }, 500); // 500ms debounce
}

// Helper function to get parameter value for a node
export function getNodeParameter(nodeId: string, paramName: string, defaultValue: any): any {
  let currentParams: Map<string, Map<string, any>> = new Map();
  nodeParameters.subscribe(params => {
    currentParams = params;
  })();
  
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
  
// Auto-save: Save current pattern whenever a parameter changes
// We use a debounced approach to avoid too many saves during rapid changes
triggerAutoSave('parameter change');
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
  // Optional isolated stores for off-canvas renderers (e.g. the patterns-page
  // preview) that don't live in the global flow stores. When omitted, the WASM
  // render path falls back to the global flowNodes/nodeParameters — so the
  // editor's behavior is unchanged.
  nodes?: Node[];
  nodeParameters?: Map<string, Map<string, any>>;
}

// Type for node definition - now WASM-based
export interface NodeDefinition {
  name: string;
  type: string;
  params: Parameter[];
  render: (context: RenderContext) => void;
}

// WASM Operator Management System
class WasmOperatorManager {
  private wasmModule: any = null;
  private operatorInstances = new Map<string, number>(); // nodeId -> operatorInstanceId
  private operatorTypes = new Map<string, string>(); // nodeId -> operatorType
  
  // 3-Buffer System for ESP32 compatibility
  private buffers: { [key: number]: number } = {}; // buffer index -> WASM pointer
  private bufferSize = 0;
  private currentConfig: RenderConfig = { width: 100, height: 50, maxWidth: 500, maxHeight: 500 };
  private renderConfigUnsubscribe: (() => void) | null = null;
  
  constructor() {
    // Subscribe to render config changes
    if (typeof window !== 'undefined') {
      this.renderConfigUnsubscribe = renderConfig.subscribe(config => {
        this.currentConfig = config;
        // Reallocate buffers if WASM is ready and config changed
        if (this.wasmModule && this.bufferSize > 0) {
          this.reallocateBuffers();
        }
      });
      
      // Wait for WASM to be ready
      if (window.isWasmReady && window.isWasmReady()) {
        this.initializeWasm();
      } else {
        window.addEventListener('wasmReady', () => this.initializeWasm());
      }
    }
  }
  
  private initializeWasm() {
    try {
      this.wasmModule = window.getWasmModule();
      if (!this.wasmModule) {
        console.error('WASM module not available');
        return;
      }
      
      // Initialize 3-buffer system
      this.initializeBuffers();
      console.log('WASM Operator Manager initialized with 3-buffer system');
    } catch (error) {
      console.error('Failed to initialize WASM:', error);
    }
  }
  
  private initializeBuffers() {
    if (!this.wasmModule) return;
    
    // Calculate buffer size using current config dimensions (RGB = 3 bytes per pixel)
    this.bufferSize = this.currentConfig.width * this.currentConfig.height * 3;
    
    // Allocate 3 buffers for ESP32-compatible rendering
    this.buffers[0] = this.wasmModule._malloc(this.bufferSize); // Buffer 0
    this.buffers[1] = this.wasmModule._malloc(this.bufferSize); // Buffer 1  
    this.buffers[2] = this.wasmModule._malloc(this.bufferSize); // Buffer 2
    
    console.log(`Allocated 3 WASM buffers (${this.currentConfig.width}x${this.currentConfig.height}):`, this.buffers);
  }
  
  private reallocateBuffers() {
    if (!this.wasmModule) return;
    
    // Free existing buffers
    for (const buffer of Object.values(this.buffers)) {
      this.wasmModule._free(buffer);
    }
    
    // Reallocate with new dimensions
    this.initializeBuffers();
    console.log(`Reallocated WASM buffers for new dimensions: ${this.currentConfig.width}x${this.currentConfig.height}`);
  }
  
  getAvailableOperators(): NodeDefinition[] {
    if (!this.wasmModule) {
      console.warn('WASM not ready, returning minimal operator list');
      return [this.createOutputNodeDefinition()]; 
    }
    
    try {
      const count = this.wasmModule.ccall('getOperatorCount', 'number', [], []);
      console.log(`WASM operator count: ${count}`);
      
      const operators: NodeDefinition[] = [this.createOutputNodeDefinition()]; // Output node first
      
      for (let i = 0; i < count; i++) {
        try {
          const operatorName = this.safeGetString('getOperatorName', ['number'], [i]);
          if (!operatorName) {
            console.warn(`Failed to get operator name for index ${i}`);
            continue;
          }
          
          console.log(`Processing operator: ${operatorName}`);
          
          const displayName = this.safeGetString('getOperatorDisplayName', ['string'], [operatorName]);
          const paramCount = this.wasmModule.ccall('getOperatorParameterCount', 'number', ['string'], [operatorName]);
          
          console.log(`  Display name: ${displayName}, param count: ${paramCount}`);
          
          const params: Parameter[] = [];
          for (let p = 0; p < paramCount; p++) {
            try {
              const paramInfoJson = this.safeGetString('getOperatorParameterInfo', ['string', 'number'], [operatorName, p]);
              if (paramInfoJson) {
                const paramInfo = JSON.parse(paramInfoJson);
                params.push(this.convertWasmParameter(paramInfo));
              }
            } catch (paramError) {
              console.error(`Error getting parameter ${p} for operator ${operatorName}:`, paramError);
            }
          }
          
          operators.push({
            name: displayName || operatorName,
            type: operatorName, // operatorName is already the short name from getName()
            params,
            render: this.createWasmRenderFunction(operatorName)
          });
          
        } catch (operatorError) {
          console.error(`Error processing operator ${i}:`, operatorError);
        }
      }
      
      console.log(`Successfully loaded ${operators.length} operators`);
      return operators;
    } catch (error) {
      console.error('Error getting WASM operators:', error);
      return [this.createOutputNodeDefinition()];
    }
  }
  
  // Safer string retrieval from WASM with error checking
  private safeGetString(functionName: string, argTypes: string[], args: any[]): string | null {
    try {
      const result = this.wasmModule.ccall(functionName, 'string', argTypes, args);
      if (typeof result === 'string' && result.length > 0) {
        return result;
      }
      return null;
    } catch (error) {
      console.error(`Error calling WASM function ${functionName}:`, error);
      return null;
    }
  }
  
  private createOutputNodeDefinition(): NodeDefinition {
    return {
      name: 'Output',
      type: 'output',
      params: [],
      render: () => {
        // Output node doesn't render anything - it just passes through input
      }
    };
  }
  
  private convertWasmParameter(wasmParam: any): Parameter {
    let type = 'float' as ParameterType;
    
    switch (wasmParam.type) {
      case 0: type = 'float'; break;
      case 1: type = 'integer'; break;
      case 2: type = 'range'; break; // WASM BOOL type - use range for boolean toggle UI
      case 3: type = 'color'; break;
      case 4: type = 'select'; break;
      default: 
        console.warn(`Unknown WASM parameter type ${wasmParam.type}, defaulting to float`);
        type = 'float';
        break;
    }
    
    const param: Parameter = {
      label: wasmParam.label,
      name: wasmParam.name,
      type,
      default: wasmParam.default
    };
    
    // For boolean parameters (type 2), set appropriate min/max for toggle behavior
    if (wasmParam.type === 2) {
      param.min = 0;
      param.max = 1;
      // Ensure default is 0 or 1
      param.default = wasmParam.default ? 1 : 0;
    } else {
      if (wasmParam.min !== undefined) param.min = wasmParam.min;
      if (wasmParam.max !== undefined) param.max = wasmParam.max;
    }
    
    if (wasmParam.options) {
      param.options = wasmParam.options.map((opt: string, index: number) => ({
        value: index.toString(),
        label: opt
      }));
    }
    
    return param;
  }
  
  private createWasmRenderFunction(operatorName: string) {
    return ({ ctx, totalTime, deltaTime, width, height, getInputNodes, getNodeOutput, nodeId, nodes, nodeParameters: ctxParams }: RenderContext) => {
      this.renderNodeWithWasm(nodeId, operatorName, ctx, totalTime, deltaTime, getInputNodes, getNodeOutput, nodes, ctxParams);
    };
  }

  private renderNodeWithWasm(
    nodeId: string,
    operatorName: string,
    ctx: CanvasRenderingContext2D,
    totalTime: number,
    deltaTime: number,
    getInputNodes: () => any,
    getNodeOutput: (nodeId: string) => ImageData | null,
    // When provided (off-canvas previews with isolated stores), use these instead
    // of the global flowNodes/nodeParameters. Falls back to globals otherwise.
    contextNodes?: Node[],
    contextNodeParameters?: Map<string, Map<string, any>>
  ) {
    const { width, height } = this.currentConfig;
    // Ensure operator instance exists
    if (!this.operatorInstances.has(nodeId)) {
      this.createOperatorInstance(nodeId, operatorName);
    }

    // Set parameters from the provided store, or the global store as a fallback.
    const currentParams = contextNodeParameters ?? get(nodeParameters);
    const nodeParams = currentParams.get(nodeId) || new Map();
    this.setNodeParameters(nodeId, nodeParams);

    // Node list used for lane-based buffer assignment: provided (isolated) or global.
    const currentNodes: Node[] = contextNodes ?? get(flowNodes);

    // Find the current node to get its lane-based buffer assignment
    const currentNode = currentNodes.find(n => n.id === nodeId);
    const outputBufferIndex = currentNode ? getNodeBuffer(currentNode) : 0;
    
    let inputBuffer1Index: number | null = null;
    let inputBuffer2Index: number | null = null;
    
    // Handle input buffers using lane-based assignment
    const inputs = getInputNodes();
    
    if ('input1' in inputs && inputs.input1) {
      const inputNode = currentNodes.find(n => n.id === inputs.input1.id);
      inputBuffer1Index = inputNode ? getNodeBuffer(inputNode) : null;
      
      if (inputBuffer1Index !== null) {
        const inputData = getNodeOutput(inputs.input1.id);
        if (inputData) {
          this.copyImageDataToBuffer(inputData, inputBuffer1Index, width, height);
        }
      }
    }
    
    if ('input2' in inputs && inputs.input2) {
      const inputNode = currentNodes.find(n => n.id === inputs.input2.id);
      inputBuffer2Index = inputNode ? getNodeBuffer(inputNode) : null;
      
      if (inputBuffer2Index !== null) {
        const inputData = getNodeOutput(inputs.input2.id);
        if (inputData) {
          this.copyImageDataToBuffer(inputData, inputBuffer2Index, width, height);
        }
      }
    }
    
    // Handle single input for non-blend nodes
    if ('input' in inputs && inputs.input && !('input1' in inputs)) {
      const inputNode = currentNodes.find(n => n.id === inputs.input.id);
      inputBuffer1Index = inputNode ? getNodeBuffer(inputNode) : null;
      
      if (inputBuffer1Index !== null) {
        const inputData = getNodeOutput(inputs.input.id);
        if (inputData) {
          this.copyImageDataToBuffer(inputData, inputBuffer1Index, width, height);
        }
      }
    }
    
    // Execute the WASM operator
    // Canonical timeline: integer milliseconds since page load (performance.now,
    // monotonic). The SAME clock is pushed to devices via the timestamp-sync
    // characteristic (see sendTimestampSync), so the browser preview and the
    // ESP32 render the same frame at the same instant. Wrapped at 1e6 to match
    // the firmware's floatFriendlyTime and keep the value exactly float-representable.
    const operatorTimestamp = Math.floor(performance.now()) % 1000000;
    const deltaTimeMs = Math.floor(deltaTime * 1000);
    
    // Get buffer pointers - use 0 as null pointer for unused inputs
    const inputBuffer1Ptr = inputBuffer1Index !== null ? this.buffers[inputBuffer1Index] : 0;
    const inputBuffer2Ptr = inputBuffer2Index !== null ? this.buffers[inputBuffer2Index] : 0;
    const outputBufferPtr = this.buffers[outputBufferIndex];
    
    this.wasmModule.ccall('renderOperator', null, 
      ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'], 
      [this.operatorInstances.get(nodeId), inputBuffer1Ptr, inputBuffer2Ptr, outputBufferPtr, width, height, operatorTimestamp, deltaTimeMs]
    );
    
    // Copy the buffer data back to canvas
    this.copyBufferToCanvas(outputBufferIndex, ctx, width, height);
  }
  
  createOperatorInstance(nodeId: string, operatorType: string): boolean {
    if (!this.wasmModule || operatorType === 'output') return true;
    
    try {
      const instanceId = this.wasmModule.ccall('createOperatorInstance', 'number', ['string'], [operatorType]);
      if (instanceId !== -1) {
        this.operatorInstances.set(nodeId, instanceId);
        this.operatorTypes.set(nodeId, operatorType);
        console.log(`Created WASM operator instance ${instanceId} for node ${nodeId} (${operatorType})`);
        return true;
      }
    } catch (error) {
      console.error(`Failed to create operator instance for ${nodeId}:`, error);
    }
    return false;
  }
  
  destroyOperatorInstance(nodeId: string): void {
    const instanceId = this.operatorInstances.get(nodeId);
    if (instanceId !== undefined && this.wasmModule) {
      try {
        this.wasmModule.ccall('destroyOperatorInstance', null, ['number'], [instanceId]);
        this.operatorInstances.delete(nodeId);
        this.operatorTypes.delete(nodeId);
      } catch (error) {
        console.error(`Failed to destroy operator instance for ${nodeId}:`, error);
      }
    }
  }
  
  setNodeParameters(nodeId: string, nodeParams: Map<string, any>): void {
    const instanceId = this.operatorInstances.get(nodeId);
    const operatorType = this.operatorTypes.get(nodeId);
    if (instanceId === undefined || !this.wasmModule || !operatorType) return;
    
    try {
      const paramCount = this.wasmModule.ccall('getOperatorParameterCount', 'number', ['string'], [operatorType]);
      
      for (let i = 0; i < paramCount; i++) {
        try {
          const paramInfoJson = this.safeGetString('getOperatorParameterInfo', ['string', 'number'], [operatorType, i]);
          if (!paramInfoJson) continue;
          
          const paramInfo = JSON.parse(paramInfoJson);
          const value = nodeParams.get(paramInfo.name);
          
          if (value !== undefined) {
            switch (paramInfo.type) {
              case 0: // FLOAT
                this.wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [instanceId, i, parseFloat(value) || 0]);
                break;
              case 1: // INT
                this.wasmModule.ccall('setOperatorIntParameter', null, ['number', 'number', 'number'], [instanceId, i, parseInt(value) || 0]);
                break;
              case 2: // BOOL
                this.wasmModule.ccall('setOperatorBoolParameter', null, ['number', 'number', 'number'], [instanceId, i, value ? 1 : 0]);
                break;
              case 3: // COLOR
                if (typeof value === 'string' && value.startsWith('#') && value.length === 7) {
                  const r = parseInt(value.substring(1, 3), 16) || 0;
                  const g = parseInt(value.substring(3, 5), 16) || 0;
                  const b = parseInt(value.substring(5, 7), 16) || 0;
                  this.wasmModule.ccall('setOperatorColorParameter', null, ['number', 'number', 'number', 'number', 'number'], [instanceId, i, r, g, b]);
                }
                break;
              case 4: // SELECT  
                this.wasmModule.ccall('setOperatorStringParameter', null, ['number', 'number', 'string'], [instanceId, i, String(value)]);
                break;
            }
          }
        } catch (paramError) {
          console.error(`Error setting parameter ${i} for node ${nodeId}:`, paramError);
        }
      }
    } catch (error) {
      console.error(`Failed to set parameters for node ${nodeId}:`, error);
    }
  }
  
  copyImageDataToBuffer(imageData: ImageData, bufferIndex: number, width: number, height: number): void {
    if (!this.wasmModule || !this.buffers[bufferIndex]) return;
    
    const buffer = new Uint8Array(this.wasmModule.HEAPU8.buffer, this.buffers[bufferIndex], this.bufferSize);
    const data = imageData.data;
    
    // Use the current config dimensions for buffer operations
    const configWidth = this.currentConfig.width;
    const configHeight = this.currentConfig.height;
    
    // Convert RGBA to RGB, handling potential size differences between canvas and buffer
    const pixelCount = Math.min(width * height, configWidth * configHeight);
    for (let i = 0; i < pixelCount; i++) {
      buffer[i * 3] = data[i * 4];     // R
      buffer[i * 3 + 1] = data[i * 4 + 1]; // G  
      buffer[i * 3 + 2] = data[i * 4 + 2]; // B
    }
  }
  
  copyBufferToCanvas(bufferIndex: number, ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.wasmModule || !this.buffers[bufferIndex]) return;
    
    const buffer = new Uint8Array(this.wasmModule.HEAPU8.buffer, this.buffers[bufferIndex], this.bufferSize);
    
    // Use the current config dimensions for buffer operations
    const configWidth = this.currentConfig.width;
    const configHeight = this.currentConfig.height;
    
    const imageData = new ImageData(configWidth, configHeight);
    
    // Convert RGB to RGBA
    for (let i = 0; i < configWidth * configHeight; i++) {
      imageData.data[i * 4] = buffer[i * 3];     // R
      imageData.data[i * 4 + 1] = buffer[i * 3 + 1]; // G
      imageData.data[i * 4 + 2] = buffer[i * 3 + 2]; // B
      imageData.data[i * 4 + 3] = 255;          // A
    }
    
    ctx.putImageData(imageData, 0, 0);
  }
  
  // Destroy every WASM operator instance — used when loading/switching to a
  // whole new pattern. Without this, replacing the node store leaks the old
  // patterns' WASM-side instances (they were only ever freed one-at-a-time by
  // deleteNode). Instances are recreated lazily on the next render.
  destroyAllInstances(): void {
    for (const [nodeId] of this.operatorInstances) {
      this.destroyOperatorInstance(nodeId);
    }
  }

  cleanup(): void {
    for (const [nodeId] of this.operatorInstances) {
      this.destroyOperatorInstance(nodeId);
    }

    if (this.wasmModule) {
      for (const buffer of Object.values(this.buffers)) {
        this.wasmModule._free(buffer);
      }
    }
    
    this.buffers = {};
    
    // Unsubscribe from render config changes
    if (this.renderConfigUnsubscribe) {
      this.renderConfigUnsubscribe();
      this.renderConfigUnsubscribe = null;
    }
  }
}

// Global WASM operator manager
let wasmOperatorManager: WasmOperatorManager | null = null;

// Initialize WASM manager only in browser environment
if (typeof window !== 'undefined') {
  wasmOperatorManager = new WasmOperatorManager();
  
  // Global cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (wasmOperatorManager) {
      wasmOperatorManager.cleanup();
    }
  });
}

export function getWasmOperatorManager(): WasmOperatorManager | null {
  return wasmOperatorManager;
}

// Dynamic NODE_TYPES loaded from WASM - using a writable store for reactivity
export const nodeTypesStore = writable<NodeDefinition[]>([]);

// Legacy export that returns the current value (for backwards compatibility with non-reactive code)
export function getNodeTypes(): NodeDefinition[] {
  return get(nodeTypesStore);
}

// For code that still uses NODE_TYPES directly (read-only access to current value)
// Note: This is NOT reactive - use nodeTypesStore for reactive access
export let NODE_TYPES: NodeDefinition[] = [];

function loadOperatorsFromWasm() {
  const manager = getWasmOperatorManager();
  let operators: NodeDefinition[];
  
  if (manager) {
    operators = manager.getAvailableOperators();
    console.log(`Loaded ${operators.length} operators from WASM:`, operators.map(op => op.name));
  } else {
    // Fallback for SSR
    operators = [{
      name: 'Output',
      type: 'output', 
      params: [],
      render: () => {}
    }];
  }
  
  // Update the store (triggers reactive updates in subscribed components)
  nodeTypesStore.set(operators);
  console.log(`nodeTypesStore updated with ${operators.length} operators`);
  
  // Also update the legacy variable for non-reactive code
  NODE_TYPES = operators;
}

// Initialize operators
loadOperatorsFromWasm();
if (typeof window !== 'undefined') {
  window.addEventListener('wasmReady', loadOperatorsFromWasm);
}

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

// Helper function to get which buffer/lane a node is in
export function getNodeBuffer(node: Node): number {
  const x = node.position.x;
  const distances = [
    Math.abs(x - LANES.LEFT),
    Math.abs(x - LANES.CENTER), 
    Math.abs(x - LANES.RIGHT)
  ];
  return distances.indexOf(Math.min(...distances)); // Return 0, 1, or 2 (0-indexed like serialization system)
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

// Centralized sequential renderer to ensure correct execution order
class CentralizedRenderer {
  private animationFrame: number | null = null;
  private lastFrameTime: number = 0;
  private isRunning: boolean = false;
  private currentConfig: RenderConfig = { width: 100, height: 50, maxWidth: 500, maxHeight: 500 };
  private renderConfigUnsubscribe: (() => void) | null = null;

  constructor() {
    // Subscribe to render config changes ONCE, not on every frame
    if (typeof window !== 'undefined') {
      this.renderConfigUnsubscribe = renderConfig.subscribe(config => {
        this.currentConfig = config;
      });
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.animate();
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  cleanup() {
    this.stop();
    if (this.renderConfigUnsubscribe) {
      this.renderConfigUnsubscribe();
      this.renderConfigUnsubscribe = null;
    }
  }

  private animate = () => {
    if (!this.isRunning) return;

    const currentTime = performance.now();
    this.renderAllNodesInOrder(currentTime);
    this.lastFrameTime = currentTime;
    
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  private renderAllNodesInOrder(currentTime: number) {
    // Get current nodes and edges - use get() instead of subscribing on every frame!
    const nodes = get(flowNodes);
    const edges = get(flowEdges);
    
    if (nodes.length === 0) return;

    // Calculate execution order using topological sort
    const executionOrder = this.calculateExecutionOrder(nodes, edges);
    
    // Use synchronized global timestamp for all patterns (same as BLE devices)
    const globalTimestamp = Date.now() & 0xFFFFFFFF; // Truncate to 32-bit to match ESP32 behavior
    const deltaTime = (currentTime - this.lastFrameTime) / 1000;

    for (const node of executionOrder) {
      const nodeDefinition = getNodeDefinition(node.data.type as string);
      if (!nodeDefinition) continue;

      // Create render context for this node using current config dimensions
      const renderContext: RenderContext = {
        ctx: null as any, // Will be set by the render function
        totalTime: globalTimestamp / 1000, // Convert to seconds for compatibility
        deltaTime,
        width: this.currentConfig.width,
        height: this.currentConfig.height,
        getInputNodes: () => this.getInputNodes(node.id, nodes, edges),
        getNodeOutput: (nodeId: string) => {
          const outputs = get(nodeOutputs);
          return outputs.get(nodeId) || null;
        },
        nodeId: node.id
      };

      // Find the canvas element for this node (if it exists)
      const canvasElement = document.querySelector(`[data-node-id="${node.id}"] canvas`) as HTMLCanvasElement;
      if (canvasElement) {
        const ctx = canvasElement.getContext('2d');
        if (ctx) {
          renderContext.ctx = ctx;
          
          // Ensure canvas dimensions match current config
          canvasElement.width = this.currentConfig.width;
          canvasElement.height = this.currentConfig.height;
          
          // Clear canvas
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, this.currentConfig.width, this.currentConfig.height);
          
          // Handle input data BEFORE calling render function (for output nodes and others)
          const inputs = this.getInputNodes(node.id, nodes, edges);
          if ('input' in inputs && inputs.input) {
            const inputData = get(nodeOutputs).get(inputs.input.id);
            if (inputData) {
              ctx.putImageData(inputData, 0, 0);
            }
          }
          
          // Render this node (may modify or overlay the input)
          nodeDefinition.render(renderContext);
          
          // Store output for other nodes
          const outputData = ctx.getImageData(0, 0, this.currentConfig.width, this.currentConfig.height);
          nodeOutputs.update(outputs => {
            outputs.set(node.id, outputData);
            return outputs;
          });
        }
      }
    }
  }

  private calculateExecutionOrder(nodes: Node[], edges: Edge[]): Node[] {
    // Simple topological sort
    const graph = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    
    // Initialize
    nodes.forEach(node => {
      graph.set(node.id, []);
      inDegree.set(node.id, 0);
    });
    
    // Build graph
    edges.forEach(edge => {
      graph.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    });
    
    // Find nodes with no dependencies
    const queue: string[] = [];
    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) queue.push(nodeId);
    });
    
    // Process in order
    const result: Node[] = [];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = nodes.find(n => n.id === nodeId);
      if (node) result.push(node);
      
      // Update dependencies
      graph.get(nodeId)?.forEach(dependentId => {
        const newDegree = (inDegree.get(dependentId) || 0) - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          queue.push(dependentId);
        }
      });
    }
    
    return result;
  }

  private getInputNodes(nodeId: string, nodes: Node[], edges: Edge[]) {
    const inputEdges = edges.filter(edge => edge.target === nodeId);
    
    const node = nodes.find(n => n.id === nodeId);
    if (node?.data.type === 'blend') {
      // For blend nodes, get both inputs
      const input1Edge = inputEdges.find(e => e.targetHandle === 'input-1' || e.targetHandle === 'input');
      const input2Edge = inputEdges.find(e => e.targetHandle === 'input-2');
      
      const input1Node = input1Edge ? nodes.find(n => n.id === input1Edge.source) : null;
      const input2Node = input2Edge ? nodes.find(n => n.id === input2Edge.source) : null;
      
      return { input1: input1Node, input2: input2Node };
    } else {
      // For other nodes, get single input
      const inputEdge = inputEdges[0];
      const inputNode = inputEdge ? nodes.find(n => n.id === inputEdge.source) : null;
      return { input: inputNode };
    }
  }
}

// Global centralized renderer instance
const centralizedRenderer = new CentralizedRenderer();

// Global cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    centralizedRenderer.cleanup();
  });
}

// Start/stop centralized rendering when nodes change
flowNodes.subscribe(nodes => {
  if (nodes.length > 0) {
    centralizedRenderer.start();
  } else {
    centralizedRenderer.stop();
  }
});

// Export function to disable individual node animation (for PatternNode components)
export function disableIndividualAnimation() {
  return true; // Signal that centralized rendering is active
}

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
  
  flowNodes.subscribe(nodes => {
    currentNodes = nodes;
  })();
  flowEdges.subscribe(edges => {
    currentEdges = edges;
  })();
  
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

  // Clean up interactive parameters for the deleted node
  clearNodeInteractiveParameters(nodeId);
  
  // Clean up WASM operator instance
  const manager = getWasmOperatorManager();
  if (manager) {
    manager.destroyOperatorInstance(nodeId);
  }

  // Drop this node's cached output so it doesn't linger (and can't be returned
  // for a future node that reuses the id).
  nodeOutputs.update(outputs => {
    outputs.delete(nodeId);
    return outputs;
  });
}

// Pattern serialization imports and utilities
import type { SerializedPattern } from './patternSerializer';
import { serializePattern, deserializePattern, deserializePatternWhenReady, estimatePatternSize, compressPattern } from './patternSerializer';
import { syncPatternToAllDevices, getConnectedDeviceCount } from './ble';
import { currentPatternName } from './stores/patternsStore';

// Pattern serialization utilities
export function serializeCurrentPattern(patternName?: string): SerializedPattern {
  let currentNodes: Node[] = [];
  let currentEdges: Edge[] = [];
  let currentParams: Map<string, Map<string, any>> = new Map();

  flowNodes.subscribe(nodes => {
    currentNodes = nodes;
  })();
  flowEdges.subscribe(edges => {
    currentEdges = edges;
  })();
  nodeParameters.subscribe(params => {
    currentParams = params;
  })();

  // If no pattern name provided, get it from the currentPatternName store
  if (!patternName) {
    try {
      patternName = get(currentPatternName);
    } catch (error) {
      console.warn('Could not load pattern name from store:', error);
      patternName = undefined;
    }
  }

  return serializePattern(currentNodes, currentEdges, currentParams, patternName);
}

// Automatic pattern sync when pattern changes
let lastPatternHash: string | null = null;
let syncInProgress = false;
let patternLoading = false;

function syncPatternIfChanged() {
  try {
    // Skip sync if pattern is currently loading (stores may be inconsistent)
    if (patternLoading) {
      return;
    }
    
    const currentPattern = serializeCurrentPattern();
    const currentHash = JSON.stringify(currentPattern);
    
    // Only sync if pattern changed and there are connected devices
    if ((!lastPatternHash || lastPatternHash !== currentHash) && getConnectedDeviceCount() > 0) {
      
      // Skip if sync is already in progress
      if (syncInProgress) {
        console.log('Sync already in progress, skipping...');
        return;
      }
      
      // Mark sync as in progress
      syncInProgress = true;
      
      // Sync immediately
      syncPatternToAllDevices().catch(error => {
        console.error('Failed to sync pattern:', error);
      }).finally(() => {
        syncInProgress = false;
      });
    }
    
    lastPatternHash = currentHash;
  } catch (error) {
    console.error('Error in pattern sync check:', error);
  }
}

// Force sync current pattern regardless of whether it changed
export function forceSyncCurrentPattern(): void {
  try {
    if (getConnectedDeviceCount() > 0) {
      // Skip if sync is already in progress
      if (syncInProgress) {
        console.log('Force sync skipped - sync already in progress');
        return;
      }
      
      // Update the hash to current pattern so future changes are detected properly
      const currentPattern = serializeCurrentPattern();
      lastPatternHash = JSON.stringify(currentPattern);
      
      // Mark sync as in progress
      syncInProgress = true;
      
      // Sync immediately
      syncPatternToAllDevices().catch(error => {
        console.error('Failed to force sync pattern:', error);
      }).finally(() => {
        syncInProgress = false;
      });
    }
  } catch (error) {
    console.error('Error in force sync:', error);
  }
}

export async function loadSerializedPattern(serializedPattern: SerializedPattern): Promise<void> {
  // Cancel any autosave a prior edit scheduled, so it can't fire mid-load and
  // persist the wrong (about-to-be-replaced) content.
  clearTimeout(autoSaveTimeout);
  // Set loading state to prevent syncing during loading
  patternLoading = true;

  // Tear down the outgoing pattern's WASM operator instances and cached outputs
  // before loading the new one. Otherwise switching patterns leaks a WASM
  // operator instance (and an ImageData) per node of every previously-loaded
  // pattern — only deleteNode ever freed them. New instances are recreated
  // lazily on the next render.
  const outgoingManager = getWasmOperatorManager();
  if (outgoingManager) outgoingManager.destroyAllInstances();
  nodeOutputs.set(new Map());

  try {
    // Use the new async deserializer that waits for WASM to be ready
    const { nodes, edges, nodeParameters: newNodeParameters } = await deserializePatternWhenReady(serializedPattern);
    
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
    
    // Clear loading state
    patternLoading = false;
    
    // If the pattern is empty (0 nodes), this indicates corrupted data or WASM timing issues
    // Initialize a default pattern instead
    if (nodes.length === 0) {
      console.warn('Loaded pattern has 0 nodes, initializing default pattern instead');
      initializeDefaultPattern();
      return;
    }
    
    // Force sync the loaded pattern to connected devices
    forceSyncCurrentPattern();
    
    console.log('Pattern loaded successfully with', nodes.length, 'nodes and', edges.length, 'edges');
  } catch (error) {
    console.error('Failed to load serialized pattern:', error);
    
    // Fallback to basic deserialization if WASM timing fails
    try {
      console.warn('Falling back to basic deserialization...');
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
      
      // Clear loading state
      patternLoading = false;
      
      // Force sync the loaded pattern to connected devices
      forceSyncCurrentPattern();
      
      console.log('Pattern loaded with fallback method');
    } catch (fallbackError) {
      console.error('Even fallback deserialization failed:', fallbackError);
      patternLoading = false; // Clear loading state even on error
      throw fallbackError;
    }
  }
}

// Initialize flow with default pattern if no patterns exist
export function initializeDefaultPattern(): void {
  // Create default nodes
  const defaultNodes: Node[] = [
    createNodeFromType(NODE_TYPES[1], '1', { x: LANES.CENTER, y: 100 }),        // First pattern node (rainbow)
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

// Defer subscription setup to avoid initialization order issues
if (typeof window !== 'undefined') {
  // Wait for next tick to ensure all modules are initialized
  setTimeout(() => {
    try {
      // Subscribe to pattern changes for auto-sync AND auto-save
      flowNodes.subscribe(() => {
        syncPatternIfChanged();
        triggerAutoSave('node change');
      });
      flowEdges.subscribe(() => {
        syncPatternIfChanged();
        triggerAutoSave('edge change');
      });
      nodeParameters.subscribe(() => {
        syncPatternIfChanged();
        // Note: parameter changes already trigger auto-save via setNodeParameter
      });
      
      // Subscribe to interactive parameters changes for auto-save
      import('$lib/stores/interactiveStore').then(({ interactiveParameters }) => {
        interactiveParameters.subscribe(() => {
          triggerAutoSave('interactive parameters change');
        });
      }).catch(console.error);
    } catch (error) {
      console.error('Error setting up pattern sync subscriptions:', error);
    }
  }, 0);
}

