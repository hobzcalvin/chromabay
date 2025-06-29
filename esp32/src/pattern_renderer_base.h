#pragma once

#include <FastLED.h>
#include <vector>
#include "led_manager.h"
#include "mpack.h"

// Display configuration
#define DISPLAY_WIDTH 5
#define DISPLAY_HEIGHT 5
#define DISPLAY_PIXELS (DISPLAY_WIDTH * DISPLAY_HEIGHT)
#define NUM_BUFFERS 3 // Three lanes for patterns

// Define ESP32 build to disable emscripten includes
#define ESP32_BUILD

// Include native operator system (now ESP32-compatible!)
#include "../../native/BaseOperator.h"
#include "../../native/OperatorList.h"

// Node structure for pattern execution
struct PatternNode {
    std::unique_ptr<BaseOperator> op;  // Unique pointer to operator
    std::vector<ParameterValue> parameters;
    int inputBuffer = -1;     // Buffer index to read from (-1 if none)
    int outputBuffer = 0;     // Buffer index to write to
    int secondInputBuffer = -1; // Second input for blend operations
    
    PatternNode() : op(nullptr) {}
};

// Pattern structure
struct Pattern {
    std::vector<PatternNode> nodes;
    int outputBuffer = 0; // Which buffer to display
    String name;
};

// Pattern renderer class using native operators
class PatternRendererBase {
protected:
    LedConfig::LedManager* ledManager;
    CRGB buffers[NUM_BUFFERS][DISPLAY_PIXELS];
    Pattern currentPattern;
    bool hasPattern = false;
    unsigned long lastFrameTime;
    unsigned long frameStartTime;
    unsigned long globalTime;

    // Helper functions
    void clearBuffer(int bufferIndex);
    CRGB* getBufferPtr(int bufferIndex);
    
public:
    PatternRendererBase(LedConfig::LedManager* ledMgr);
    virtual ~PatternRendererBase();
    
    // Pattern management
    void setPattern(Pattern&& pattern);
    void clearPattern();
    bool loadPatternFromMessagePack(const uint8_t* data, unsigned int size);
    
    // Rendering
    void update();
    void render();
    
    // Buffer access
    const CRGB* getBuffer(int bufferIndex) const;
};
