#pragma once

#include <FastLED.h>
#include <vector>
#include <string>
#include <map>
#include <functional>
#include <set>
#ifndef ESP32_BUILD
#include <emscripten/emscripten.h>
#endif

// ESP32-compatible parameter value (replacement for std::variant)
struct ParameterValue {
    enum Type { FLOAT, INT, BOOL, STRING, COLOR } type;
    union {
        float floatVal;
        int intVal;
        bool boolVal;
        CRGB colorVal;
    };
    std::string stringVal; // String outside union
    
    ParameterValue() : type(FLOAT), floatVal(0.0f) {}
    ParameterValue(float f) : type(FLOAT), floatVal(f) {}
    ParameterValue(int i) : type(INT), intVal(i) {}
    ParameterValue(bool b) : type(BOOL), boolVal(b) {}
    ParameterValue(CRGB c) : type(COLOR), colorVal(c) {}
    ParameterValue(const std::string& s) : type(STRING), stringVal(s) {}
    ParameterValue(const char* s) : type(STRING), stringVal(s) {}
    
    // Copy constructor
    ParameterValue(const ParameterValue& other) : type(other.type), stringVal(other.stringVal) {
        switch(type) {
            case FLOAT: floatVal = other.floatVal; break;
            case INT: intVal = other.intVal; break;
            case BOOL: boolVal = other.boolVal; break;
            case COLOR: colorVal = other.colorVal; break;
            case STRING: break; // already copied stringVal
        }
    }
    
    // Assignment operator
    ParameterValue& operator=(const ParameterValue& other) {
        if (this != &other) {
            type = other.type;
            stringVal = other.stringVal;
            switch(type) {
                case FLOAT: floatVal = other.floatVal; break;
                case INT: intVal = other.intVal; break;
                case BOOL: boolVal = other.boolVal; break;
                case COLOR: colorVal = other.colorVal; break;
                case STRING: break; // already copied stringVal
            }
        }
        return *this;
    }
};

// Parameter metadata
struct ParameterInfo {
    std::string name;
    std::string label;
    enum Type { FLOAT, INT, BOOL, COLOR, SELECT, STRING } type; // STRING last: keeps existing values stable
    ParameterValue defaultValue;
    ParameterValue minValue;
    ParameterValue maxValue;
    std::vector<std::string> options; // For SELECT type
    
    ParameterInfo(const std::string& n, const std::string& l, Type t, ParameterValue def)
        : name(n), label(l), type(t), defaultValue(def) {}
        
    ParameterInfo(const std::string& n, const std::string& l, Type t, ParameterValue def, 
                  ParameterValue min, ParameterValue max)
        : name(n), label(l), type(t), defaultValue(def), minValue(min), maxValue(max) {}
        
    ParameterInfo(const std::string& n, const std::string& l, Type t, ParameterValue def,
                  const std::vector<std::string>& opts)
        : name(n), label(l), type(t), defaultValue(def), options(opts) {}
};

// Base class for all LED operators
class BaseOperator {
public:
    BaseOperator() = default;
    virtual ~BaseOperator() = default;

    // Main render function - output buffer moved to end
    virtual void render(
        CRGB* inputBuffer1,
        CRGB* inputBuffer2,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) = 0;

    // Metadata functions
    virtual const char* getName() const = 0; // Short lowercase name for serialization/lookups
    virtual const char* getDisplayName() const = 0;
    virtual std::vector<ParameterInfo> getParameterInfo() const = 0;
    
    // Helper functions for parameter access (ESP32-compatible, no templates)
    
    float getFloat(const std::vector<ParameterValue>& params, size_t index, float defaultVal = 0.0f) const {
        if (index >= params.size()) return defaultVal;
        const ParameterValue& param = params[index];
        if (param.type == ParameterValue::FLOAT) return param.floatVal;
        if (param.type == ParameterValue::INT) return (float)param.intVal;
        return defaultVal;
    }
    
    int getInt(const std::vector<ParameterValue>& params, size_t index, int defaultVal = 0) const {
        if (index >= params.size()) return defaultVal;
        const ParameterValue& param = params[index];
        if (param.type == ParameterValue::INT) return param.intVal;
        if (param.type == ParameterValue::FLOAT) return (int)param.floatVal;
        return defaultVal;
    }
    
    bool getBool(const std::vector<ParameterValue>& params, size_t index, bool defaultVal = false) const {
        if (index >= params.size()) return defaultVal;
        const ParameterValue& param = params[index];
        if (param.type == ParameterValue::BOOL) return param.boolVal;
        // The app may send a boolean param as a 0/1 number, so accept numeric too.
        if (param.type == ParameterValue::INT) return param.intVal != 0;
        if (param.type == ParameterValue::FLOAT) return param.floatVal != 0.0f;
        return defaultVal;
    }
    
    std::string getString(const std::vector<ParameterValue>& params, size_t index, const std::string& defaultVal = "") const {
        if (index >= params.size()) return defaultVal;
        const ParameterValue& param = params[index];
        if (param.type == ParameterValue::STRING) return param.stringVal;
        return defaultVal;
    }
    
    CRGB getColor(const std::vector<ParameterValue>& params, size_t index, CRGB defaultVal = CRGB::Black) const {
        if (index >= params.size()) return defaultVal;
        const ParameterValue& param = params[index];
        if (param.type == ParameterValue::COLOR) return param.colorVal;
        return defaultVal;
    }

    // Fractal (fBm) noise: sum `octaves` of FastLED's inoise8 at doubling frequency and
    // halving amplitude. 1 octave == plain Perlin; more octaves add natural fractal
    // detail (clouds/turbulence). Returns 0..255, centered ~128.
    static uint8_t fbm8(uint32_t x, uint32_t y, uint32_t z, int octaves) {
        if (octaves < 1) octaves = 1;
        if (octaves > 6) octaves = 6;
        long total = 0, norm = 0, amp = 128;
        for (int o = 0; o < octaves && amp > 0; o++) {
            total += ((int)inoise8(x, y, z) - 128) * amp;
            norm += amp;
            amp >>= 1;
            x <<= 1; y <<= 1; z <<= 1;
        }
        if (norm == 0) norm = 1;
        int v = 128 + (int)(total / norm);
        return (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
    }
};

// Operator factory function type (using unique_ptr)
using OperatorFactory = std::function<std::unique_ptr<BaseOperator>()>;

// Operator registry class - singleton pattern
class OperatorRegistry {
private:
    std::map<std::string, std::function<std::unique_ptr<BaseOperator>()>> creators;
    
    OperatorRegistry() {
        // Operators register themselves automatically via REGISTER_OPERATOR macro
    }
    
public:
    static OperatorRegistry& getInstance() {
        static OperatorRegistry instance;
        return instance;
    }
    
    template<typename T>
    void registerOperator(const std::string& name) {
        creators[name] = []() -> std::unique_ptr<BaseOperator> { return std::unique_ptr<BaseOperator>(new T()); };
    }
    
    std::unique_ptr<BaseOperator> createOperator(const std::string& name) {
        auto it = creators.find(name);
        if (it != creators.end()) {
            return it->second();
        }
        return nullptr;
    }
    
    std::set<std::string> getOperatorNames() const {
        std::set<std::string> names;
        for (const auto& pair : creators) {
            names.insert(pair.first);
        }
        return names;
    }
    
    int getOperatorCount() const {
        return creators.size();
    }
};

// Auto-registration helper class
template<typename T>
class OperatorRegistrar {
public:
    OperatorRegistrar(const std::string& /* className */) {
        // Create a temporary instance to get the short name
        T temp;
        std::string shortName = temp.getName();
        OperatorRegistry::getInstance().registerOperator<T>(shortName);
    }
};

// Macro for easy operator registration
#define REGISTER_OPERATOR(ClassName) static OperatorRegistrar<ClassName> g_##ClassName##_registrar(#ClassName)