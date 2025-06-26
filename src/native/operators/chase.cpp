#include "../fastled_operators.h"
#include <cmath>

// Chase operator parameters
const OperatorParameter chase_params[] = {
    {"speed", "Speed", "float", 20.0f, 5.0f, 100.0f, nullptr, 0},
    {"size", "Size", "float", 4.0f, 1.0f, 20.0f, nullptr, 0},
    {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 0.0f, 0.0f, 255.0f, nullptr, 0}, // 0 = white
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

void chase_operator(OperatorContext* ctx) {
    // Get parameters
    float speed = ctx->param_count > 0 ? ctx->parameters[0] : 20.0f;
    float size = ctx->param_count > 1 ? ctx->parameters[1] : 4.0f;
    float hue = ctx->param_count > 2 ? ctx->parameters[2] : 0.0f;
    float saturation = ctx->param_count > 3 ? ctx->parameters[3] : 0.0f; // 0 = white
    float value = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    
    // Start with input buffer if available, otherwise clear to black
    if (ctx->input_buffer1) {
        // Copy input buffer to output as base
        for (uint32_t i = 0; i < ctx->width * ctx->height; i++) {
            ctx->color_buffer[i] = ctx->input_buffer1[i];
        }
    } else {
        // Clear the buffer if no input
        clear_buffer(ctx, CRGB(0, 0, 0));
    }
    
    // Calculate chase position
    float timeInSeconds = ctx->timestamp_ms * 0.001f;
    float position = fmod(timeInSeconds * speed, (float)ctx->width);
    
    // Create chase color
    CHSV chase_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
    CRGB chase_color = chase_hsv;
    
    // Draw vertical bar at current position
    int startX = (int)position;
    int barWidth = (int)size;
    
    for (int x = startX; x < startX + barWidth && x < (int)ctx->width; x++) {
        if (x >= 0) {
            for (uint32_t y = 0; y < ctx->height; y++) {
                set_pixel(ctx, x, y, chase_color);
            }
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 