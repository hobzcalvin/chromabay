#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Rainbow operator - creates colorful rainbow patterns
class RainbowOperator : public BaseOperator {
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
        float angle = getFloat(parameters, 2, 0.0f);
        
        // Convert angle to radians
        float angle_rad = angle * M_PI / 180.0f;
        float cos_angle = cos(angle_rad);
        float sin_angle = sin(angle_rad);
        
        // Get time-based hue offset with speed scaling
        uint8_t hue_offset = (uint8_t)((timestampMs * speed / 1000.0f)) & 0xFF;
        
        // Loop through all pixels in the 2D buffer
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                
                // Get normalized coordinates (0.0 to 1.0)
                float norm_x = (float)x / (float)width;
                float norm_y = (float)y / (float)height;
                
                // Center the coordinates around 0.5
                float centered_x = norm_x - 0.5f;
                float centered_y = norm_y - 0.5f;
                
                // Apply rotation
                float rotated_x = centered_x * cos_angle - centered_y * sin_angle;
                
                // Use the rotated X coordinate to determine hue
                // Scale from -0.5 to 0.5 to 0 to 255
                uint8_t base_hue = (uint8_t)((rotated_x + 0.5f) * 255.0f);
                uint8_t final_hue = base_hue + hue_offset;
                
                // Create HSV color and convert to RGB
                CHSV hsv_color(final_hue, (uint8_t)saturation, 255);
                outputBuffer[index] = hsv_color;
            }
        }
    }
    
    const char* getName() const override {
        return "rainbow";
    }

    const char* getDisplayName() const override {
        return "Rainbow";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 120.0f, 10.0f, 500.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("angle", "Angle", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(RainbowOperator); 