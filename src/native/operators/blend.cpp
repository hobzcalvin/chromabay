#include "../fastled_operators.h"
#include <cmath>

// Blend mode options
const char* blend_mode_options[] = {
    "normal", "add", "multiply", "screen", "overlay", "difference"
};

// Blend operator parameters
const OperatorParameter blend_params[] = {
    {"opacity", "Opacity", "float", 0.5f, 0.0f, 1.0f, nullptr, 0},
    {"blend_mode", "Blend Mode", "select", 0.0f, 0.0f, 5.0f, blend_mode_options, 6},
    {"dual_input", "Dual Input", "float", 1.0f, 0.0f, 1.0f, nullptr, 0} // Special flag for dual input - hidden from UI
};

// Helper function to clamp values to 0-255 range
inline uint8_t clamp255(float value) {
    if (value < 0.0f) return 0;
    if (value > 255.0f) return 255;
    return (uint8_t)value;
}

// Helper function to blend two color channels based on blend mode
CRGB blend_colors(CRGB color1, CRGB color2, float opacity, int blendMode) {
    float r1 = color1.r;
    float g1 = color1.g;
    float b1 = color1.b;
    
    float r2 = color2.r;
    float g2 = color2.g;
    float b2 = color2.b;
    
    float r, g, b;
    
    switch (blendMode) {
        case 1: // Add
            r = r1 + r2 * opacity;
            g = g1 + g2 * opacity;
            b = b1 + b2 * opacity;
            break;
            
        case 2: // Multiply
            r = r1 * (1.0f - opacity) + (r1 * r2 / 255.0f) * opacity;
            g = g1 * (1.0f - opacity) + (g1 * g2 / 255.0f) * opacity;
            b = b1 * (1.0f - opacity) + (b1 * b2 / 255.0f) * opacity;
            break;
            
        case 3: // Screen
            r = r1 * (1.0f - opacity) + (255.0f - (255.0f - r1) * (255.0f - r2) / 255.0f) * opacity;
            g = g1 * (1.0f - opacity) + (255.0f - (255.0f - g1) * (255.0f - g2) / 255.0f) * opacity;
            b = b1 * (1.0f - opacity) + (255.0f - (255.0f - b1) * (255.0f - b2) / 255.0f) * opacity;
            break;
            
        case 4: // Overlay
            {
                float overlayR = r1 < 128.0f ? 2.0f * r1 * r2 / 255.0f : 255.0f - 2.0f * (255.0f - r1) * (255.0f - r2) / 255.0f;
                float overlayG = g1 < 128.0f ? 2.0f * g1 * g2 / 255.0f : 255.0f - 2.0f * (255.0f - g1) * (255.0f - g2) / 255.0f;
                float overlayB = b1 < 128.0f ? 2.0f * b1 * b2 / 255.0f : 255.0f - 2.0f * (255.0f - b1) * (255.0f - b2) / 255.0f;
                r = r1 * (1.0f - opacity) + overlayR * opacity;
                g = g1 * (1.0f - opacity) + overlayG * opacity;
                b = b1 * (1.0f - opacity) + overlayB * opacity;
            }
            break;
            
        case 5: // Difference
            r = r1 * (1.0f - opacity) + fabs(r1 - r2) * opacity;
            g = g1 * (1.0f - opacity) + fabs(g1 - g2) * opacity;
            b = b1 * (1.0f - opacity) + fabs(b1 - b2) * opacity;
            break;
            
        default: // Normal (0)
            r = r1 * (1.0f - opacity) + r2 * opacity;
            g = g1 * (1.0f - opacity) + g2 * opacity;
            b = b1 * (1.0f - opacity) + b2 * opacity;
            break;
    }
    
    return CRGB(clamp255(r), clamp255(g), clamp255(b));
}

void blend_operator(OperatorContext* ctx) {
    // Get parameters
    float opacity = ctx->param_count > 0 ? ctx->parameters[0] : 0.5f;
    float blend_mode_f = ctx->param_count > 1 ? ctx->parameters[1] : 0.0f;
    int blend_mode = (int)blend_mode_f;
    
    // Ensure we have both input buffers
    if (!ctx->input_buffer1 || !ctx->input_buffer2) {
        // If we don't have both inputs, just copy the first input or clear
        if (ctx->input_buffer1) {
            // Copy input1 to output
            for (uint32_t i = 0; i < ctx->width * ctx->height; i++) {
                ctx->color_buffer[i] = ctx->input_buffer1[i];
            }
        } else {
            // Clear to black
            clear_buffer(ctx, CRGB(0, 0, 0));
        }
        return;
    }
    
    // Blend the two input buffers
    for (uint32_t y = 0; y < ctx->height; y++) {
        for (uint32_t x = 0; x < ctx->width; x++) {
            uint32_t index = y * ctx->width + x;
            
            CRGB color1 = ctx->input_buffer1[index];
            CRGB color2 = ctx->input_buffer2[index];
            
            CRGB blended = blend_colors(color1, color2, opacity, blend_mode);
            ctx->color_buffer[index] = blended;
        }
    }
}

// Note: Operator definition is auto-generated in operator_registry.cpp 