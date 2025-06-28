# Native C++ WASM Operator System

This directory contains the C++ FastLED-based operator system that gets compiled to WebAssembly for use in the Blumon app.

## Architecture

- **OperatorBase.h**: Base class for all operators with parameter system and metadata
- **NoiseBlendOperator.h**: Example noise-based blending operator
- **operator_system.ino**: Main C++ file that exports WASM functions for JavaScript

## Build Process

### Manual Build
```bash
cd native
fastled --just-compile --force-compile --web
```

### Auto-Compilation (Development)
When running `npm run dev`, the system automatically watches for changes to:
- `native/**/*.h` (Header files)
- `native/**/*.ino` (Arduino sketches) 
- `native/**/*.cpp` (C++ files)
- `native/**/*.c` (C files)

Changes trigger automatic recompilation and browser reload. Output in `native/fastled_js/` is ignored to prevent infinite loops.

This generates the `fastled_js/` folder containing:
- `fastled.js` - WASM module loader  
- `fastled.wasm` - Compiled WebAssembly binary
- Supporting files for browser integration

## Integration with Blumon App

1. **Static Files**: The `fastled_js/` folder is copied to `static/native/fastled_js/`
2. **HTML Integration**: `src/app.html` loads the WASM module globally
3. **Component Usage**: Components like Settings page can create operator instances and render frames

## JavaScript API

The WASM module provides these key functions:

### Operator Management
- `createOperatorInstance(operatorName)` - Create operator instance
- `destroyOperatorInstance(operatorId)` - Clean up operator

### Buffer Management  
- `setBufferDimensions(width, height)` - Set LED strip dimensions
- `setBuffer(bufferIndex, rgbDataPtr, length)` - Set entire buffer (OPTIMIZED)
- `getBuffer(bufferIndex, rgbDataPtr, length)` - Get entire buffer (OPTIMIZED)
- `setBuffer1Pixel(index, r, g, b)` - Set individual pixel (LEGACY)
- `getOutputPixel(index)` - Get individual pixel (LEGACY)

### Parameter Control
- `setOperatorFloatParameter(operatorId, paramIndex, value)` - Set float param
- `setOperatorIntParameter(operatorId, paramIndex, value)` - Set int param
- `setOperatorBoolParameter(operatorId, paramIndex, value)` - Set bool param

### Rendering
- `renderOperatorWithParameters(operatorId, timestamp, deltaTime, useBuffer1, useBuffer2)` - Render frame

## Demo

Visit the Settings page to see the NoiseBlendOperator running in real-time with interactive controls for:
- Speed (animation rate)
- Hue Offset (color shifting) 
- Blend Amount (effect intensity)

## Adding New Operators

1. Create a new `.h` file extending `OperatorBase`
2. Implement the `render()` method and metadata functions
3. Add `REGISTER_OPERATOR(YourClassName)` at the end
4. Include the `.h` file in `operator_system.ino`
5. Rebuild with `fastled --just-compile --force-compile --web`
6. Copy updated `fastled_js/` to `static/native/fastled_js/`

## Next Steps

This proof-of-concept demonstrates C++ operators running in the browser. Future work could integrate this with:
- PatternRenderer.svelte for node backgrounds
- Editor page for real-time node previews  
- Pattern export/import system
- Multiple chained operators
- Audio-reactive parameters 