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

// Pattern context structure with 2D buffer
typedef struct {
    CRGB* color_buffer;       // 2D color buffer (width * height)
    CRGB* input_buffer1;      // First input buffer (for blend operations)
    CRGB* input_buffer2;      // Second input buffer (for blend operations)
    uint32_t width;           // Buffer width in pixels
    uint32_t height;          // Buffer height in pixels
    uint32_t timestamp_ms;    // Current timestamp in milliseconds
    uint32_t delta_time_ms;   // Time since last call in milliseconds
    bool is_starting;         // True if pattern is being initialized
    bool is_ending;           // True if pattern is being cleaned up
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

// Operator function declarations
extern "C" {
    void rainbow_pattern(PatternContext* ctx);
    void gradient_pattern(PatternContext* ctx);
    void perlin_noise_pattern(PatternContext* ctx);
    void moving_blob_pattern(PatternContext* ctx);
    void strobe_pattern(PatternContext* ctx);
    void sparkle_pattern(PatternContext* ctx);
}

// Operator parameter array declarations
extern const PatternParameter rainbow_params[];
extern const PatternParameter gradient_params[];
extern const PatternParameter moving_blob_params[];
extern const PatternParameter sparkle_params[];
extern const PatternParameter strobe_params[];
extern const PatternParameter perlin_noise_params[];

// Pattern registry (defined in pattern_registry.cpp)
extern const PatternDefinition PATTERN_DEFINITIONS[];
extern const uint32_t PATTERN_COUNT;

// Utility functions for 2D buffer access
inline void set_pixel(PatternContext* ctx, uint32_t x, uint32_t y, CRGB color) {
    if (x < ctx->width && y < ctx->height) {
        ctx->color_buffer[y * ctx->width + x] = color;
    }
}

inline CRGB get_pixel(PatternContext* ctx, uint32_t x, uint32_t y) {
    if (x < ctx->width && y < ctx->height) {
        return ctx->color_buffer[y * ctx->width + x];
    }
    return CRGB(0, 0, 0);
}

inline CRGB get_input1_pixel(PatternContext* ctx, uint32_t x, uint32_t y) {
    if (ctx->input_buffer1 && x < ctx->width && y < ctx->height) {
        return ctx->input_buffer1[y * ctx->width + x];
    }
    return CRGB(0, 0, 0);
}

inline CRGB get_input2_pixel(PatternContext* ctx, uint32_t x, uint32_t y) {
    if (ctx->input_buffer2 && x < ctx->width && y < ctx->height) {
        return ctx->input_buffer2[y * ctx->width + x];
    }
    return CRGB(0, 0, 0);
}

// Utility function to get normalized coordinates (0.0 to 1.0)
inline float get_normalized_x(PatternContext* ctx, uint32_t x) {
    return (float)x / (float)(ctx->width - 1);
}

inline float get_normalized_y(PatternContext* ctx, uint32_t y) {
    return (float)y / (float)(ctx->height - 1);
}

// Clear the entire buffer
inline void clear_buffer(PatternContext* ctx, CRGB color = CRGB(0, 0, 0)) {
    uint32_t total_pixels = ctx->width * ctx->height;
    for (uint32_t i = 0; i < total_pixels; i++) {
        ctx->color_buffer[i] = color;
    }
}

#endif // FASTLED_PATTERNS_H 