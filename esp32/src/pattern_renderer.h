#pragma once

#include <FastLED.h>
#include <vector>
#include <map>
#include "led_manager.h"
#include "mpack.h"

// Display configuration
#define DISPLAY_WIDTH 5
#define DISPLAY_HEIGHT 5
#define DISPLAY_PIXELS (DISPLAY_WIDTH * DISPLAY_HEIGHT)
#define NUM_BUFFERS 3 // Three lanes for patterns

// Operator types supported on ESP32
enum class ESP32OperatorType {
    BLEND,
    CHASE,
    FADE,
    GRADIENT,
    MOVING_BLOB,
    PERLIN_NOISE,
    RAINBOW,
    RAINDROPS,
    SPARKLE,
    STROBE
};

// Parameter structure for operators
struct OperatorParameter {
    float value;
    String name;
};

// Node structure for pattern execution
struct PatternNode {
    ESP32OperatorType type;
    std::vector<OperatorParameter> parameters;
    int inputBuffer = -1;     // Buffer index to read from (-1 if none)
    int outputBuffer = 0;     // Buffer index to write to
    int secondInputBuffer = -1; // Second input for blend operations
};

// Pattern structure
struct Pattern {
    std::vector<PatternNode> nodes;
    int outputBuffer = 0; // Which buffer to display (default left lane, should be overridden by parsing)
    String name;
};

// FastLED timing functions for ESP32 compatibility
uint8_t beat8_esp32(uint16_t beats_per_minute, uint32_t timebase = 0);
uint16_t beat16_esp32(uint16_t beats_per_minute, uint32_t timebase = 0);

// Noise functions (simplified for ESP32)
uint8_t inoise8_esp32(uint16_t x, uint16_t y = 0, uint16_t z = 0);

// Math functions
uint8_t sin8_esp32(uint8_t theta);
uint8_t cos8_esp32(uint8_t theta);
uint8_t random8_esp32();
uint8_t random8_esp32(uint8_t max);
uint8_t qadd8_esp32(uint8_t a, uint8_t b);
uint8_t qsub8_esp32(uint8_t a, uint8_t b);

// Pattern renderer class
class PatternRenderer {
private:
    // LED buffers for the three lanes
    CRGB buffers[NUM_BUFFERS][DISPLAY_PIXELS];
    
    // Current pattern
    Pattern currentPattern;
    
    // Timing
    unsigned long lastFrameTime;
    unsigned long frameStartTime;
    uint32_t globalTime;
    
    // LED manager reference
    LedConfig::LedManager* ledManager;
    
    // Helper functions
    void clearBuffer(int bufferIndex);
    void copyBuffer(int sourceBuffer, int destBuffer);
    void setPixel(int bufferIndex, int x, int y, CRGB color);
    CRGB getPixel(int bufferIndex, int x, int y);
    float getParameterValue(const std::vector<OperatorParameter>& params, const String& name, float defaultValue);
    
    // Operator implementations
    void executeBlendOperator(const PatternNode& node);
    void executeChaseOperator(const PatternNode& node);
    void executeFadeOperator(const PatternNode& node);
    void executeGradientOperator(const PatternNode& node);
    void executeMovingBlobOperator(const PatternNode& node);
    void executePerlinNoiseOperator(const PatternNode& node);
    void executeRainbowOperator(const PatternNode& node);
    void executeRaindropsOperator(const PatternNode& node);
    void executeSparkleOperator(const PatternNode& node);
    void executeStrobeOperator(const PatternNode& node);
    
public:
    PatternRenderer(LedConfig::LedManager* ledMgr);
    
    // Pattern management
    bool loadPatternFromMessagePack(const uint8_t* data, size_t size);
    void setPattern(const Pattern& pattern);
    const Pattern& getCurrentPattern() const { return currentPattern; }
    
    // Rendering
    void update();
    void render();
    
    // Display configuration
    static int getDisplayWidth() { return DISPLAY_WIDTH; }
    static int getDisplayHeight() { return DISPLAY_HEIGHT; }
    static int getTotalPixels() { return DISPLAY_PIXELS; }
    
    // Buffer access for debugging
    const CRGB* getBuffer(int bufferIndex) const;
};

// Global pattern renderer instance
extern PatternRenderer* g_patternRenderer;

// Utility functions
ESP32OperatorType parseOperatorType(const String& typeString);
String operatorTypeToString(ESP32OperatorType type); 