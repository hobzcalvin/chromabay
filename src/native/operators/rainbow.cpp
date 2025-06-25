#include "../fastled_operators.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Rainbow operator parameters
const OperatorParameter rainbow_params[] = {
    {"speed", "Speed", "float", 0.1f, 0.0f, 1.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 1.0f, 0.0f, 1.0f, nullptr, 0},
    {"value", "Value", "float", 1.0f, 0.0f, 1.0f, nullptr, 0},
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0}
};

// Static variables for operator state
static bool rainbow_initialized = false;
static uint32_t rainbow_start_time = 0;

void rainbow_operator(OperatorContext* ctx) {
    // Get parameters
    float speed = ctx->param_count > 0 ? ctx->parameters[0] : 50.0f;
    float saturation = ctx->param_count > 1 ? ctx->parameters[1] : 255.0f;
    float value = ctx->param_count > 2 ? ctx->parameters[2] : 255.0f;
    float angle = ctx->param_count > 3 ? ctx->parameters[3] : 0.0f;
    
    // Convert angle to radians
    float angle_rad = angle * M_PI / 180.0f;
    float cos_angle = cos(angle_rad);
    float sin_angle = sin(angle_rad);
    
    // Get time-based hue offset
    uint8_t hue_offset = beat8(speed);
    
    // Loop through all pixels in the 2D buffer
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            // Get normalized coordinates (0.0 to 1.0)
            float norm_x = get_normalized_x(ctx, x);
            float norm_y = get_normalized_y(ctx, y);
            
            // Center the coordinates around 0.5
            float centered_x = norm_x - 0.5f;
            float centered_y = norm_y - 0.5f;
            
            // Apply rotation
            float rotated_x = centered_x * cos_angle - centered_y * sin_angle;
            // float rotated_y = centered_x * sin_angle + centered_y * cos_angle; // Unused for this operator
            
            // Use the rotated X coordinate to determine hue
            // Scale from -0.5 to 0.5 to 0 to 255
            uint8_t base_hue = (uint8_t)((rotated_x + 0.5f) * 255.0f);
            uint8_t final_hue = base_hue + hue_offset;
            
            // Create HSV color and convert to RGB
            CHSV hsv_color(final_hue, (uint8_t)saturation, (uint8_t)value);
            CRGB rgb_color = hsv_color;
            
            // Set the pixel
            set_pixel(ctx, x, y, rgb_color);
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 