/*
 * FASTLED OPERATOR SYSTEM - SIMPLIFIED
 * ====================================
 * 
 * Clean operator system for FastLED WASM with direct buffer management.
 * 
 * Usage:
 * 1. Malloc 3 buffers in JavaScript (buffers 0, 1, 2)
 * 2. Pass buffer pointers directly to render functions
 * 3. Any buffer can be input1, input2, or output
 */

#include <FastLED.h>
#include <emscripten/emscripten.h>

// Include the operator system
#include "OperatorBase.h"

// Include all operator implementations
#include "NoiseBlendOperator.h"

// Global operator instance management
std::map<int, std::unique_ptr<OperatorBase>> activeOperators;
std::map<int, std::vector<ParameterValue>> operatorParameters;
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
        return -1;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void destroyOperatorInstance(int operatorId) {
        activeOperators.erase(operatorId);
        operatorParameters.erase(operatorId);
    }
    
    // ========================================
    // PARAMETER SETTING API
    // ========================================
    
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
    void setOperatorColorParameter(int operatorId, int paramIndex, uint8_t r, uint8_t g, uint8_t b) {
        if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
            operatorParameters[operatorId].resize(paramIndex + 1);
        }
        operatorParameters[operatorId][paramIndex] = CRGB(r, g, b);
    }
    
    // ========================================
    // SIMPLE RENDERING API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void renderOperator(
        int operatorId,
        CRGB* inputBuffer1,
        CRGB* inputBuffer2,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t deltaTimeMs
    ) {
        auto it = activeOperators.find(operatorId);
        if (it != activeOperators.end()) {
            auto& parameters = operatorParameters[operatorId];
            
            it->second->render(
                inputBuffer1,
                inputBuffer2,
                outputBuffer,
                width,
                height,
                timestampMs,
                deltaTimeMs,
                parameters
            );
        }
    }
    
    // ========================================
    // BUFFER UTILITY FUNCTIONS
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void clearBuffer(CRGB* buffer, uint32_t numPixels) {
        if (buffer) {
            fill_solid(buffer, numPixels, CRGB::Black);
        }
    }
}

void setup() {
    // No setup needed for WASM
}

void loop() {
    // No loop needed for WASM
} 