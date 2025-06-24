#ifndef FASTLED_PATTERNS_H
#define FASTLED_PATTERNS_H

#include <stdint.h>
#include <stdbool.h>
#include <cmath>

#ifdef __EMSCRIPTEN__
// WASM build - provide essential FastLED-compatible types and functions
#include <emscripten.h>

// CRGB color type (compatible with FastLED)
struct CRGB {
    uint8_t r, g, b;
    
    CRGB() : r(0), g(0), b(0) {}
    CRGB(uint8_t red, uint8_t green, uint8_t blue) : r(red), g(green), b(blue) {}
    
    // Assignment from CHSV
    CRGB& operator=(const struct CHSV& hsv);
};

// CHSV color type (compatible with FastLED)
struct CHSV {
    uint8_t h, s, v;
    
    CHSV() : h(0), s(0), v(0) {}
    CHSV(uint8_t hue, uint8_t sat, uint8_t val) : h(hue), s(sat), v(val) {}
    
    // Conversion to CRGB
    operator CRGB() const;
};

// FastLED-compatible timing functions
uint8_t beat8(uint16_t beats_per_minute, uint32_t timebase = 0);
uint16_t beat16(uint16_t beats_per_minute, uint32_t timebase = 0);

#else
// ESP32 build - use standard FastLED
#include <FastLED.h>
#endif

// Point structure for display coordinates
typedef struct {
    float x;        // X coordinate in unit square (0.0 to 1.0)
    float y;        // Y coordinate in unit square (0.0 to 1.0)
    uint32_t index; // Index into CRGB buffer
} DisplayPoint;

// Pattern context structure
typedef struct {
    DisplayPoint* points;     // Array of display points
    uint32_t point_count;     // Number of points
    CRGB* color_buffer;       // Main color buffer
    CRGB* input_buffer1;      // First input buffer (for blend operations)
    CRGB* input_buffer2;      // Second input buffer (for blend operations)
    uint32_t timestamp_ms;    // Current timestamp in milliseconds
    uint32_t delta_time_ms;   // Time since last call in milliseconds
    bool is_starting;         // True if pattern is being initialized
    bool is_ending;           // True if pattern is being cleaned up
    float aspect_ratio;       // Display aspect ratio (width/height)
    float* parameters;        // Array of parameter values
    uint32_t param_count;     // Number of parameters
} PatternContext;

// Parameter definition structure
typedef struct {
    const char* name;
    const char* label;
    const char* type;         // "float", "int", "color", "select"
    float default_value;
    float min_value;
    float max_value;
    const char** options;     // For select type parameters
    uint32_t option_count;
} PatternParameter;

// Pattern definition structure
typedef struct {
    const char* name;
    const char* type;
    const PatternParameter* parameters;
    uint32_t param_count;
    void (*pattern_func)(PatternContext* ctx);
} PatternDefinition;

// Pattern function declarations
extern "C" {
    void rainbow_pattern(PatternContext* ctx);
    void gradient_pattern(PatternContext* ctx);
    void perlin_noise_pattern(PatternContext* ctx);
    void moving_blob_pattern(PatternContext* ctx);
    void strobe_pattern(PatternContext* ctx);
    void sparkle_pattern(PatternContext* ctx);
    void blend_pattern(PatternContext* ctx);
}

// Pattern registry
extern const PatternDefinition PATTERN_DEFINITIONS[];
extern const uint32_t PATTERN_COUNT;

// Utility functions
inline void set_point_color(PatternContext* ctx, uint32_t point_index, CRGB color) {
    if (point_index < ctx->point_count) {
        uint32_t buffer_index = ctx->points[point_index].index;
        ctx->color_buffer[buffer_index] = color;
    }
}

inline CRGB get_point_color(PatternContext* ctx, uint32_t point_index) {
    if (point_index < ctx->point_count) {
        uint32_t buffer_index = ctx->points[point_index].index;
        return ctx->color_buffer[buffer_index];
    }
    return CRGB(0, 0, 0);
}

inline CRGB get_input1_color(PatternContext* ctx, uint32_t point_index) {
    if (ctx->input_buffer1 && point_index < ctx->point_count) {
        uint32_t buffer_index = ctx->points[point_index].index;
        return ctx->input_buffer1[buffer_index];
    }
    return CRGB(0, 0, 0);
}

inline CRGB get_input2_color(PatternContext* ctx, uint32_t point_index) {
    if (ctx->input_buffer2 && point_index < ctx->point_count) {
        uint32_t buffer_index = ctx->points[point_index].index;
        return ctx->input_buffer2[buffer_index];
    }
    return CRGB(0, 0, 0);
}

#endif // FASTLED_PATTERNS_H 