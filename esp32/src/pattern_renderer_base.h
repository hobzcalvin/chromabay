#pragma once

#include <FastLED.h>
#include <vector>
#include "led_manager.h"
#include "mpack.h"

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
    CRGB** buffers; // Dynamically allocated buffers
    Pattern currentPattern;
    bool hasPattern = false;
    unsigned long lastFrameTime;
    unsigned long frameStartTime;
    unsigned long globalTime;
    // Frame time captured once per update(), reused by each per-strip graph render
    // so all strips render the same instant.
    uint32_t frameFloatTime = 0;
    uint32_t frameFloatDelta = 0;
    
    // Timestamp synchronization
    unsigned long syncedBaseTime = 0;       // Synchronized base timestamp
    unsigned long syncedLocalTime = 0;      // Local millis() when sync was received
    bool useSyncedTime = false;             // Whether to use synchronized time
    
    bool buffersAllocated = false;

    // Helper functions
    void clearBuffer(int bufferIndex);
    CRGB* getBufferPtr(int bufferIndex);
    void allocateBuffers();
    void deallocateBuffers();
    void initializeFromLedConfig();
    unsigned long getCurrentTime(); // Get current time (synced or local)
    // Run the whole operator graph into the shared buffers at the given canvas size.
    // Called once per strip from render() so each strip gets its own native render.
    void renderGraphAt(uint16_t width, uint16_t height);
    
    // Get current dimensions from LED config (single source of truth)
    uint16_t getMatrixWidth() const;
    uint16_t getMatrixHeight() const;
    uint32_t getTotalPixels() const;
    
public:
    PatternRendererBase(LedConfig::LedManager* ledMgr);
    virtual ~PatternRendererBase();
    
    // Configuration
    void updateMatrixConfig(); // Call when LED config changes
    
    // Timestamp synchronization
    void setSynchronizedTime(unsigned long syncTimestamp, unsigned long localTime);
    void clearSynchronizedTime();
    
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
