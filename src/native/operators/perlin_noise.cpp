#include "../fastled_operators.h"

// Perlin Noise operator parameter definitions
const OperatorParameter perlin_noise_params[] = {
    {"scale", "Scale", "float", 4.0f, 1.0f, 20.0f, nullptr, 0},
    {"speed", "Speed", "float", 50.0f, 0.0f, 200.0f, nullptr, 0},
    {"hue_base", "Base Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"hue_range", "Hue Range", "float", 60.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

// No custom noise function needed - using FastLED's inoise8()

void perlin_noise_operator(OperatorContext* ctx) {
    // Get parameters
    float scale = ctx->param_count > 0 ? ctx->parameters[0] : 4.0f; // Noise scale
    float speed = ctx->param_count > 1 ? ctx->parameters[1] : 50.0f; // Animation speed
    float hue_base = ctx->param_count > 2 ? ctx->parameters[2] : 0.0f; // Base hue
    float hue_range = ctx->param_count > 3 ? ctx->parameters[3] : 60.0f; // Hue variation range
    float saturation = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    float value = ctx->param_count > 5 ? ctx->parameters[5] : 255.0f;
    
    // Time factor for animation (scale for FastLED noise)
    uint16_t time_factor = (uint16_t)(ctx->timestamp_ms * speed * 0.01f);
    
    // Scale factor for noise coordinates
    uint16_t noise_scale = (uint16_t)(scale * 1000.0f);
    
    // Loop through all pixels
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            // Get normalized coordinates and scale them for FastLED noise
            uint16_t noise_x = (uint16_t)(get_normalized_x(ctx, x) * noise_scale);
            uint16_t noise_y = (uint16_t)(get_normalized_y(ctx, y) * noise_scale);
            
            // Generate noise value using FastLED's inoise8
            uint8_t noise_val = inoise8(noise_x, noise_y, time_factor);
            
            // Map noise to hue
            float hue = hue_base + ((float)noise_val / 255.0f * hue_range);
            while (hue > 255.0f) hue -= 255.0f;
            while (hue < 0.0f) hue += 255.0f;
            
            // Generate second noise layer for brightness variation
            uint8_t brightness_noise = inoise8(noise_x / 2, noise_y / 2, time_factor / 2);
            float brightness = value * (0.3f + 0.7f * (float)brightness_noise / 255.0f);
            
            // Create HSV color
            CHSV hsv_color((uint8_t)hue, (uint8_t)saturation, (uint8_t)brightness);
            CRGB rgb_color = hsv_color;
            
            set_pixel(ctx, x, y, rgb_color);
        }
    }
} 