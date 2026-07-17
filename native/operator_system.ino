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
#include "Modulation.h"

// Include all operators via centralized list
#include "OperatorList.h"

// Global operator instance management - using vectors with unique_ptr
std::vector<std::unique_ptr<BaseOperator>> activeOperators;
std::vector<std::vector<ParameterValue>> operatorParameters;
// Per-instance, per-parameter automation (LFO/noise/random). Applied over the base parameter
// value each frame in renderOperator; the operator itself never sees the difference.
struct OpModulator { bool active = false; int shape = 0; float mn = 0.0f, mx = 1.0f, period = 1.0f; uint32_t seed = 0; Modulation::ModState st; };
std::vector<std::vector<OpModulator>> operatorModulators;
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
        auto operatorNames = OperatorRegistry::getInstance().getOperatorNames();
        if (index >= 0 && index < (int)operatorNames.size()) {
            // Convert set to vector for indexing
            auto it = operatorNames.begin();
            std::advance(it, index);
            
            // Registry now stores by short names directly
            static std::string buffer;
            buffer = *it;
            return buffer.c_str();
        }
        return nullptr;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorDisplayName(const char* operatorName) {
        // operatorName is the short name, which is now the registry key
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
        // operatorName is the short name, which is now the registry key
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            return op->getParameterInfo().size();
        }
        return 0;
    }
    
    EMSCRIPTEN_KEEPALIVE
    const char* getOperatorParameterInfo(const char* operatorName, int paramIndex) {
        // operatorName is the short name, which is now the registry key
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            auto params = op->getParameterInfo();
            if (paramIndex >= 0 && paramIndex < (int)params.size()) {
                static std::string buffer;
                const auto& param = params[paramIndex];
                
                buffer = std::string("{\"name\":\"") + param.name + 
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
                } else if (param.type == ParameterInfo::COLOR) {
                    // Default travels as a "#rrggbb" hex string — what the app's <input type=color> expects.
                    const CRGB& c = param.defaultValue.colorVal;
                    char hex[8];
                    snprintf(hex, sizeof(hex), "#%02x%02x%02x", c.r, c.g, c.b);
                    buffer += std::string(",\"default\":\"") + hex + "\"";
                } else if (param.type == ParameterInfo::SELECT) {
                    // A SELECT is an enum: its value travels as the integer option index.
                    // The default is that index (the label is display-only, in options[]).
                    int defIdx = (param.defaultValue.type == ParameterValue::INT) ? param.defaultValue.intVal : 0;
                    buffer += ",\"default\":" + std::to_string(defIdx);
                    buffer += ",\"options\":[";
                    for (size_t i = 0; i < param.options.size(); i++) {
                        if (i > 0) buffer += ",";
                        buffer += std::string("\"") + param.options[i] + "\"";
                    }
                    buffer += "]";
                } else if (param.type == ParameterInfo::STRING) {
                    // Text param: default is a JSON-escaped string; maxLen bounds the editor input.
                    std::string esc;
                    for (char c : param.defaultValue.stringVal) {
                        if (c == '"' || c == '\\') esc += '\\';
                        if (c == '\n') { esc += "\\n"; continue; }
                        esc += c;
                    }
                    // 4096 accommodates flattened SVG-fill polygon blobs (SvgFillOperator),
                    // not just short Text strings.
                    buffer += ",\"default\":\"" + esc + "\",\"maxLen\":4096";
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
        // operatorName is the short name, which is now the registry key
        auto op = OperatorRegistry::getInstance().createOperator(operatorName);
        if (op) {
            int id = nextOperatorId++;
            
            // Resize vectors if needed
            if (activeOperators.size() <= (size_t)id) {
                activeOperators.resize(id + 1);
            }
            if (operatorParameters.size() <= (size_t)id) {
                operatorParameters.resize(id + 1);
            }
            
            activeOperators[id] = std::move(op);
            printf("Created operator instance %d for %s\n", id, operatorName);
            return id;
        }
        printf("Could not find operator: %s\n", operatorName);
        return -1;
    }
    
    EMSCRIPTEN_KEEPALIVE
    void destroyOperatorInstance(int operatorId) {
        if (operatorId >= 0 && operatorId < (int)activeOperators.size()) {
            activeOperators[operatorId].reset();
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
            // A SELECT is an enum read with getInt(). Its value normally arrives as an int
            // (setOperatorIntParameter), but tolerate a string here too: either a numeric
            // index ("2") or a label ("Multiply"). Genuine string params keep the raw string.
            if (operatorId < (int)activeOperators.size() && activeOperators[operatorId]) {
                auto info = activeOperators[operatorId]->getParameterInfo();
                if (paramIndex < (int)info.size() && info[paramIndex].type == ParameterInfo::SELECT) {
                    const auto& opts = info[paramIndex].options;
                    int idx = 0;
                    bool numeric = value[0] != '\0';
                    for (const char* p = value; *p; ++p) if (*p < '0' || *p > '9') { numeric = false; break; }
                    if (numeric) {
                        idx = atoi(value);
                    } else {
                        for (size_t i = 0; i < opts.size(); i++) {
                            if (opts[i] == value) { idx = (int)i; break; }
                        }
                    }
                    operatorParameters[operatorId][paramIndex] = idx;
                    return;
                }
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
    // PARAMETER AUTOMATION API
    // ========================================

    EMSCRIPTEN_KEEPALIVE
    void setOperatorModulator(int operatorId, int paramIndex, int shape, float mn, float mx, float period, int seed) {
        if (operatorId < 0 || paramIndex < 0) return;
        if ((int)operatorModulators.size() <= operatorId) operatorModulators.resize(operatorId + 1);
        auto& mods = operatorModulators[operatorId];
        if ((int)mods.size() <= paramIndex) mods.resize(paramIndex + 1);
        // Update the config in place — keep the phase state (st) so frequent param re-syncs
        // don't reset the phase; modulate() shifts the offset when `period` actually changes.
        auto& m = mods[paramIndex];
        m.active = true; m.shape = shape; m.mn = mn; m.mx = mx; m.period = period; m.seed = (uint32_t)seed;
    }

    EMSCRIPTEN_KEEPALIVE
    void clearOperatorModulator(int operatorId, int paramIndex) {
        if (operatorId >= 0 && operatorId < (int)operatorModulators.size() &&
            paramIndex >= 0 && paramIndex < (int)operatorModulators[operatorId].size()) {
            operatorModulators[operatorId][paramIndex].active = false;
        }
    }

    // Standalone evaluation for the editor's live slider readout (no instance needed).
    EMSCRIPTEN_KEEPALIVE
    float evalModulator(int shape, float mn, float mx, float period, uint32_t timestampMs, int seed) {
        return Modulation::modulate(shape, mn, mx, period, timestampMs, (uint32_t)seed);
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
        uint32_t timestampMs,  // Real milliseconds (same units the ESP32 feeds operators directly)
        uint32_t deltaTimeMs
    ) {
        if (operatorId >= 0 && operatorId < (int)activeOperators.size() && activeOperators[operatorId]) {
            static std::vector<ParameterValue> emptyParams;
            auto& parameters = (operatorId < (int)operatorParameters.size()) ?
                operatorParameters[operatorId] :
                emptyParams;

            // Apply any parameter automation over a COPY of the base values (never mutate the
            // stored base). Each modulator carries its own seed (from node id + param name) so
            // simultaneous Random/Perlin automations decorrelate instead of moving in lockstep.
            static std::vector<ParameterValue> eff;
            eff = parameters;
            if (operatorId < (int)operatorModulators.size()) {
                auto& mods = operatorModulators[operatorId];
                auto info = activeOperators[operatorId]->getParameterInfo();
                // A param left at its default may not exist in the base vector; size eff up with
                // defaults so a modulated index is always present (else automation would no-op).
                if ((int)eff.size() < (int)info.size()) {
                    size_t old = eff.size(); eff.resize(info.size());
                    for (size_t k = old; k < info.size(); k++) eff[k] = info[k].defaultValue;
                }
                for (int i = 0; i < (int)mods.size() && i < (int)eff.size(); i++) {
                    if (!mods[i].active) continue;
                    float v = Modulation::modulate(mods[i].st, mods[i].shape, mods[i].mn, mods[i].mx, mods[i].period, timestampMs, mods[i].seed);
                    if (i < (int)info.size() && info[i].type == ParameterInfo::INT) eff[i] = ParameterValue((int)lroundf(v));
                    else eff[i] = ParameterValue(v);
                }
            }

            activeOperators[operatorId]->render(
                inputBuffer1,
                inputBuffer2,
                outputBuffer,
                width,
                height,
                timestampMs,
                deltaTimeMs,
                eff
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