#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Radial Rainbow operator - creates concentric rainbow rings from a center point
class RadialRainbowOperator : public BaseOperator {
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
        float speed = getFloat(parameters, 0, 120.0f);
        float saturation = getFloat(parameters, 1, 255.0f);
        float center_x = getFloat(parameters, 2, 0.5f);
        float center_y = getFloat(parameters, 3, 0.5f);
        float frequency = getFloat(parameters, 4, 1.0f);
        
        // Get time-based hue offset with speed scaling
        uint8_t hue_offset = (uint8_t)((timestampMs * speed / 1000.0f)) & 0xFF;
        
        // Calculate the maximum possible distance from center for normalization
        float max_distance = sqrt((center_x * center_x) + (center_y * center_y));
        float max_distance_alt = sqrt(((1.0f - center_x) * (1.0f - center_x)) + ((1.0f - center_y) * (1.0f - center_y)));
        max_distance = fmax(max_distance, max_distance_alt);
        
        // Also consider distances to other corners
        float corner_distances[4] = {
            sqrt((center_x * center_x) + (center_y * center_y)), // (0,0)
            sqrt(((1.0f - center_x) * (1.0f - center_x)) + (center_y * center_y)), // (1,0)
            sqrt((center_x * center_x) + ((1.0f - center_y) * (1.0f - center_y))), // (0,1)
            sqrt(((1.0f - center_x) * (1.0f - center_x)) + ((1.0f - center_y) * (1.0f - center_y))) // (1,1)
        };
        
        max_distance = 0.0f;
        for (int i = 0; i < 4; i++) {
            if (corner_distances[i] > max_distance) {
                max_distance = corner_distances[i];
            }
        }
        
        // Loop through all pixels in the 2D buffer
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                
                // Get normalized coordinates (0.0 to 1.0)
                float norm_x = (float)x / (float)width;
                float norm_y = (float)y / (float)height;
                
                // Calculate distance from center point
                float dx = norm_x - center_x;
                float dy = norm_y - center_y;
                float distance = sqrt(dx * dx + dy * dy);
                
                // Normalize distance to 0-1 range
                float normalized_distance = distance / max_distance;
                
                // Apply frequency scaling to create multiple rings
                float scaled_distance = normalized_distance * frequency;
                
                // Convert distance to hue (0-255)
                // Use fractional part to create repeating rings
                float hue_float = (scaled_distance - floor(scaled_distance)) * 255.0f;
                uint8_t base_hue = (uint8_t)hue_float;
                uint8_t final_hue = base_hue + hue_offset;
                
                // Create HSV color and convert to RGB
                CHSV hsv_color(final_hue, (uint8_t)saturation, 255);
                outputBuffer[index] = hsv_color;
            }
        }
    }
    
    const char* getName() const override {
        return "radial_rainbow";
    }

    const char* getDisplayName() const override {
        return "Radial Rainbow";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 120.0f, 10.0f, 500.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("center_x", "Center X", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("center_y", "Center Y", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("frequency", "Ring Frequency", ParameterInfo::FLOAT, 1.0f, 0.1f, 10.0f)
        };
    }
};

REGISTER_OPERATOR(RadialRainbowOperator);
