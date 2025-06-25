#include "../fastled_operators.h"

// Gradient operator parameter definitions
const OperatorParameter gradient_params[] = {
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0},
    {"start_hue", "Start Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"end_hue", "End Hue", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

void gradient_operator(OperatorContext* ctx) {
    // Get parameters
    float angle = ctx->param_count > 0 ? ctx->parameters[0] : 0.0f;
    float start_hue = ctx->param_count > 1 ? ctx->parameters[1] : 0.0f;
    float end_hue = ctx->param_count > 2 ? ctx->parameters[2] : 255.0f;
    float saturation = ctx->param_count > 3 ? ctx->parameters[3] : 255.0f;
    float value = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    
    // Convert angle to radians
    float angle_rad = angle * M_PI / 180.0f;
    float cos_angle = cos(angle_rad);
    float sin_angle = sin(angle_rad);
    
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
            
            // Map rotated X to gradient position (0.0 to 1.0)
            float gradient_pos = rotated_x + 0.5f;
            gradient_pos = fmax(0.0f, fmin(1.0f, gradient_pos)); // Clamp to [0,1]
            
            // Interpolate hue
            float hue = start_hue + (end_hue - start_hue) * gradient_pos;
            
            // Wrap hue to [0, 255] range
            while (hue < 0.0f) hue += 255.0f;
            while (hue > 255.0f) hue -= 255.0f;
            
            // Create HSV color and convert to RGB
            CHSV hsv_color((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
            CRGB rgb_color = hsv_color;
            
            // Set the pixel
            set_pixel(ctx, x, y, rgb_color);
        }
    }
} 