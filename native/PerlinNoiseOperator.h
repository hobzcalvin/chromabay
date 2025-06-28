#pragma once

#include "BaseOperator.h"

// Perlin Noise operator - creates 2D noise patterns with multiple layers
class PerlinNoiseOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float scale = getFloat(parameters, 0, 4.0f); // Noise scale
        float speed = getFloat(parameters, 1, 50.0f); // Animation speed
        float hue_base = getFloat(parameters, 2, 0.0f); // Base hue
        float hue_range = getFloat(parameters, 3, 60.0f); // Hue variation range
        float saturation = getFloat(parameters, 4, 255.0f);
        float value = getFloat(parameters, 5, 255.0f);
        
        // Time factor for animation (scale for FastLED noise)
        uint16_t time_factor = (uint16_t)(timestampMs * speed * 0.01f);
        
        // Scale factor for noise coordinates
        uint16_t noise_scale = (uint16_t)(scale * 1000.0f);
        
        // Loop through all pixels
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                
                // Get normalized coordinates and scale them for FastLED noise
                float norm_x = (float)x / (float)width;
                float norm_y = (float)y / (float)height;
                uint16_t noise_x = (uint16_t)(norm_x * noise_scale);
                uint16_t noise_y = (uint16_t)(norm_y * noise_scale);
                
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
                outputBuffer[index] = hsv_color;
            }
        }
    }
    
    const char* getDisplayName() const override {
        return "Perlin Noise";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("scale", "Scale", ParameterInfo::FLOAT, 4.0f, 1.0f, 20.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 50.0f, 0.0f, 200.0f),
            ParameterInfo("hue_base", "Base Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("hue_range", "Hue Range", ParameterInfo::FLOAT, 60.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(PerlinNoiseOperator); 