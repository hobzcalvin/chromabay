# FastLED Pattern Build System
# Builds patterns with FastLED-compatible code for both WASM and ESP32

# Emscripten configuration
EMCC = emcc
EMCC_FLAGS = -O3 \
	-s WASM=1 \
	-s EXPORTED_FUNCTIONS='["_create_context", "_destroy_context", "_set_timing", "_set_parameters", "_set_pattern_state", "_set_input_buffer", "_get_output_buffer", "_call_pattern", "_call_rainbow_pattern", "_malloc", "_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "setValue", "getValue", "HEAPU8"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='FastLEDPatterns' \
	-s USE_WEBGL2=0 \
	-s USE_GLFW=0 \
	-D__EMSCRIPTEN__ \
	-std=c++17

# Our pattern sources (no FastLED dependency for WASM)
PATTERN_SOURCES = \
	patterns/rainbow.cpp \
	fastled_compat.cpp \
	wasm_interface.cpp

# Output paths
WASM_OUTPUT_DIR = ../lib/wasm
WASM_OUTPUT = $(WASM_OUTPUT_DIR)/fastled_patterns

# Default target
.PHONY: all wasm clean test

all: wasm

# Build WASM module
wasm: $(WASM_OUTPUT).js

$(WASM_OUTPUT).js: $(PATTERN_SOURCES) fastled_patterns.h
	@mkdir -p $(WASM_OUTPUT_DIR)
	$(EMCC) $(EMCC_FLAGS) $(PATTERN_SOURCES) -o $(WASM_OUTPUT).js
	@echo "WASM build complete: $(WASM_OUTPUT).js"

# Test build (native compilation for testing with real FastLED)
test: test_runner
	./test_runner

test_runner: test_runner.cpp $(PATTERN_SOURCES) fastled_patterns.h
	@echo "Native test build requires FastLED library installation"
	@echo "This would link against real FastLED for ESP32 testing"

# Clean build artifacts
clean:
	rm -rf $(WASM_OUTPUT_DIR)
	rm -f test_runner
	@echo "Cleaned build artifacts"

# Install emscripten dependencies
install-emscripten:
	@echo "To install Emscripten:"
	@echo "1. git clone https://github.com/emscripten-core/emsdk.git"
	@echo "2. cd emsdk && ./emsdk install latest && ./emsdk activate latest"
	@echo "3. source ./emsdk_env.sh"

# Help
help:
	@echo "FastLED Pattern Build System"
	@echo ""
	@echo "Targets:"
	@echo "  wasm              Build WebAssembly module"
	@echo "  test              Build and run native test"
	@echo "  clean             Clean build artifacts"
	@echo "  install-emscripten Show Emscripten install instructions"
	@echo "  help              Show this help" 