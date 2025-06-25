#include "../fastled_patterns.h"

// Perlin Noise operator parameter definitions
const PatternParameter perlin_noise_params[] = {
    {"scale", "Scale", "float", 4.0f, 1.0f, 20.0f, nullptr, 0},
    {"speed", "Speed", "float", 50.0f, 0.0f, 200.0f, nullptr, 0},
    {"hue_base", "Base Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"hue_range", "Hue Range", "float", 60.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

// Simplified noise function (not true Perlin noise, but similar organic feel)
static float simple_noise(float x, float y, float t) {
    // Simple multi-octave noise using sine functions
    float noise = 0.0f;
    
    // First octave
    noise += 0.5f * sin(x * 2.0f + t * 0.01f) * cos(y * 2.0f + t * 0.01f);
    
    // Second octave
    noise += 0.25f * sin(x * 4.0f + t * 0.02f) * cos(y * 4.0f + t * 0.02f);
    
    // Third octave
    noise += 0.125f * sin(x * 8.0f + t * 0.03f) * cos(y * 8.0f + t * 0.03f);
    
    // Normalize to [0, 1]
    return (noise + 1.0f) * 0.5f;
}

void perlin_noise_pattern(PatternContext* ctx) {
    // Get parameters
    float scale = ctx->param_count > 0 ? ctx->parameters[0] : 4.0f; // Noise scale
    float speed = ctx->param_count > 1 ? ctx->parameters[1] : 50.0f; // Animation speed
    float hue_base = ctx->param_count > 2 ? ctx->parameters[2] : 0.0f; // Base hue
    float hue_range = ctx->param_count > 3 ? ctx->parameters[3] : 60.0f; // Hue variation range
    float saturation = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    float value = ctx->param_count > 5 ? ctx->parameters[5] : 255.0f;
    
    // Time factor for animation
    float time_factor = ctx->timestamp_ms * speed * 0.001f;
    
    // Loop through all pixels
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            // Get normalized coordinates and scale them
            float norm_x = get_normalized_x(ctx, x) * scale;
            float norm_y = get_normalized_y(ctx, y) * scale;
            
            // Generate noise value
            float noise_val = simple_noise(norm_x, norm_y, time_factor);
            
            // Map noise to hue
            float hue = hue_base + (noise_val * hue_range);
            while (hue > 255.0f) hue -= 255.0f;
            while (hue < 0.0f) hue += 255.0f;
            
            // Generate second noise layer for brightness variation
            float brightness_noise = simple_noise(norm_x * 0.5f, norm_y * 0.5f, time_factor * 0.7f);
            float brightness = value * (0.3f + 0.7f * brightness_noise);
            
            // Create HSV color
            CHSV hsv_color((uint8_t)hue, (uint8_t)saturation, (uint8_t)brightness);
            CRGB rgb_color = hsv_color;
            
            set_pixel(ctx, x, y, rgb_color);
        }
    }
} 