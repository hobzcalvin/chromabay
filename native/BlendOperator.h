#pragma once

#include "BaseOperator.h"
#include <cmath>

// Blend operator - blends two input buffers using various blend modes
class BlendOperator : public BaseOperator {
private:
    // Helper function to clamp values to 0-255 range
    inline uint8_t clamp255(float value) const {
        if (value < 0.0f) return 0;
        if (value > 255.0f) return 255;
        return (uint8_t)value;
    }

    // Helper function to blend two color channels based on blend mode
    CRGB blend_colors(CRGB color1, CRGB color2, float opacity, int blendMode) const {
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

public:
    void render(
        CRGB* inputBuffer1,
        CRGB* inputBuffer2,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float opacity = getFloat(parameters, 0, 0.5f);
        int blend_mode = getInt(parameters, 1, 0);
        
        uint32_t totalPixels = width * height;
        
        // Ensure we have both input buffers
        if (!inputBuffer1 || !inputBuffer2) {
            // If we don't have both inputs, just copy the first input or clear
            if (inputBuffer1) {
                // Copy input1 to output
                for (uint32_t i = 0; i < totalPixels; i++) {
                    outputBuffer[i] = inputBuffer1[i];
                }
            } else {
                // Clear to black
                for (uint32_t i = 0; i < totalPixels; i++) {
                    outputBuffer[i] = CRGB::Black;
                }
            }
            return;
        }
        
        // Blend the two input buffers
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                
                CRGB color1 = inputBuffer1[index];
                CRGB color2 = inputBuffer2[index];
                
                CRGB blended = blend_colors(color1, color2, opacity, blend_mode);
                outputBuffer[index] = blended;
            }
        }
    }
    
    const char* getDisplayName() const override {
        return "Blend";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("opacity", "Opacity", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("blend_mode", "Blend Mode", ParameterInfo::INT, 0, 0, 5)
        };
    }
};

REGISTER_OPERATOR(BlendOperator); 