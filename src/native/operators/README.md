# FastLED Operators

This directory contains FastLED-compatible operators that run both on ESP32 and in the browser via WASM.

## How It Works

1. **Single Source of Truth**: Parameter definitions are in the C++ files alongside the operator functions
2. **Auto-Generation**: TypeScript bindings are auto-generated from C++ source
3. **Cross-Platform**: Same code compiles for ESP32 (native FastLED) and WASM (browser)

## Adding a New Operator

1. Create `my_operator.cpp` in this directory
2. Define parameters at the top:
   ```cpp
   static const PatternParameter my_operator_params[] = {
       {"speed", "Speed", "float", 1.0f, 0.0f, 10.0f, nullptr, 0},
       {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0}
   };
   ```
3. Implement the operator function:
   ```cpp
   void my_operator_pattern(PatternContext* ctx) {
       float speed = ctx->param_count > 0 ? ctx->parameters[0] : 1.0f;
       float hue = ctx->param_count > 1 ? ctx->parameters[1] : 0.0f;
       // ... operator implementation
   }
   ```
4. Add to `../pattern_registry.cpp`:
   ```cpp
   {"My Operator", "my_operator", my_operator_params, 2, my_operator_pattern}
   ```
5. Run `npm run wasm:full` to regenerate bindings and build WASM

## Development Workflow

- `npm run wasm:generate` - Regenerate TypeScript from C++
- `npm run wasm:build` - Build WASM from C++  
- `npm run wasm:full` - Do both (recommended)
- `npm run wasm:clean` - Clean build artifacts

## Automatic Generation

The TypeScript file `src/lib/wasmOperators.ts` is auto-generated and should not be edited directly. It's automatically regenerated:

- When running `npm run dev` (development)
- When running `npm run build` (production)
- During GitHub Actions deployment

This ensures the TypeScript bindings are always in sync with the C++ operator definitions. 