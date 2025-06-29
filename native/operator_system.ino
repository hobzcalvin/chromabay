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

// Include the base operator system
#include "BaseOperator.h"

// Include all operators via centralized list
#include "OperatorList.h"

// Global operator instance management - using vectors instead of std::map
std::vector<BaseOperator*> activeOperators;
std::vector<std::vector<ParameterValue>> operatorParameters;
int nextOperatorId = 1;

// Helper function to find class name by short name (outside extern "C")
std::string findClassNameByShortName(const char* shortName) {
    auto classNames = OperatorRegistry::getInstance().getOperatorNames();
    for (const auto& className : classNames) {
        auto op = OperatorRegistry::getInstance().createOperator(className);
        if (op && std::string(op->getName()) == shortName) {
            return className;
        }
    }
    return "";
}

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
        auto classNames = OperatorRegistry::getInstance().getOperatorNames();
        if (index >= 0 && index < (int)classNames.size()) {
            // Convert set to vector for indexing
            auto it = classNames.begin();
            std::advance(it, index);
            
            // Create operator instance to get the short name
            auto op = OperatorRegistry::getInstance().createOperator(*it);
            if (op) {
                static std::string buffer;
                buffer = op->getName();
                return buffer.c_str();
            }
        }
        return nullptr;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorDisplayName(const char* operatorName) {
        // operatorName is short name, find class name
        std::string className = findClassNameByShortName(operatorName);
        if (className.empty()) return nullptr;
        
        auto op = OperatorRegistry::getInstance().createOperator(className);
        if (op) {
            static std::string buffer;
            buffer = op->getDisplayName();
            return buffer.c_str();
        }
        return nullptr;
    }
    
    EMSCRIPTEN_KEEPALIVE
    int getOperatorParameterCount(const char* operatorName) {
        // operatorName is short name, find class name
        std::string className = findClassNameByShortName(operatorName);
        if (className.empty()) return 0;
        
        auto op = OperatorRegistry::getInstance().createOperator(className);
        if (op) {
            return op->getParameterInfo().size();
        }
        return 0;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorParameterInfo(const char* operatorName, int paramIndex) {
        // operatorName is short name, find class name
        std::string className = findClassNameByShortName(operatorName);
        if (className.empty()) return nullptr;
        
        auto op = OperatorRegistry::getInstance().createOperator(className);
        if (op) {
            auto params = op->getParameterInfo();
            if (paramIndex >= 0 && paramIndex < (int)params.size()) {
                static std::string buffer;
                const auto& param = params[paramIndex];
                
                buffer = "{\"name\":\"" + param.name + 
                        "\",\"label\":\"" + param.label + 
                        "\",\"type\":" + std::to_string((int)param.type);
                
                // Add default value based on type using direct member access
                if (param.type == ParameterInfo::FLOAT) {
                    buffer += ",\"default\":" + std::to_string(param.defaultValue.floatVal);
                    if (param.minValue.type == ParameterValue::FLOAT) {
                        buffer += ",\"min\":" + std::to_string(param.minValue.floatVal);
                    }
                    if (param.maxValue.type == ParameterValue::FLOAT) {
                        buffer += ",\"max\":" + std::to_string(param.maxValue.floatVal);
                    }
                } else if (param.type == ParameterInfo::INT) {
                    buffer += ",\"default\":" + std::to_string(param.defaultValue.intVal);
                    if (param.minValue.type == ParameterValue::INT) {
                        buffer += ",\"min\":" + std::to_string(param.minValue.intVal);
                    }
                    if (param.maxValue.type == ParameterValue::INT) {
                        buffer += ",\"max\":" + std::to_string(param.maxValue.intVal);
                    }
                } else if (param.type == ParameterInfo::BOOL) {
                    buffer += ",\"default\":";
                    buffer += (param.defaultValue.boolVal ? "true" : "false");
                } else if (param.type == ParameterInfo::SELECT) {
                    buffer += ",\"default\":\"" + param.defaultValue.stringVal + "\"";
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
        // operatorName is now the short name (e.g., "rainbow"), need to find class name
        std::string className = findClassNameByShortName(operatorName);
        if (className.empty()) {
            printf("Could not find operator with short name: %s\n", operatorName);
            return -1;
        }
        
        auto op = OperatorRegistry::getInstance().createOperator(className);
        if (op) {
            int id = nextOperatorId++;
            
            // Resize vectors if needed
            if (activeOperators.size() <= (size_t)id) {
                activeOperators.resize(id + 1, nullptr);
            }
            if (operatorParameters.size() <= (size_t)id) {
                operatorParameters.resize(id + 1);
            }
            
            activeOperators[id] = op;
            printf("Created operator instance %d for %s (class: %s)\n", id, operatorName, className.c_str());
            return id;
        }
        return -1;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void destroyOperatorInstance(int operatorId) {
        if (operatorId >= 0 && operatorId < (int)activeOperators.size()) {
            if (activeOperators[operatorId]) {
                delete activeOperators[operatorId];
                activeOperators[operatorId] = nullptr;
            }
            if (operatorId < (int)operatorParameters.size()) {
                operatorParameters[operatorId].clear();
            }
        }
    }
    
    // ========================================
    // PARAMETER SETTING API
    // ========================================
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorFloatParameter(int operatorId, int paramIndex, float value) {
        if (operatorId >= 0 && operatorId < (int)operatorParameters.size()) {
            if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
                operatorParameters[operatorId].resize(paramIndex + 1);
            }
            operatorParameters[operatorId][paramIndex] = value;
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorIntParameter(int operatorId, int paramIndex, int value) {
        if (operatorId >= 0 && operatorId < (int)operatorParameters.size()) {
            if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
                operatorParameters[operatorId].resize(paramIndex + 1);
            }
            operatorParameters[operatorId][paramIndex] = value;
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorBoolParameter(int operatorId, int paramIndex, bool value) {
        if (operatorId >= 0 && operatorId < (int)operatorParameters.size()) {
            if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
                operatorParameters[operatorId].resize(paramIndex + 1);
            }
            operatorParameters[operatorId][paramIndex] = value;
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorStringParameter(int operatorId, int paramIndex, const char* value) {
        if (operatorId >= 0 && operatorId < (int)operatorParameters.size()) {
            if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
                operatorParameters[operatorId].resize(paramIndex + 1);
            }
            operatorParameters[operatorId][paramIndex] = std::string(value);
        }
    }
    
    EMSCRIPTEN_KEEPALIVE
    void setOperatorColorParameter(int operatorId, int paramIndex, uint8_t r, uint8_t g, uint8_t b) {
        if (operatorId >= 0 && operatorId < (int)operatorParameters.size()) {
            if (operatorParameters[operatorId].size() <= (size_t)paramIndex) {
                operatorParameters[operatorId].resize(paramIndex + 1);
            }
            operatorParameters[operatorId][paramIndex] = CRGB(r, g, b);
        }
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
        if (operatorId >= 0 && operatorId < (int)activeOperators.size() && activeOperators[operatorId]) {
            static std::vector<ParameterValue> emptyParams;
            auto& parameters = (operatorId < (int)operatorParameters.size()) ? 
                operatorParameters[operatorId] : 
                emptyParams;
            
            activeOperators[operatorId]->render(
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
    // Vectors start empty, no initialization needed
}

void loop() {
    // No loop needed for WASM
} 