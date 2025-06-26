#include "../fastled_operators.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Fade operator parameters
const OperatorParameter fade_params[] = {
    {"speed", "Speed", "float", 1.0f, 0.1f, 10.0f, nullptr, 0},
    {"hue", "Hue", "float", 30.0f, 0.0f, 255.0f, nullptr, 0}, // Default to orange-ish
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

void fade_operator(OperatorContext* ctx) {
    // Get parameters
    float speed = ctx->param_count > 0 ? ctx->parameters[0] : 1.0f;
    float hue = ctx->param_count > 1 ? ctx->parameters[1] : 30.0f;
    float saturation = ctx->param_count > 2 ? ctx->parameters[2] : 255.0f;
    float value = ctx->param_count > 3 ? ctx->parameters[3] : 255.0f;
    
    // Calculate fade intensity using sine wave
    float timeInSeconds = ctx->timestamp_ms * 0.001f;
    float fadeIntensity = (sin(timeInSeconds * speed) + 1.0f) * 0.5f; // 0.0 to 1.0
    
    if (ctx->input_buffer1) {
        // Apply fade effect to input buffer
        for (uint32_t i = 0; i < ctx->width * ctx->height; i++) {
            CRGB input_color = ctx->input_buffer1[i];
            // Scale the input color by the fade intensity
            ctx->color_buffer[i] = CRGB(
                (uint8_t)(input_color.r * fadeIntensity),
                (uint8_t)(input_color.g * fadeIntensity),
                (uint8_t)(input_color.b * fadeIntensity)
            );
        }
    } else {
        // Apply fade to solid color
        uint8_t actualValue = (uint8_t)(value * fadeIntensity);
        CHSV fade_hsv((uint8_t)hue, (uint8_t)saturation, actualValue);
        CRGB fade_color = fade_hsv;
        
        // Fill entire buffer with faded color
        for (uint32_t y = 0; y < ctx->height; y++) {
            for (uint32_t x = 0; x < ctx->width; x++) {
                set_pixel(ctx, x, y, fade_color);
            }
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 