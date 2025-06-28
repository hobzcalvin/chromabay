#pragma once

#include <FastLED.h>
#include <vector>
#include <string>
#include <variant>
#include <map>
#include <functional>
#include <emscripten/emscripten.h>

// Parameter value types - including CRGB for COLOR type
using ParameterValue = std::variant<float, int, bool, std::string, CRGB>;

// Parameter metadata
struct ParameterInfo {
    std::string name;
    std::string label;
    enum Type { FLOAT, INT, BOOL, COLOR, SELECT } type;
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
    
    // Helper functions for parameter access (WASM-compatible, no exceptions)
    template<typename T>
    T getParameter(const std::vector<ParameterValue>& params, size_t index, T defaultVal = T{}) const {
        if (index >= params.size()) return defaultVal;
        
        // Use std::get_if for exception-free access
        const T* value = std::get_if<T>(&params[index]);
        return value ? *value : defaultVal;
    }
    
    float getFloat(const std::vector<ParameterValue>& params, size_t index, float defaultVal = 0.0f) const {
        return getParameter<float>(params, index, defaultVal);
    }
    
    int getInt(const std::vector<ParameterValue>& params, size_t index, int defaultVal = 0) const {
        return getParameter<int>(params, index, defaultVal);
    }
    
    bool getBool(const std::vector<ParameterValue>& params, size_t index, bool defaultVal = false) const {
        return getParameter<bool>(params, index, defaultVal);
    }
    
    std::string getString(const std::vector<ParameterValue>& params, size_t index, const std::string& defaultVal = "") const {
        return getParameter<std::string>(params, index, defaultVal);
    }
    
    CRGB getColor(const std::vector<ParameterValue>& params, size_t index, CRGB defaultVal = CRGB::Black) const {
        return getParameter<CRGB>(params, index, defaultVal);
    }
};

// Operator factory function type
using OperatorFactory = std::function<std::unique_ptr<BaseOperator>()>;

// Operator registry class - singleton pattern
class OperatorRegistry {
private:
    std::map<std::string, OperatorFactory> factories;
    
    OperatorRegistry() = default;
    
public:
    static OperatorRegistry& getInstance() {
        static OperatorRegistry instance;
        return instance;
    }
    
    // Register an operator
    void registerOperator(const std::string& name, OperatorFactory factory) {
        factories[name] = factory;
    }
    
    // Create an operator by name
    std::unique_ptr<BaseOperator> createOperator(const std::string& name) {
        auto it = factories.find(name);
        if (it != factories.end()) {
            return it->second();
        }
        return nullptr;
    }
    
    // Get list of all registered operator names
    std::vector<std::string> getOperatorNames() const {
        std::vector<std::string> names;
        for (const auto& pair : factories) {
            names.push_back(pair.first);
        }
        return names;
    }
    
    // Get count of registered operators
    size_t getOperatorCount() const {
        return factories.size();
    }
};

// Auto-registration helper class
template<typename T>
class OperatorRegistrar {
public:
    OperatorRegistrar(const std::string& name) {
        OperatorRegistry::getInstance().registerOperator(name, []() {
            return std::make_unique<T>();
        });
    }
};

// Macro for easy operator registration
#define REGISTER_OPERATOR(ClassName) \
    static OperatorRegistrar<ClassName> g_##ClassName##_registrar(#ClassName) 