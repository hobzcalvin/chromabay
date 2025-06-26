#!/usr/bin/env node

/**
 * Auto-generate TypeScript WASM bindings from C++ operator definitions
 * This script parses the C++ source files to extract operator parameter definitions
 * and generates the corresponding TypeScript interfaces and WASM bindings.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_DIR = path.join(__dirname, '../src/native');
const OPERATORS_DIR = path.join(NATIVE_DIR, 'operators');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/wasmOperators.ts');

// Parse parameter definitions from C++ files
function parseOperatorParams(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Extract operator name from filename
    const operatorName = path.basename(filePath, '.cpp');
    
    // Find parameter array definition (handle both const and static const)
    // Use a more sophisticated regex to handle nested braces
    const paramArrayRegex = new RegExp(`(?:static\\s+)?const OperatorParameter ${operatorName}_params\\[\\]\\s*=\\s*{([\\s\\S]*?)};`, 's');
    const match = content.match(paramArrayRegex);
    
    if (!match) {
        console.warn(`No parameter definition found in ${filePath}`);
        return null;
    }
    
    const paramContent = match[1];
    const params = [];
    
    // Parse individual parameter definitions - handle both nullptr,0 and options array
    const paramRegex = /{\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*([\d.f-]+),\s*([\d.f-]+),\s*([\d.f-]+),\s*([^,]+),\s*(\d+)\s*}/g;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(paramContent)) !== null) {
        const [, name, label, type, defaultVal, minVal, maxVal, options, optionCount] = paramMatch;
        
        let paramType = type === 'float' ? 'float' : type === 'int' ? 'range' : type;
        let paramOptions = undefined;
        
        // If it's a select type, extract the options
        if (type === 'select' && options !== 'nullptr') {
            // Find the options array definition
            const optionsArrayName = options.trim();
            const optionsRegex = new RegExp(`const char\\* ${optionsArrayName}\\[\\]\\s*=\\s*{([^}]+)}`, 's');
            const optionsMatch = content.match(optionsRegex);
            
            if (optionsMatch) {
                const optionsContent = optionsMatch[1];
                const optionsList = optionsContent.match(/"([^"]+)"/g);
                if (optionsList) {
                    paramOptions = optionsList.map(opt => ({
                        value: optionsList.indexOf(opt).toString(),
                        label: opt.replace(/"/g, '')
                    }));
                }
            }
        }
        
        const param = {
            name,
            label,
            type: paramType,
            default: parseFloat(defaultVal.replace('f', '')),
            min: parseFloat(minVal.replace('f', '')),
            max: parseFloat(maxVal.replace('f', ''))
        };
        
        if (paramOptions) {
            param.options = paramOptions;
        }
        
        params.push(param);
    }
    
    return {
        operatorName,
        displayName: operatorName.split('_').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' '),
        params
    };
}

// Generate TypeScript interface
function generateTypeScript(operators) {
    const operatorTypes = operators.map(op => `'${op.operatorName}'`).join(' | ');
    
    const operatorDefinitions = operators.map(op => `  {
    name: '${op.displayName}',
    type: '${op.operatorName}',
    params: [
${op.params.map(param => {
    let paramDef = `      { label: '${param.label}', name: '${param.name}', type: '${param.type}', default: ${param.default}, min: ${param.min}, max: ${param.max}`;
    if (param.options) {
        paramDef += `, options: ${JSON.stringify(param.options)}`;
    }
    paramDef += ' }';
    return paramDef;
}).join(',\n')}
    ]
  }`).join(',\n');

    const wasmCalls = operators.map(op => `    _call_${op.operatorName}_operator(contextPtr: number): void;`).join('\n');
    
    const runnerMethods = operators.map(op => `    async run${op.displayName.replace(/\s+/g, '')}(): Promise<ImageData | null> {
        if (!this.contextPtr) return null;
        this.module._call_${op.operatorName}_operator(this.contextPtr);
        return this.getImageData();
    }`).join('\n\n');

    const paramInterface = operators.reduce((acc, op) => {
        op.params.forEach(param => {
            if (!acc.includes(param.name)) {
                acc.push(param.name);
            }
        });
        return acc;
    }, []).map(paramName => `    ${paramName}?: number;`).join('\n');

    const renderCases = operators.map(op => `        case '${op.operatorName}':
            return await runner.run${op.displayName.replace(/\s+/g, '')}();`).join('\n');

    return `// Auto-generated WASM operator bindings
// DO NOT EDIT - Generated by scripts/generate-wasm-bindings.js
// Run 'npm run wasm:generate' to regenerate this file

export type OperatorType = ${operatorTypes};

// WASM module interface
interface WasmModule {
    _create_context(width: number, height: number): number;
    _destroy_context(contextPtr: number): void;
    _set_timing(contextPtr: number, timestamp: number, deltaTime: number): void;
    _set_parameters(contextPtr: number, paramsPtr: number, paramCount: number): void;
    _get_output_buffer(contextPtr: number): number;
    _get_buffer_size(contextPtr: number): number;
    _set_input_buffer1(contextPtr: number, bufferPtr: number): void;
    _set_input_buffer2(contextPtr: number, bufferPtr: number): void;
${wasmCalls}
    
    // Memory access
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    HEAPF32: Float32Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
}

let wasmModule: WasmModule | null = null;
let wasmLoadPromise: Promise<WasmModule> | null = null;

// Operator definitions (auto-generated from C++ source)
export const NATIVE_OPERATOR_DEFINITIONS = [
${operatorDefinitions}
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
            // Check if FastLEDOperators is already available (script already loaded)
            const existingFactory = (window as any).FastLEDOperators;
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
            script.src = '/wasm/fastled_operators.js';
            script.type = 'text/javascript';
            
            script.onload = async () => {
                try {
                    const wasmFactory = (window as any).FastLEDOperators;
                    if (!wasmFactory) {
                        throw new Error('FastLEDOperators factory not found on window');
                    }
                    
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
            throw new Error('Failed to create WASM operator context');
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
        
        // Free existing parameter buffer
        if (this.paramsPtr) {
            this.module._free(this.paramsPtr);
        }
        
        // Allocate new parameter buffer
        const paramSize = params.length * 4; // 4 bytes per float
        this.paramsPtr = this.module._malloc(paramSize);
        
        // Copy parameters to WASM memory
        const paramView = new Float32Array(this.module.HEAPU8.buffer, this.paramsPtr, params.length);
        for (let i = 0; i < params.length; i++) {
            paramView[i] = params[i];
        }
        
        // Set parameters in context
        this.module._set_parameters(this.contextPtr, this.paramsPtr, params.length);
    }

    setInputBuffer1(imageData: ImageData | null) {
        if (!this.contextPtr) return;
        
        if (!imageData) {
            this.module._set_input_buffer1(this.contextPtr, 0);
            return;
        }
        
        // Allocate buffer for RGB data
        const rgbSize = this.width * this.height * 3;
        const bufferPtr = this.module._malloc(rgbSize);
        
        // Convert RGBA to RGB
        const rgbBuffer = new Uint8Array(this.module.HEAPU8.buffer, bufferPtr, rgbSize);
        for (let i = 0; i < this.width * this.height; i++) {
            const rgbaIndex = i * 4;
            const rgbIndex = i * 3;
            rgbBuffer[rgbIndex] = imageData.data[rgbaIndex];     // R
            rgbBuffer[rgbIndex + 1] = imageData.data[rgbaIndex + 1]; // G
            rgbBuffer[rgbIndex + 2] = imageData.data[rgbaIndex + 2]; // B
        }
        
        // Set input buffer in context
        this.module._set_input_buffer1(this.contextPtr, bufferPtr);
        
        // Free the temporary buffer (WASM function copies it)
        this.module._free(bufferPtr);
    }

    setInputBuffer2(imageData: ImageData | null) {
        if (!this.contextPtr) return;
        
        if (!imageData) {
            this.module._set_input_buffer2(this.contextPtr, 0);
            return;
        }
        
        // Allocate buffer for RGB data
        const rgbSize = this.width * this.height * 3;
        const bufferPtr = this.module._malloc(rgbSize);
        
        // Convert RGBA to RGB
        const rgbBuffer = new Uint8Array(this.module.HEAPU8.buffer, bufferPtr, rgbSize);
        for (let i = 0; i < this.width * this.height; i++) {
            const rgbaIndex = i * 4;
            const rgbIndex = i * 3;
            rgbBuffer[rgbIndex] = imageData.data[rgbaIndex];     // R
            rgbBuffer[rgbIndex + 1] = imageData.data[rgbaIndex + 1]; // G
            rgbBuffer[rgbIndex + 2] = imageData.data[rgbaIndex + 2]; // B
        }
        
        // Set input buffer in context
        this.module._set_input_buffer2(this.contextPtr, bufferPtr);
        
        // Free the temporary buffer (WASM function copies it)
        this.module._free(bufferPtr);
    }

${runnerMethods}

    private getImageData(): ImageData | null {
        if (!this.contextPtr) return null;
        
        try {
            const bufferPtr = this.module._get_output_buffer(this.contextPtr);
            const bufferSize = this.module._get_buffer_size(this.contextPtr);
            
            if (!bufferPtr || bufferSize !== this.width * this.height * 3) {
                console.error('Invalid WASM buffer');
                return null;
            }
            
            // Create ImageData from WASM buffer
            const imageData = new ImageData(this.width, this.height);
            const rgbBuffer = new Uint8Array(this.module.HEAPU8.buffer, bufferPtr, bufferSize);
            
            // Convert RGB to RGBA
            for (let i = 0; i < this.width * this.height; i++) {
                const rgbIndex = i * 3;
                const rgbaIndex = i * 4;
                imageData.data[rgbaIndex] = rgbBuffer[rgbIndex];     // R
                imageData.data[rgbaIndex + 1] = rgbBuffer[rgbIndex + 1]; // G
                imageData.data[rgbaIndex + 2] = rgbBuffer[rgbIndex + 2]; // B
                imageData.data[rgbaIndex + 3] = 255; // A
            }
            
            return imageData;
        } catch (error) {
            console.error('Failed to get image data from WASM:', error);
            return null;
        }
    }
}

export interface NativeOperatorParams {
${paramInterface}
}

// Main render function - generalized for all operators
export async function renderNativeOperator(
    operatorName: OperatorType,
    width: number,
    height: number,
    timestamp: number,
    params: NativeOperatorParams = {},
    inputBuffer1?: ImageData | null,
    inputBuffer2?: ImageData | null
): Promise<ImageData | null> {
    try {
        const module = await loadWasmModule();
        const runner = new FastLEDWasmOperatorRunner(module, width, height);
        
        // Set timing
        runner.setTiming(timestamp, 16.67); // Assume ~60fps
        
        // Find operator definition
        const operatorDef = NATIVE_OPERATOR_DEFINITIONS.find(def => 
            def.type === \`native_\${operatorName}\`
        );
        
        if (!operatorDef) {
            throw new Error(\`Unknown operator: \${operatorName}\`);
        }
        
        // Extract parameter values in order
        const paramValues = operatorDef.params.map(param => 
            params[param.name as keyof NativeOperatorParams] ?? param.default
        );
        
        // Set parameters
        runner.setParameters(paramValues);
        
        // Set input buffers if provided (for blend operations)
        if (inputBuffer1) {
            runner.setInputBuffer1(inputBuffer1);
        }
        if (inputBuffer2) {
            runner.setInputBuffer2(inputBuffer2);
        }
        
        // Run the appropriate operator
        let result: ImageData | null = null;
        switch (operatorName) {
${renderCases}
            default:
                throw new Error(\`Unhandled operator: \${operatorName}\`);
        }
        
        runner.destroy();
        return result;
        
    } catch (error) {
        console.error('Failed to render native operator:', error);
        return null;
    }
}
`;
}

// Main execution
function main() {
    console.log('Generating WASM operator bindings...');
    
    // Check if operators directory exists
    if (!fs.existsSync(OPERATORS_DIR)) {
        console.error(`Operators directory not found: ${OPERATORS_DIR}`);
        console.error('Make sure the C++ operators are available before generating TypeScript bindings.');
        process.exit(1);
    }
    
    // Find all operator files
    const operatorFiles = fs.readdirSync(OPERATORS_DIR)
        .filter(file => file.endsWith('.cpp'))
        .map(file => path.join(OPERATORS_DIR, file));
    
    // Parse all operators
    const operators = operatorFiles
        .map(parseOperatorParams)
        .filter(op => op !== null);
    
    if (operators.length === 0) {
        console.error('No operators found in the operators directory!');
        console.error('Make sure you have .cpp files with parameter definitions in src/native/operators/');
        process.exit(1);
    }
    
    console.log(`Found ${operators.length} operators:`, operators.map(op => op.operatorName));
    
    // Generate TypeScript
    const typescript = generateTypeScript(operators);
    
    // Write output
    fs.writeFileSync(OUTPUT_FILE, typescript);
    console.log(`Generated ${OUTPUT_FILE}`);
}

// Run main function if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
} 