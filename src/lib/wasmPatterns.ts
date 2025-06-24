// FastLED WASM Pattern Interface
// Provides TypeScript bindings for calling native FastLED patterns compiled to WASM

// WASM module interface
interface WasmModule {
    _create_context(width: number, height: number): number;
    _destroy_context(contextPtr: number): void;
    _set_timing(contextPtr: number, timestamp: number, deltaTime: number): void;
    _set_parameters(contextPtr: number, paramsPtr: number, paramCount: number): void;
    _get_output_buffer(contextPtr: number): number;
    _get_buffer_size(contextPtr: number): number;
    _call_rainbow_pattern(contextPtr: number): void;
    
    // Memory access
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    HEAPF32: Float32Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
}

let wasmModule: WasmModule | null = null;
let wasmLoadPromise: Promise<WasmModule> | null = null;

// Pattern definitions (matches the C++ patterns)
export const NATIVE_PATTERN_DEFINITIONS = [
  {
    name: 'Rainbow (Native)',
    type: 'native_rainbow',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 50.0, min: 0.0, max: 200.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 }
    ]
  }
];

// Load WASM module
export async function loadWasmModule(): Promise<WasmModule> {
    if (wasmModule) {
        return wasmModule;
    }
    
    if (wasmLoadPromise) {
        return wasmLoadPromise;
    }
    
    wasmLoadPromise = new Promise<WasmModule>(async (resolve, reject) => {
        try {
            // Import the WASM module with its initialization function
            // @ts-ignore - WASM module is built at runtime
            const wasmFactory = await import('/wasm/fastled_patterns.js');
            
            // Initialize the module
            const module = await wasmFactory.default();
            
            wasmModule = module as WasmModule;
            resolve(wasmModule);
        } catch (error) {
            console.error('Failed to load WASM module:', error);
            reject(error);
        }
    });
    
    return wasmLoadPromise;
}

// Pattern runner that manages WASM calls
export class FastLEDWasmPatternRunner {
    private module: WasmModule;
    private contextPtr: number = 0;
    private paramsPtr: number = 0;
    private width: number;
    private height: number;

    constructor(module: WasmModule, width: number, height: number) {
        this.module = module;
        this.width = width;
        this.height = height;
        this.contextPtr = this.module._create_context(width, height);
        if (!this.contextPtr) {
            throw new Error('Failed to create WASM pattern context');
        }
    }

    destroy() {
        if (this.contextPtr) {
            this.module._destroy_context(this.contextPtr);
            this.contextPtr = 0;
        }
        if (this.paramsPtr) {
            this.module._free(this.paramsPtr);
            this.paramsPtr = 0;
        }
    }

    setTiming(timestamp: number, deltaTime: number) {
        if (!this.contextPtr) return;
        this.module._set_timing(this.contextPtr, timestamp, deltaTime);
    }

    setParameters(params: number[]) {
        if (!this.contextPtr) return;
        
        // Free existing parameters
        if (this.paramsPtr) {
            this.module._free(this.paramsPtr);
            this.paramsPtr = 0;
        }
        
        if (params.length > 0) {
            // Allocate memory for parameters
            this.paramsPtr = this.module._malloc(params.length * 4); // 4 bytes per float
            if (this.paramsPtr) {
                // Copy parameters to WASM memory
                const paramArray = new Float32Array(this.module.HEAPU8.buffer, this.paramsPtr, params.length);
                paramArray.set(params);
                
                this.module._set_parameters(this.contextPtr, this.paramsPtr, params.length);
            }
        }
    }

    runRainbowPattern(): ImageData | null {
        if (!this.contextPtr) return null;
        
        // Call the pattern function
        this.module._call_rainbow_pattern(this.contextPtr);
        
        // Get the output buffer
        const bufferPtr = this.module._get_output_buffer(this.contextPtr);
        if (!bufferPtr) return null;
        
        // Get buffer size and create ImageData
        const bufferSize = this.module._get_buffer_size(this.contextPtr);
        const rgbData = new Uint8Array(this.module.HEAPU8.buffer, bufferPtr, bufferSize);
        
        // Convert RGB to RGBA for ImageData
        const imageData = new ImageData(this.width, this.height);
        for (let i = 0; i < this.width * this.height; i++) {
            const rgbIndex = i * 3;
            const rgbaIndex = i * 4;
            
            imageData.data[rgbaIndex] = rgbData[rgbIndex];     // R
            imageData.data[rgbaIndex + 1] = rgbData[rgbIndex + 1]; // G
            imageData.data[rgbaIndex + 2] = rgbData[rgbIndex + 2]; // B
            imageData.data[rgbaIndex + 3] = 255; // A (fully opaque)
        }
        
        return imageData;
    }
}

export interface NativePatternParams {
    speed?: number;
    saturation?: number;
    value?: number;
    angle?: number;
}

export async function renderNativePattern(
    patternName: string,
    width: number,
    height: number,
    timestamp: number,
    params: NativePatternParams = {}
): Promise<ImageData | null> {
    try {
        const module = await loadWasmModule();
        
        // Create a temporary pattern runner
        const runner = new FastLEDWasmPatternRunner(module, width, height);
        
        try {
            // Set timing
            runner.setTiming(timestamp, 16); // Assume 16ms delta time (~60fps)
            
            // Set parameters based on pattern
            if (patternName === 'rainbow') {
                const paramValues = [
                    params.speed ?? 50.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0,
                    params.angle ?? 0.0
                ];
                runner.setParameters(paramValues);
                return runner.runRainbowPattern();
            }
            
            return null;
        } finally {
            runner.destroy();
        }
    } catch (error) {
        console.error('Error rendering native pattern:', error);
        return null;
    }
}

// Initialize WASM module on first import (but don't await it)
loadWasmModule().catch(error => {
    console.warn('FastLED WASM module failed to load on startup:', error);
}); 