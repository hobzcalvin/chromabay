#pragma once

#include <FastLED.h>
#include <vector>
#include "led_manager.h"
#include "mpack.h"

#define NUM_BUFFERS 4 // Three lanes for patterns (0/1/2) + one scratch (3)
#define SCRATCH_BUFFER 3 // Internal: render here when output aliases an input, then copy back

// Define ESP32 build to disable emscripten includes
#define ESP32_BUILD

// Include native operator system (now ESP32-compatible!)
#include "../../native/BaseOperator.h"
#include "../../native/Modulation.h"
#include "../../native/OperatorList.h"

// Per-parameter automation config (parallel to PatternNode.parameters; inactive = static value).
struct ParamModulator {
    bool active = false;
    bool isInt = false;   // round the modulated value for integer params (cached from param info)
    int shape = 0;
    float mn = 0.0f, mx = 1.0f, period = 1.0f;
    uint32_t seed = 0;    // per-instance decorrelation seed (from app: node id + param name)
    // Phase state (mutable: updated during const render) so a live period change stays continuous.
    // Carried across pattern reloads by the PRESERVED path in setPattern().
    mutable Modulation::ModState st;
};

// Node structure for pattern execution
struct PatternNode {
    std::unique_ptr<BaseOperator> op;  // Unique pointer to operator
    std::vector<ParameterValue> parameters;
    std::vector<ParamModulator> modulators; // empty, or same size as parameters
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
    std::vector<ParameterValue> _effParams; // reused scratch for modulated parameter values

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

    // Name of the currently-loaded pattern (meta.name from the last
    // loadPatternFromMessagePack). Used to key the on-device pattern library.
    const char* getCurrentPatternName() const { return currentPattern.name.c_str(); }
};
