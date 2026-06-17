// Minimal FastLED translation unit for the headless WASM operator build.
// Pulls in ONLY the FastLED .cpp units our operators actually use (HSV->RGB
// colour conversion + Perlin noise), avoiding CFastLED's engine/task/platform
// machinery (the `src` unity bundle drags in EngineEvents/fl::task/platform
// time, none of which a buffer-rendering operator needs). See build-wasm.sh.
#define FASTLED_STUB_IMPL 1
#include <FastLED.h>
#include "hsv2rgb.cpp.hpp"
#include "noise.cpp.hpp"
