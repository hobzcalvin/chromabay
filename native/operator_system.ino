/*
 * FASTLED OPERATOR SYSTEM
 * =======================
 * 
 * A complete plugin-based operator system for FastLED WASM.
 * 
 * Features:
 * - Automatic operator registration via REGISTER_OPERATOR macro
 * - Dynamic operator discovery and instantiation
 * - Type-safe parameter system with metadata
 * - Multiple buffer management
 * - Clean JavaScript API
 * 
 * Usage:
 * 1. Include OperatorBase.h
 * 2. Create new operator by subclassing OperatorBase
 * 3. Add REGISTER_OPERATOR(YourClassName) at end of .h file
 * 4. Include your .h file in this main file
 * 5. Compile to WASM
 * 
 * JavaScript can then:
 * - List available operators
 * - Get parameter metadata for each operator
 * - Create operator instances
 * - Set parameters and render frames
 */

#include <FastLED.h>
#include <emscripten/emscripten.h>

// Include the operator system
#include "OperatorBase.h"

// Include all operator implementations
#include "NoiseBlendOperator.h"
// #include "RainbowOperator.h"
// #include "SolidColorOperator.h"

#define NUM_LEDS 100
#define LED_PIN 3

CRGB leds[NUM_LEDS];

// Global operator instance management
std::map<int, std::unique_ptr<OperatorBase>> activeOperators;
int nextOperatorId = 1;

extern "C" {
    // ========================================
    // OPERATOR DISCOVERY AND METADATA API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    int getOperatorCount() {
        return OperatorRegistry::getInstance().getOperatorCount();
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorName(int index) {
        auto names = OperatorRegistry::getInstance().getOperatorNames();
        if (index >= 0 && index < (int)names.size()) {
            // Store in static buffer to ensure lifetime
            static std::string buffer;
            buffer = names[index];
            return buffer.c_str();
        }
        return nullptr;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorDisplayName(const char* operatorName) {
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            static std::string buffer;
            buffer = op->getDisplayName();
            return buffer.c_str();
        }
        return nullptr;
    }
    
    EMSCRIPTEN_KEEPALIVE
    int getOperatorParameterCount(const char* operatorName) {
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            return op->getParameterInfo().size();
        }
        return 0;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorParameterInfo(const char* operatorName, int paramIndex) {
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            auto params = op->getParameterInfo();
            if (paramIndex >= 0 && paramIndex < (int)params.size()) {
                // Return JSON-like string with parameter info
                static std::string buffer;
                const auto& param = params[paramIndex];
                
                buffer = "{\"name\":\"" + param.name + 
                        "\",\"label\":\"" + param.label + 
                        "\",\"type\":" + std::to_string((int)param.type);
                
                // Add default value based on type
                if (param.type == ParameterInfo::FLOAT) {
                    buffer += ",\"default\":" + std::to_string(std::get<float>(param.defaultValue));
                    if (param.minValue.index() != 0) {
                        buffer += ",\"min\":" + std::to_string(std::get<float>(param.minValue));
                    }
                    if (param.maxValue.index() != 0) {
                        buffer += ",\"max\":" + std::to_string(std::get<float>(param.maxValue));
                    }
                } else if (param.type == ParameterInfo::INT) {
                    buffer += ",\"default\":" + std::to_string(std::get<int>(param.defaultValue));
                    if (param.minValue.index() != 0) {
                        buffer += ",\"min\":" + std::to_string(std::get<int>(param.minValue));
                    }
                    if (param.maxValue.index() != 0) {
                        buffer += ",\"max\":" + std::to_string(std::get<int>(param.maxValue));
                    }
                } else if (param.type == ParameterInfo::BOOL) {
                    buffer += ",\"default\":";
                    buffer += (std::get<bool>(param.defaultValue) ? "true" : "false");
                } else if (param.type == ParameterInfo::SELECT) {
                    buffer += ",\"default\":\"" + std::get<std::string>(param.defaultValue) + "\"";
                    buffer += ",\"options\":[";
                    for (size_t i = 0; i < param.options.size(); i++) {
                        if (i > 0) buffer += ",";
                        buffer += "\"" + param.options[i] + "\"";
                    }
                    buffer += "]";
                }
                
                buffer += "}";
                return buffer.c_str();
            }
        }
        return nullptr;
    }
    
    // ========================================
    // OPERATOR INSTANCE MANAGEMENT API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    int createOperatorInstance(const char* operatorName) {
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            int id = nextOperatorId++;
            activeOperators[id] = std::move(op);
            return id;
        }
        return -1; // Error
    }
    
    EMSCRIPTEN_KEEPALIVE
    void destroyOperatorInstance(int operatorId) {
        activeOperators.erase(operatorId);
    }
    
    // ========================================
    // BUFFER MANAGEMENT API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void setBufferDimensions(uint32_t width, uint32_t height) {
        BufferManager::getInstance().setDimensions(width, height);
    }
    
    EMSCRIPTEN_KEEPALIVE
    uint32_t getBufferWidth() {
        return BufferManager::getInstance().getWidth();
    }
    
    EMSCRIPTEN_KEEPALIVE
    uint32_t getBufferHeight() {
        return BufferManager::getInstance().getHeight();
    }
    
    EMSCRIPTEN_KEEPALIVE
    CRGB* getBuffer1Pointer() {
        return BufferManager::getInstance().getBuffer1();
    }
    
    EMSCRIPTEN_KEEPALIVE
    CRGB* getBuffer2Pointer() {
        return BufferManager::getInstance().getBuffer2();
    }
    
    EMSCRIPTEN_KEEPALIVE
    CRGB* getOutputBufferPointer() {
        return BufferManager::getInstance().getOutputBuffer();
    }
    
    EMSCRIPTEN_KEEPALIVE
    void clearBuffer1() {
        BufferManager::getInstance().clearBuffer1();
    }
    
    EMSCRIPTEN_KEEPALIVE
    void clearBuffer2() {
        BufferManager::getInstance().clearBuffer2();
    }
    
    EMSCRIPTEN_KEEPALIVE
    void clearOutputBuffer() {
        BufferManager::getInstance().clearOutputBuffer();
    }
    
    // ========================================
    // BATCH BUFFER OPERATIONS (NEW - OPTIMIZED)
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void setBuffer(int bufferIndex, uint8_t* rgbData, uint32_t length) {
        auto& bufferMgr = BufferManager::getInstance();
        CRGB* buffer = nullptr;
        
        switch (bufferIndex) {
            case 1: buffer = bufferMgr.getBuffer1(); break;
            case 2: buffer = bufferMgr.getBuffer2(); break;
            default: return; // Invalid buffer index
        }
        
        uint32_t totalPixels = bufferMgr.getTotalPixels();
        uint32_t pixelsToSet = std::min(length / 3, totalPixels);
        
        for (uint32_t i = 0; i < pixelsToSet; i++) {
            buffer[i] = CRGB(rgbData[i * 3], rgbData[i * 3 + 1], rgbData[i * 3 + 2]);
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void getBuffer(int bufferIndex, uint8_t* rgbData, uint32_t length) {
        auto& bufferMgr = BufferManager::getInstance();
        CRGB* buffer = nullptr;
        
        switch (bufferIndex) {
            case 0: buffer = bufferMgr.getOutputBuffer(); break;
            case 1: buffer = bufferMgr.getBuffer1(); break;
            case 2: buffer = bufferMgr.getBuffer2(); break;
            default: return; // Invalid buffer index
        }
        
        uint32_t totalPixels = bufferMgr.getTotalPixels();
        uint32_t pixelsToGet = std::min(length / 3, totalPixels);
        
        for (uint32_t i = 0; i < pixelsToGet; i++) {
            rgbData[i * 3] = buffer[i].r;
            rgbData[i * 3 + 1] = buffer[i].g;
            rgbData[i * 3 + 2] = buffer[i].b;
        }
    }
    
    // ========================================
    // LEGACY INDIVIDUAL PIXEL OPERATIONS (DEPRECATED)
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void setBuffer1Pixel(uint32_t index, uint8_t r, uint8_t g, uint8_t b) {
        auto* buffer = BufferManager::getInstance().getBuffer1();
        uint32_t totalPixels = BufferManager::getInstance().getTotalPixels();
        if (index < totalPixels) {
            buffer[index] = CRGB(r, g, b);
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setBuffer2Pixel(uint32_t index, uint8_t r, uint8_t g, uint8_t b) {
        auto* buffer = BufferManager::getInstance().getBuffer2();
        uint32_t totalPixels = BufferManager::getInstance().getTotalPixels();
        if (index < totalPixels) {
            buffer[index] = CRGB(r, g, b);
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    uint32_t getOutputPixel(uint32_t index) {
        auto* buffer = BufferManager::getInstance().getOutputBuffer();
        uint32_t totalPixels = BufferManager::getInstance().getTotalPixels();
        if (index < totalPixels) {
            CRGB pixel = buffer[index];
            return (pixel.r << 16) | (pixel.g << 8) | pixel.b;
        }
        return 0;
    }
    
    // ========================================
    // OPERATOR RENDERING API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void renderOperator(
        int operatorId,
        uint32_t timestampMs,
        uint32_t deltaTimeMs,
        bool useBuffer1,
        bool useBuffer2
    ) {
        auto it = activeOperators.find(operatorId);
        if (it != activeOperators.end()) {
            auto& bufferMgr = BufferManager::getInstance();
            
            CRGB* inputBuffer1 = useBuffer1 ? bufferMgr.getBuffer1() : nullptr;
            CRGB* inputBuffer2 = useBuffer2 ? bufferMgr.getBuffer2() : nullptr;
            CRGB* outputBuffer = bufferMgr.getOutputBuffer();
            
            // Empty parameters for now - will be enhanced with parameter setting API
            std::vector<ParameterValue> parameters;
            
            it->second->render(
                outputBuffer,
                inputBuffer1,
                inputBuffer2,
                bufferMgr.getWidth(),
                bufferMgr.getHeight(),
                timestampMs,
                deltaTimeMs,
                parameters
            );
        }
    }
    
    // ========================================
    // PARAMETER SETTING API
    // ========================================
    
    // Global parameter storage for operators
    std::map<int, std::vector<ParameterValue>> operatorParameters;
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorFloatParameter(int operatorId, int paramIndex, float value) {
        if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
            operatorParameters[operatorId].resize(paramIndex + 1);
        }
        operatorParameters[operatorId][paramIndex] = value;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorIntParameter(int operatorId, int paramIndex, int value) {
        if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
            operatorParameters[operatorId].resize(paramIndex + 1);
        }
        operatorParameters[operatorId][paramIndex] = value;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorBoolParameter(int operatorId, int paramIndex, bool value) {
        if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
            operatorParameters[operatorId].resize(paramIndex + 1);
        }
        operatorParameters[operatorId][paramIndex] = value;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorStringParameter(int operatorId, int paramIndex, const char* value) {
        if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
            operatorParameters[operatorId].resize(paramIndex + 1);
        }
        operatorParameters[operatorId][paramIndex] = std::string(value);
    }
    
    EMSCRIPTEN_KEEPALIVE
    void renderOperatorWithParameters(
        int operatorId,
        uint32_t timestampMs,
        uint32_t deltaTimeMs,
        bool useBuffer1,
        bool useBuffer2
    ) {
        auto it = activeOperators.find(operatorId);
        if (it != activeOperators.end()) {
            auto& bufferMgr = BufferManager::getInstance();
            
            CRGB* inputBuffer1 = useBuffer1 ? bufferMgr.getBuffer1() : nullptr;
            CRGB* inputBuffer2 = useBuffer2 ? bufferMgr.getBuffer2() : nullptr;
            CRGB* outputBuffer = bufferMgr.getOutputBuffer();
            
            // Get parameters for this operator
            auto& parameters = operatorParameters[operatorId];
            
            it->second->render(
                outputBuffer,
                inputBuffer1,
                inputBuffer2,
                bufferMgr.getWidth(),
                bufferMgr.getHeight(),
                timestampMs,
                deltaTimeMs,
                parameters
            );
        }
    }
    
    // ========================================
    // FASTLED INTEGRATION
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void copyOutputToLeds() {
        auto& bufferMgr = BufferManager::getInstance();
        auto* outputBuffer = bufferMgr.getOutputBuffer();
        uint32_t totalPixels = std::min((uint32_t)NUM_LEDS, bufferMgr.getTotalPixels());
        
        for (uint32_t i = 0; i < totalPixels; i++) {
            leds[i] = outputBuffer[i];
        }
    }
}

void setup() {
    FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
    FastLED.setBrightness(128);
    
    // Initialize buffer manager
    BufferManager::getInstance().setDimensions(NUM_LEDS, 1);
    
    // Clear all buffers
    BufferManager::getInstance().clearBuffer1();
    BufferManager::getInstance().clearBuffer2();
    BufferManager::getInstance().clearOutputBuffer();
}

void loop() {
    // Copy output buffer to FastLED array
    copyOutputToLeds();
    FastLED.show();
} 