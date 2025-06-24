#include "../fastled_patterns.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Rainbow pattern parameters
static const PatternParameter rainbow_params[] = {
    {"speed", "Speed", "float", 0.1f, 0.0f, 1.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 1.0f, 0.0f, 1.0f, nullptr, 0},
    {"value", "Value", "float", 1.0f, 0.0f, 1.0f, nullptr, 0},
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0}
};

// Static variables for pattern state
static bool rainbow_initialized = false;
static uint32_t rainbow_start_time = 0;

void rainbow_pattern(PatternContext* ctx) {
    // Initialize if needed
    if (ctx->is_starting || !rainbow_initialized) {
        rainbow_start_time = ctx->timestamp_ms;
        rainbow_initialized = true;
    }
    
    // Cleanup if needed
    if (ctx->is_ending) {
        rainbow_initialized = false;
        return;
    }
    
    // Extract parameters
    float speed = (ctx->param_count > 0) ? ctx->parameters[0] : 0.1f;
    float saturation = (ctx->param_count > 1) ? ctx->parameters[1] : 1.0f;
    float value = (ctx->param_count > 2) ? ctx->parameters[2] : 1.0f;
    float angle = (ctx->param_count > 3) ? ctx->parameters[3] : 0.0f;
    
    // Scale parameters to FastLED ranges
    speed *= 3.0f; // Scale for reasonable animation speed
    uint8_t sat_8bit = (uint8_t)(saturation * 255);
    uint8_t val_8bit = (uint8_t)(value * 255);
    
    // Convert angle to radians
    float angle_rad = angle * M_PI / 180.0f;
    float cos_angle = cosf(angle_rad);
    float sin_angle = sinf(angle_rad);
    
    // Time-based hue offset using FastLED's beat functions
    // Use elapsed time since start for consistent timing
    uint32_t elapsed_time = ctx->timestamp_ms - rainbow_start_time;
    uint8_t time_offset = beat8((uint16_t)(speed * 60), elapsed_time);
    
    // Process each point
    for (uint32_t i = 0; i < ctx->point_count; i++) {
        float x = ctx->points[i].x;
        float y = ctx->points[i].y;
        
        // Apply rotation to coordinates
        float rotated_x = x * cos_angle - y * sin_angle;
        
        // Calculate hue based on rotated position and time
        uint8_t hue = time_offset + (uint8_t)(rotated_x * 255);
        
        // Convert HSV to RGB using FastLED
        CHSV hsv_color(hue, sat_8bit, val_8bit);
        CRGB color = hsv_color; // FastLED automatic conversion
        
        // Set pixel in buffer
        set_point_color(ctx, i, color);
    }
}

// Export pattern definition
extern "C" const PatternDefinition RAINBOW_PATTERN = {
    "Rainbow (Native)",
    "native_rainbow",
    rainbow_params,
    sizeof(rainbow_params) / sizeof(PatternParameter),
    rainbow_pattern
}; 