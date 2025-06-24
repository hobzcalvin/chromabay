# FastLED Pattern Build System
# Builds patterns with FastLED-compatible code for both WASM and ESP32

# Configuration
CC = gcc
CXX = g++
CFLAGS = -Wall -Wextra -g -DNATIVE_BUILD
CXXFLAGS = -Wall -Wextra -g -std=c++17 -DNATIVE_BUILD
INCLUDES = -I.

# FastLED library path
FASTLED_SRC = FastLED/src

# Source files
SOURCES = fastled_compat.cpp patterns/rainbow.cpp
HEADERS = fastled_patterns.h

# Test executable
TEST_TARGET = test_runner
TEST_SOURCES = tests/test_runner.cpp $(SOURCES)

# WASM build
WASM_TARGET = ../lib/wasm/fastled_patterns.js
WASM_SOURCES = patterns/rainbow.cpp fastled_compat.cpp wasm_interface.cpp
EMCC_FLAGS = -O3 -s WASM=1 \
	-s EXPORTED_FUNCTIONS='["_create_context", "_destroy_context", "_set_timing", "_set_parameters", "_get_output_buffer", "_get_buffer_size", "_call_rainbow_pattern", "_malloc", "_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "setValue", "getValue", "HEAPU8"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='FastLEDPatterns' \
	-s USE_WEBGL2=0 \
	-s USE_GLFW=0 \
	-D__EMSCRIPTEN__ \
	-std=c++17

# Default target
all: test

# Test build for native development
test: $(TEST_TARGET)

$(TEST_TARGET): $(TEST_SOURCES) $(HEADERS)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $(TEST_SOURCES) -o $(TEST_TARGET)

# WASM build for web
wasm: $(WASM_TARGET)

$(WASM_TARGET): $(WASM_SOURCES) $(HEADERS)
	@mkdir -p ../lib/wasm
	emcc $(EMCC_FLAGS) $(WASM_SOURCES) -o $(WASM_TARGET)
	@echo "Copying WASM files to static directory..."
	@mkdir -p ../../static/wasm
	@cp ../lib/wasm/fastled_patterns.js ../../static/wasm/
	@cp ../lib/wasm/fastled_patterns.wasm ../../static/wasm/

# Clean build artifacts
clean:
	rm -rf ../lib/wasm
	rm -f $(TEST_TARGET)
	@echo "Cleaned build artifacts"

# Install emscripten
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