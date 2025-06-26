#include "../fastled_operators.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Rainbow operator parameters
const OperatorParameter rainbow_params[] = {
    {"speed", "Speed", "float", 120.0f, 10.0f, 500.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0}
};

// No static variables needed for this operator

void rainbow_operator(OperatorContext* ctx) {
    // Simple test: create a fixed rainbow pattern
    // Loop through all pixels in the 2D buffer
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            // Create a simple horizontal rainbow
            uint8_t hue = (uint8_t)((float)x / (float)ctx->width * 255.0f);
            
            // Create HSV color with full saturation and brightness
            CHSV hsv_color(hue, 255, 255);
            CRGB rgb_color = hsv_color;
            
            // Set the pixel
            set_pixel(ctx, x, y, rgb_color);
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 