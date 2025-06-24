// FastLED WASM Operator Interface
// Provides TypeScript bindings for calling native FastLED operators compiled to WASM

// WASM module interface
interface WasmModule {
    _create_context(width: number, height: number): number;
    _destroy_context(contextPtr: number): void;
    _set_timing(contextPtr: number, timestamp: number, deltaTime: number): void;
    _set_parameters(contextPtr: number, paramsPtr: number, paramCount: number): void;
    _get_output_buffer(contextPtr: number): number;
    _get_buffer_size(contextPtr: number): number;
    _call_rainbow_pattern(contextPtr: number): void;
    _call_gradient_pattern(contextPtr: number): void;
    _call_moving_blob_pattern(contextPtr: number): void;
    _call_sparkle_pattern(contextPtr: number): void;
    _call_strobe_pattern(contextPtr: number): void;
    _call_perlin_noise_pattern(contextPtr: number): void;
    
    // Memory access
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    HEAPF32: Float32Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
}

let wasmModule: WasmModule | null = null;
let wasmLoadPromise: Promise<WasmModule> | null = null;

// Operator definitions (matches the C++ operators)
export const NATIVE_OPERATOR_DEFINITIONS = [
  {
    name: 'Rainbow (Native)',
    type: 'native_rainbow',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 50.0, min: 0.0, max: 200.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 }
    ]
  },
  {
    name: 'Gradient (Native)',
    type: 'native_gradient',
    params: [
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 },
      { label: 'Start Hue', name: 'start_hue', type: 'float', default: 0.0, min: 0.0, max: 255.0 },
      { label: 'End Hue', name: 'end_hue', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 }
    ]
  },
  {
    name: 'Moving Blob (Native)',
    type: 'native_moving_blob',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 30.0, min: 0.0, max: 100.0 },
      { label: 'Blob Size', name: 'blob_size', type: 'float', default: 0.3, min: 0.1, max: 1.0 },
      { label: 'Hue', name: 'hue', type: 'float', default: 0.0, min: 0.0, max: 255.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 }
    ]
  },
  {
    name: 'Sparkle (Native)',
    type: 'native_sparkle',
    params: [
      { label: 'Density', name: 'density', type: 'float', default: 0.1, min: 0.0, max: 1.0 },
      { label: 'Fade Rate', name: 'fade_rate', type: 'float', default: 0.95, min: 0.5, max: 0.99 },
      { label: 'Hue', name: 'hue', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 }
    ]
  },
  {
    name: 'Strobe (Native)',
    type: 'native_strobe',
    params: [
      { label: 'Rate (Hz)', name: 'rate', type: 'float', default: 2.0, min: 0.1, max: 20.0 },
      { label: 'Duty Cycle', name: 'duty_cycle', type: 'float', default: 0.1, min: 0.01, max: 0.9 },
      { label: 'Hue', name: 'hue', type: 'float', default: 0.0, min: 0.0, max: 255.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 0.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 }
    ]
  },
  {
    name: 'Perlin Noise (Native)',
    type: 'native_perlin_noise',
    params: [
      { label: 'Scale', name: 'scale', type: 'float', default: 4.0, min: 1.0, max: 20.0 },
      { label: 'Speed', name: 'speed', type: 'float', default: 50.0, min: 0.0, max: 200.0 },
      { label: 'Base Hue', name: 'hue_base', type: 'float', default: 0.0, min: 0.0, max: 255.0 },
      { label: 'Hue Range', name: 'hue_range', type: 'float', default: 60.0, min: 0.0, max: 255.0 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 255.0, min: 0.0, max: 255.0 },
      { label: 'Value', name: 'value', type: 'float', default: 255.0, min: 0.0, max: 255.0 }
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
            // Check if FastLEDPatterns is already available (script already loaded)
            const existingFactory = (window as any).FastLEDPatterns;
            if (existingFactory) {
                try {
                    const module = await existingFactory();
                    wasmModule = module as WasmModule;
                    resolve(wasmModule);
                    return;
                } catch (error) {
                    console.error('Failed to initialize existing WASM module:', error);
                    reject(error);
                    return;
                }
            }
            
            // Use dynamic script loading instead of import() to avoid Vite restrictions
            const script = document.createElement('script');
            script.src = '/wasm/fastled_patterns.js';
            script.type = 'text/javascript';
            
            script.onload = async () => {
                try {
                    // The script should have defined a global function
                    // Check if FastLEDPatterns is available on window
                    const wasmFactory = (window as any).FastLEDPatterns;
                    if (!wasmFactory) {
                        throw new Error('FastLEDPatterns factory not found on window');
                    }
                    
                    // Initialize the module
                    const module = await wasmFactory();
                    
                    wasmModule = module as WasmModule;
                    resolve(wasmModule);
                } catch (error) {
                    console.error('Failed to initialize WASM module:', error);
                    reject(error);
                }
            };
            
            script.onerror = () => {
                reject(new Error('Failed to load WASM script'));
            };
            
            document.head.appendChild(script);
        } catch (error) {
            console.error('Failed to load WASM module:', error);
            reject(error);
        }
    });
    
    return wasmLoadPromise;
}

// Operator runner that manages WASM calls
export class FastLEDWasmOperatorRunner {
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

    runGradientPattern(): ImageData | null {
        if (!this.contextPtr) return null;
        this.module._call_gradient_pattern(this.contextPtr);
        return this.getImageData();
    }

    runMovingBlobPattern(): ImageData | null {
        if (!this.contextPtr) return null;
        this.module._call_moving_blob_pattern(this.contextPtr);
        return this.getImageData();
    }

    runSparklePattern(): ImageData | null {
        if (!this.contextPtr) return null;
        this.module._call_sparkle_pattern(this.contextPtr);
        return this.getImageData();
    }

    runStrobePattern(): ImageData | null {
        if (!this.contextPtr) return null;
        this.module._call_strobe_pattern(this.contextPtr);
        return this.getImageData();
    }

    runPerlinNoisePattern(): ImageData | null {
        if (!this.contextPtr) return null;
        this.module._call_perlin_noise_pattern(this.contextPtr);
        return this.getImageData();
    }

    private getImageData(): ImageData | null {
        if (!this.contextPtr) return null;
        
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

export interface NativeOperatorParams {
    // Rainbow parameters
    speed?: number;
    saturation?: number;
    value?: number;
    angle?: number;
    
    // Gradient parameters
    start_hue?: number;
    end_hue?: number;
    
    // Moving blob parameters
    blob_size?: number;
    hue?: number;
    
    // Sparkle parameters
    density?: number;
    fade_rate?: number;
    
    // Strobe parameters
    rate?: number;
    duty_cycle?: number;
    
    // Perlin noise parameters
    scale?: number;
    hue_base?: number;
    hue_range?: number;
}

export async function renderNativeOperator(
    patternName: string,
    width: number,
    height: number,
    timestamp: number,
    params: NativeOperatorParams = {}
): Promise<ImageData | null> {
    try {
        const module = await loadWasmModule();
        
        // Create a temporary pattern runner
        const runner = new FastLEDWasmOperatorRunner(module, width, height);
        
        try {
            // Set timing
            runner.setTiming(timestamp, 16); // Assume 16ms delta time (~60fps)
            
            // Set parameters and call appropriate pattern based on pattern name
            if (patternName === 'rainbow') {
                const paramValues = [
                    params.speed ?? 50.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0,
                    params.angle ?? 0.0
                ];
                runner.setParameters(paramValues);
                return runner.runRainbowPattern();
            } else if (patternName === 'gradient') {
                const paramValues = [
                    params.angle ?? 0.0,
                    params.start_hue ?? 0.0,
                    params.end_hue ?? 255.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0
                ];
                runner.setParameters(paramValues);
                return runner.runGradientPattern();
            } else if (patternName === 'moving_blob') {
                const paramValues = [
                    params.speed ?? 30.0,
                    params.blob_size ?? 0.3,
                    params.hue ?? 0.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0
                ];
                runner.setParameters(paramValues);
                return runner.runMovingBlobPattern();
            } else if (patternName === 'sparkle') {
                const paramValues = [
                    params.density ?? 0.1,
                    params.fade_rate ?? 0.95,
                    params.hue ?? 255.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0
                ];
                runner.setParameters(paramValues);
                return runner.runSparklePattern();
            } else if (patternName === 'strobe') {
                const paramValues = [
                    params.rate ?? 2.0,
                    params.duty_cycle ?? 0.1,
                    params.hue ?? 0.0,
                    params.saturation ?? 0.0,
                    params.value ?? 255.0
                ];
                runner.setParameters(paramValues);
                return runner.runStrobePattern();
            } else if (patternName === 'perlin_noise') {
                const paramValues = [
                    params.scale ?? 4.0,
                    params.speed ?? 50.0,
                    params.hue_base ?? 0.0,
                    params.hue_range ?? 60.0,
                    params.saturation ?? 255.0,
                    params.value ?? 255.0
                ];
                runner.setParameters(paramValues);
                return runner.runPerlinNoisePattern();
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