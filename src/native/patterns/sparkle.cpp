#include "../fastled_patterns.h"

// Simple pseudo-random number generator (since we can't use stdlib rand in WASM easily)
static uint32_t sparkle_seed = 12345;

static uint32_t sparkle_random() {
    sparkle_seed = sparkle_seed * 1103515245 + 12345;
    return sparkle_seed;
}

void sparkle_pattern(PatternContext* ctx) {
    // Get parameters
    float density = ctx->param_count > 0 ? ctx->parameters[0] : 0.1f; // 0.0 to 1.0
    float fade_rate = ctx->param_count > 1 ? ctx->parameters[1] : 0.95f; // 0.0 to 1.0
    float hue = ctx->param_count > 2 ? ctx->parameters[2] : 255.0f; // 255 = random hues
    float saturation = ctx->param_count > 3 ? ctx->parameters[3] : 255.0f;
    float value = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    
    // Seed the random generator with timestamp for variation
    sparkle_seed = ctx->timestamp_ms + 12345;
    
    // First, fade all existing pixels
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            CRGB current_color = get_pixel(ctx, x, y);
            
            // Fade the pixel
            CRGB faded_color(
                (uint8_t)(current_color.r * fade_rate),
                (uint8_t)(current_color.g * fade_rate),
                (uint8_t)(current_color.b * fade_rate)
            );
            
            set_pixel(ctx, x, y, faded_color);
        }
    }
    
    // Add new sparkles
    uint32_t total_pixels = ctx->width * ctx->height;
    uint32_t sparkles_to_add = (uint32_t)(total_pixels * density);
    
    for (uint32_t i = 0; i < sparkles_to_add; i++) {
        // Random position
        uint32_t x = sparkle_random() % ctx->width;
        uint32_t y = sparkle_random() % ctx->width; // Use width for both to avoid bias
        y = y % ctx->height; // Then clamp to height
        
        // Only add sparkle if pixel is currently dim
        CRGB current_color = get_pixel(ctx, x, y);
        uint8_t brightness = (current_color.r + current_color.g + current_color.b) / 3;
        
        if (brightness < 50) { // Only sparkle on dim pixels
            // Determine sparkle hue
            float sparkle_hue;
            if (hue >= 255.0f) {
                // Random hue
                sparkle_hue = (sparkle_random() % 256);
            } else {
                // Use specified hue with some variation
                float hue_variation = (sparkle_random() % 41) - 20; // ±20 hue units
                sparkle_hue = hue + hue_variation;
                while (sparkle_hue < 0.0f) sparkle_hue += 255.0f;
                while (sparkle_hue > 255.0f) sparkle_hue -= 255.0f;
            }
            
            // Create sparkle with random intensity
            float intensity = 0.5f + (sparkle_random() % 128) / 255.0f; // 0.5 to 1.0
            
            CHSV sparkle_hsv(
                (uint8_t)sparkle_hue,
                (uint8_t)saturation,
                (uint8_t)(value * intensity)
            );
            CRGB sparkle_color = sparkle_hsv;
            
            set_pixel(ctx, x, y, sparkle_color);
        }
    }
} 