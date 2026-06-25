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
        
        // Split screen (mode 7): input1 on the left, input2 on the right; `opacity`
        // (labelled "Amount") is the split position as a fraction of the width.
        if (blend_mode == 7) {
            uint32_t splitX = (uint32_t)(opacity * (float)width + 0.5f);
            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    uint32_t index = y * width + x;
                    outputBuffer[index] = (x < splitX) ? inputBuffer1[index] : inputBuffer2[index];
                }
            }
            return;
        }

        // Special handling for Map blend mode (6)
        if (blend_mode == 6) {
            // Map mode: Use first input's brightness for X coord and hue for Y coord to sample second input
            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    uint32_t index = y * width + x;
                    
                    CRGB color1 = inputBuffer1[index];
                    
                    // Convert first input to HSV to get hue and brightness
                    CHSV hsv = rgb2hsv_approximate(color1);
                    float brightness = hsv.v / 255.0f; // 0-1
                    float hue_norm = hsv.h / 255.0f;   // 0-1
                    
                    // Map brightness to X coordinate and hue to Y coordinate
                    uint32_t sample_x = (uint32_t)(brightness * (width - 1));
                    uint32_t sample_y = (uint32_t)(hue_norm * (height - 1));
                    
                    // Clamp to bounds
                    sample_x = (sample_x < width) ? sample_x : width - 1;
                    sample_y = (sample_y < height) ? sample_y : height - 1;
                    
                    // Sample color from second input
                    uint32_t sample_index = sample_y * width + sample_x;
                    CRGB sample_color = inputBuffer2[sample_index];
                    
                    // Apply opacity blending with the original pixel
                    CRGB blended = blend_colors(color1, sample_color, opacity, 0); // Use normal blend
                    outputBuffer[index] = blended;
                }
            }
        } else {
            // Normal blend modes
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
    }
    
    const char* getName() const override {
        return "blend";
    }

    const char* getDisplayName() const override {
        return "Blend";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        // "amount" doubles as opacity for the blend modes and as the split position for
        // Split mode. blend_mode is a SELECT so the UI shows mode names, not numbers.
        return {
            ParameterInfo("opacity", "Amount", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("blend_mode", "Mode", ParameterInfo::SELECT, std::string("Normal"),
                std::vector<std::string>{ "Normal", "Add", "Multiply", "Screen",
                                          "Overlay", "Difference", "Map", "Split" })
        };
    }
};

REGISTER_OPERATOR(BlendOperator); 