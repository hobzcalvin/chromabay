// FastLED WASM Pattern Interface
// Provides TypeScript bindings for calling native FastLED patterns compiled to WASM

// WASM module interface
interface FastLEDWasmModule {
  ccall: (funcName: string, returnType: string, argTypes: string[], args: any[]) => any;
  cwrap: (funcName: string, returnType: string, argTypes: string[]) => Function;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
}

// Module loading state
let wasmModule: FastLEDWasmModule | null = null;
let moduleLoading: Promise<FastLEDWasmModule> | null = null;

// Function wrappers
interface WasmFunctions {
  createContext: (width: number, height: number, maxParams: number) => number;
  destroyContext: () => void;
  setTiming: (timestampMs: number, deltaTimeMs: number) => void;
  setParameters: (paramsPtr: number, paramCount: number) => void;
  setPatternState: (isStarting: boolean, isEnding: boolean) => void;
  setInputBuffer: (rgbDataPtr: number, bufferIndex: number, size: number) => void;
  getOutputBuffer: () => number;
  callPattern: (patternNamePtr: number) => void;
  callRainbowPattern: () => void;
}

let wasmFunctions: WasmFunctions | null = null;

// Pattern definitions (matches the C++ patterns)
export const NATIVE_PATTERN_DEFINITIONS = [
  {
    name: 'Rainbow (Native)',
    type: 'native_rainbow',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 0.1, min: 0.0, max: 1.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 1.0, min: 0.0, max: 1.0 },
      { label: 'Value', name: 'value', type: 'float', default: 1.0, min: 0.0, max: 1.0 },
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 }
    ]
  }
];

// Load WASM module
async function loadWasmModule(): Promise<FastLEDWasmModule> {
  if (wasmModule) return wasmModule;
  
  if (moduleLoading) return moduleLoading;
  
  moduleLoading = (async () => {
    try {
      // Dynamic import of the actual WASM module from static assets
      // Use dynamic loading to avoid TypeScript module resolution issues
      const response = await fetch('/wasm/fastled_patterns.js');
      const moduleText = await response.text();
      const moduleBlob = new Blob([moduleText], { type: 'application/javascript' });
      const moduleUrl = URL.createObjectURL(moduleBlob);
      const FastLEDPatterns = (await import(moduleUrl)).default;
      const module = await FastLEDPatterns() as FastLEDWasmModule;
      wasmModule = module;
      
      // Wrap the exported functions for easier calling
      wasmFunctions = {
        createContext: module.cwrap('create_context', 'number', ['number', 'number', 'number']) as (width: number, height: number, maxParams: number) => number,
        destroyContext: module.cwrap('destroy_context', 'void', []) as () => void,
        setTiming: module.cwrap('set_timing', 'void', ['number', 'number']) as (timestampMs: number, deltaTimeMs: number) => void,
        setParameters: module.cwrap('set_parameters', 'void', ['number', 'number']) as (paramsPtr: number, paramCount: number) => void,
        setPatternState: module.cwrap('set_pattern_state', 'void', ['boolean', 'boolean']) as (isStarting: boolean, isEnding: boolean) => void,
        setInputBuffer: module.cwrap('set_input_buffer', 'void', ['number', 'number', 'number']) as (rgbDataPtr: number, bufferIndex: number, size: number) => void,
        getOutputBuffer: module.cwrap('get_output_buffer', 'number', []) as () => number,
        callPattern: module.cwrap('call_pattern', 'void', ['number']) as (patternNamePtr: number) => void,
        callRainbowPattern: module.cwrap('call_rainbow_pattern', 'void', []) as () => void
      };
      
      console.log('FastLED WASM module loaded successfully');
      return wasmModule;
    } catch (error) {
      console.error('Failed to load FastLED WASM module:', error);
      throw error;
    }
  })();
  
  return moduleLoading;
}

// Pattern runner that manages WASM calls
export class FastLEDWasmPatternRunner {
  private contextPtr: number = 0;
  private width: number = 0;
  private height: number = 0;
  private initialized = false;
  private lastTimestamp = 0;
  private patternStartTime = 0;
  
  async initialize(width: number, height: number): Promise<void> {
    await loadWasmModule();
    
    if (!wasmModule || !wasmFunctions) {
      throw new Error('WASM module not ready');
    }
    
    // Clean up any existing context
    if (this.contextPtr !== 0) {
      wasmFunctions.destroyContext();
    }
    
    // Create new context
    this.contextPtr = wasmFunctions.createContext(width, height, 16);
    this.width = width;
    this.height = height;
    this.initialized = true;
    this.lastTimestamp = performance.now();
    this.patternStartTime = this.lastTimestamp;
    
    console.log(`FastLED WASM context initialized: ${width}x${height}`);
  }
  
  async renderPattern(
    patternType: string,
    totalTime: number,
    deltaTime: number,
    parameters: number[]
  ): Promise<ImageData> {
    if (!this.initialized || !wasmModule || !wasmFunctions) {
      throw new Error('WASM pattern runner not initialized');
    }
    
    const currentTime = performance.now();
    const timestampMs = Math.floor(currentTime - this.patternStartTime);
    const deltaTimeMs = Math.floor(currentTime - this.lastTimestamp);
    this.lastTimestamp = currentTime;
    
    // Set timing
    wasmFunctions.setTiming(timestampMs, deltaTimeMs);
    
    // Set parameters
    if (parameters.length > 0) {
      const paramPtr = wasmModule._malloc(parameters.length * 4); // float32
      const paramArray = new Float32Array(wasmModule.HEAPU8.buffer, paramPtr, parameters.length);
      paramArray.set(parameters);
      wasmFunctions.setParameters(paramPtr, parameters.length);
      wasmModule._free(paramPtr);
    }
    
    // Call the appropriate pattern
    if (patternType === 'native_rainbow') {
      wasmFunctions.callRainbowPattern();
    } else {
      // For other patterns, use string-based calling
      const patternNamePtr = wasmModule._malloc(patternType.length + 1);
      const patternNameArray = new Uint8Array(wasmModule.HEAPU8.buffer, patternNamePtr, patternType.length + 1);
      for (let i = 0; i < patternType.length; i++) {
        patternNameArray[i] = patternType.charCodeAt(i);
      }
      patternNameArray[patternType.length] = 0; // null terminator
      wasmFunctions.callPattern(patternNamePtr);
      wasmModule._free(patternNamePtr);
    }
    
    // Get output buffer
    const outputPtr = wasmFunctions.getOutputBuffer();
    if (!outputPtr) {
      throw new Error('Failed to get WASM output buffer');
    }
    
    // Convert RGB data to ImageData
    const pixelCount = this.width * this.height;
    const rgbData = new Uint8Array(wasmModule.HEAPU8.buffer, outputPtr, pixelCount * 3);
    
    const imageData = new ImageData(this.width, this.height);
    for (let i = 0; i < pixelCount; i++) {
      const srcOffset = i * 3;
      const dstOffset = i * 4;
      
      imageData.data[dstOffset] = rgbData[srcOffset];         // R
      imageData.data[dstOffset + 1] = rgbData[srcOffset + 1]; // G
      imageData.data[dstOffset + 2] = rgbData[srcOffset + 2]; // B
      imageData.data[dstOffset + 3] = 255;                    // A
    }
    
    return imageData;
  }
  
  cleanup(): void {
    if (this.contextPtr !== 0 && wasmFunctions) {
      wasmFunctions.destroyContext();
      this.contextPtr = 0;
    }
    this.initialized = false;
  }
}

// Global pattern runner instance
const globalWasmRunner = new FastLEDWasmPatternRunner();

// Convenience function for use in flowStore
export async function renderNativePattern(
  patternType: string,
  width: number,
  height: number,
  totalTime: number,
  deltaTime: number,
  parameters: number[]
): Promise<ImageData> {
  // Initialize if needed
  if (!globalWasmRunner['initialized']) {
    await globalWasmRunner.initialize(width, height);
  }
  
  return globalWasmRunner.renderPattern(patternType, totalTime, deltaTime, parameters);
}

// Initialize WASM module on first import (but don't await it)
loadWasmModule().catch(error => {
  console.warn('FastLED WASM module failed to load on startup:', error);
}); 