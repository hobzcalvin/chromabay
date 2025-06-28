#pragma once

#include "BaseOperator.h"

// Sparkle operator - creates random sparkles with fading
class SparkleOperator : public BaseOperator {
private:
    // Simple pseudo-random number generator state  
    mutable uint32_t seed = 12345;
    
    uint32_t random() const {
        seed = seed * 1103515245 + 12345;
        return seed;
    }
    
public:
    void render(
        CRGB* inputBuffer1,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float density = getFloat(parameters, 0, 0.1f);
        float fade_rate = getFloat(parameters, 1, 0.95f);
        float hue = getFloat(parameters, 2, 255.0f);  // 255 = random
        float saturation = getFloat(parameters, 3, 255.0f);
        float value = getFloat(parameters, 4, 255.0f);
        
        // Seed with timestamp for variation
        seed = timestampMs + 12345;
        
        uint32_t totalPixels = width * height;
        
        // First, copy input buffer and fade existing pixels
        for (uint32_t i = 0; i < totalPixels; i++) {
            CRGB current_color = inputBuffer1 ? inputBuffer1[i] : CRGB::Black;
            
            // Fade the pixel
            outputBuffer[i] = CRGB(
                (uint8_t)(current_color.r * fade_rate),
                (uint8_t)(current_color.g * fade_rate),
                (uint8_t)(current_color.b * fade_rate)
            );
        }
        
        // Add new sparkles
        uint32_t sparkles_to_add = (uint32_t)(totalPixels * density);
        sparkles_to_add = (sparkles_to_add > totalPixels / 4) ? totalPixels / 4 : sparkles_to_add;
        
        for (uint32_t i = 0; i < sparkles_to_add; i++) {
            // Random position
            uint32_t x = random() % width;
            uint32_t y = random() % height;
            uint32_t index = y * width + x;
            
            // Determine sparkle hue
            float sparkle_hue;
            if (hue >= 255.0f) {
                // Random hue
                sparkle_hue = (random() % 256);
            } else {
                // Use specified hue with some variation
                float hue_variation = (random() % 41) - 20; // ±20 hue units
                sparkle_hue = hue + hue_variation;
                if (sparkle_hue < 0.0f) sparkle_hue = 0.0f;
                if (sparkle_hue > 255.0f) sparkle_hue = 255.0f;
            }
            
            // Create sparkle with random intensity
            float intensity = 0.5f + (random() % 128) / 255.0f; // 0.5 to 1.0
            
            CHSV sparkle_hsv(
                (uint8_t)sparkle_hue,
                (uint8_t)saturation,
                (uint8_t)(value * intensity)
            );
            
            outputBuffer[index] = sparkle_hsv;
        }
    }
    
    const char* getDisplayName() const override {
        return "Sparkle";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("density", "Density", ParameterInfo::FLOAT, 0.1f, 0.0f, 1.0f),
            ParameterInfo("fade_rate", "Fade Rate", ParameterInfo::FLOAT, 0.95f, 0.5f, 0.99f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(SparkleOperator); 