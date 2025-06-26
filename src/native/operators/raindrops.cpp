#include "../fastled_operators.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Raindrops operator parameters
const OperatorParameter raindrops_params[] = {
    {"speed", "Speed", "float", 50.0f, 10.0f, 200.0f, nullptr, 0},
    {"count", "Count", "float", 8.0f, 2.0f, 32.0f, nullptr, 0},
    {"size", "Size", "float", 0.025f, 0.01f, 0.1f, nullptr, 0},
    {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 0.0f, 0.0f, 255.0f, nullptr, 0}, // 0 = white
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

void raindrops_operator(OperatorContext* ctx) {
    // Get parameters
    float speed = ctx->param_count > 0 ? ctx->parameters[0] : 50.0f;
    float count = ctx->param_count > 1 ? ctx->parameters[1] : 8.0f;
    float size = ctx->param_count > 2 ? ctx->parameters[2] : 0.025f;
    float hue = ctx->param_count > 3 ? ctx->parameters[3] : 0.0f;
    float saturation = ctx->param_count > 4 ? ctx->parameters[4] : 0.0f; // 0 = white
    float value = ctx->param_count > 5 ? ctx->parameters[5] : 255.0f;
    
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
    
    // Calculate drop count based on width
    int dropCount = (int)count;
    if (dropCount < 1) dropCount = 1;
    
    // Create raindrops
    for (int i = 0; i < dropCount; i++) {
        // Calculate drop position
        float dropSpacing = (float)ctx->width / (float)dropCount;
        float baseX = i * dropSpacing + dropSpacing * 0.5f;
        
        // Animate Y position based on time and speed
        float timeOffset = ctx->timestamp_ms * speed * 0.001f; // Convert to seconds and scale
        float y = fmod(timeOffset + i * 10.0f, (float)(ctx->height + 10)) - 10.0f;
        
        // Only draw if raindrop is visible
        if (y >= 0.0f && y <= (float)ctx->height) {
            // Calculate drop dimensions
            float dropWidth = ctx->width * size;
            float dropHeight = ctx->height * 0.08f; // Fixed aspect ratio
            
            // Create raindrop color
            CHSV drop_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
            CRGB drop_color = drop_hsv;
            
            // Draw elliptical raindrop
            int centerX = (int)baseX;
            int centerY = (int)y;
            int radiusX = (int)(dropWidth * 0.5f);
            int radiusY = (int)(dropHeight * 0.5f);
            
            // Draw filled ellipse
            for (int dy = -radiusY; dy <= radiusY; dy++) {
                for (int dx = -radiusX; dx <= radiusX; dx++) {
                    // Check if point is inside ellipse
                    float ellipseTest = ((float)(dx * dx) / (float)(radiusX * radiusX)) + 
                                       ((float)(dy * dy) / (float)(radiusY * radiusY));
                    
                    if (ellipseTest <= 1.0f) {
                        int pixelX = centerX + dx;
                        int pixelY = centerY + dy;
                        
                        // Bounds check
                        if (pixelX >= 0 && pixelX < (int)ctx->width && 
                            pixelY >= 0 && pixelY < (int)ctx->height) {
                            set_pixel(ctx, pixelX, pixelY, drop_color);
                        }
                    }
                }
            }
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 