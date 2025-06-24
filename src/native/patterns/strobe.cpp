#include "../fastled_patterns.h"

void strobe_pattern(PatternContext* ctx) {
    // Get parameters
    float rate = ctx->param_count > 0 ? ctx->parameters[0] : 2.0f; // Flashes per second
    float duty_cycle = ctx->param_count > 1 ? ctx->parameters[1] : 0.1f; // 0.0 to 1.0 (fraction of time ON)
    float hue = ctx->param_count > 2 ? ctx->parameters[2] : 0.0f;
    float saturation = ctx->param_count > 3 ? ctx->parameters[3] : 0.0f; // 0 = white strobe
    float value = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    
    // Calculate strobe timing
    float period_ms = 1000.0f / rate; // Period in milliseconds
    float on_time_ms = period_ms * duty_cycle;
    
    // Current position in the cycle
    float cycle_pos = fmod(ctx->timestamp_ms, period_ms);
    
    // Determine if we're in the ON or OFF phase
    bool is_on = cycle_pos < on_time_ms;
    
    if (is_on) {
        // Fill buffer with strobe color
        CHSV strobe_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
        CRGB strobe_color = strobe_hsv;
        
        for (uint32_t y = 0; y < ctx->height; y++) {
            for (uint32_t x = 0; x < ctx->width; x++) {
                set_pixel(ctx, x, y, strobe_color);
            }
        }
    } else {
        // Clear buffer (OFF phase)
        clear_buffer(ctx, CRGB(0, 0, 0));
    }
} 