#include "../fastled_patterns.h"

// Moving Blob operator parameter definitions
const PatternParameter moving_blob_params[] = {
    {"speed", "Speed", "float", 30.0f, 0.0f, 100.0f, nullptr, 0},
    {"blob_size", "Blob Size", "float", 0.3f, 0.1f, 1.0f, nullptr, 0},
    {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

void moving_blob_pattern(PatternContext* ctx) {
    // Get parameters
    float speed = ctx->param_count > 0 ? ctx->parameters[0] : 30.0f;
    float blob_size = ctx->param_count > 1 ? ctx->parameters[1] : 0.3f;
    float hue = ctx->param_count > 2 ? ctx->parameters[2] : 0.0f;
    float saturation = ctx->param_count > 3 ? ctx->parameters[3] : 255.0f;
    float value = ctx->param_count > 4 ? ctx->parameters[4] : 255.0f;
    
    // Clear the buffer
    clear_buffer(ctx, CRGB(0, 0, 0));
    
    // Calculate blob positions based on time
    float time_scale = speed / 60.0f; // Convert to reasonable time scale
    float time_offset = beat16(speed) / 65535.0f * 2.0f * M_PI;
    
    // Create multiple blobs
    const int num_blobs = 3;
    for (int blob = 0; blob < num_blobs; blob++) {
        // Each blob follows a different circular path
        float blob_angle = time_offset + (blob * 2.0f * M_PI / num_blobs);
        float blob_radius = 0.3f + 0.2f * sin(time_offset * 0.5f + blob);
        
        // Calculate blob center
        float blob_x = 0.5f + blob_radius * cos(blob_angle);
        float blob_y = 0.5f + blob_radius * sin(blob_angle);
        
        // Each blob has a different hue
        float blob_hue = hue + (blob * 85.0f); // 85 = 255/3 for evenly spaced hues
        while (blob_hue > 255.0f) blob_hue -= 255.0f;
        
        // Loop through all pixels
        for (uint32_t y = 0; y < ctx->height; y++) {
            for (uint32_t x = 0; x < ctx->width; x++) {
                // Get normalized coordinates
                float norm_x = get_normalized_x(ctx, x);
                float norm_y = get_normalized_y(ctx, y);
                
                // Calculate distance from blob center
                float dx = norm_x - blob_x;
                float dy = norm_y - blob_y;
                float distance = sqrt(dx * dx + dy * dy);
                
                // Calculate intensity based on distance (soft falloff)
                float intensity = 1.0f - (distance / blob_size);
                intensity = fmax(0.0f, intensity);
                intensity = intensity * intensity; // Quadratic falloff for smoother edges
                
                if (intensity > 0.0f) {
                    // Get existing pixel color
                    CRGB existing_color = get_pixel(ctx, x, y);
                    
                    // Create new blob color
                    CHSV blob_hsv((uint8_t)blob_hue, (uint8_t)saturation, (uint8_t)(value * intensity));
                    CRGB blob_color = blob_hsv;
                    
                    // Blend with existing color (additive)
                    uint16_t new_r = existing_color.r + blob_color.r;
                    uint16_t new_g = existing_color.g + blob_color.g;
                    uint16_t new_b = existing_color.b + blob_color.b;
                    
                    // Clamp to 255
                    CRGB final_color(
                        (uint8_t)fmin(255, new_r),
                        (uint8_t)fmin(255, new_g),
                        (uint8_t)fmin(255, new_b)
                    );
                    
                    set_pixel(ctx, x, y, final_color);
                }
            }
        }
    }
} 