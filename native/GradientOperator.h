#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Gradient operator - creates color gradients at different angles
class GradientOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float angle = getFloat(parameters, 0, 0.0f);
        float start_hue = getFloat(parameters, 1, 0.0f);
        float end_hue = getFloat(parameters, 2, 96.0f);   // green (FastLED hue), not red->red
        float start_sat = getFloat(parameters, 3, 255.0f);
        float end_sat = getFloat(parameters, 4, 200.0f);  // a little less saturated at the end
        float start_val = getFloat(parameters, 5, 255.0f);
        float end_val = getFloat(parameters, 6, 255.0f);
        
        // Convert angle to radians
        float angle_rad = angle * M_PI / 180.0f;
        float cos_angle = cos(angle_rad);
        float sin_angle = sin(angle_rad);
        
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
                
                // Map rotated X to gradient position (0.0 to 1.0)
                float gradient_pos = rotated_x + 0.5f;
                gradient_pos = fmax(0.0f, fmin(1.0f, gradient_pos)); // Clamp to [0,1]
                
                // Interpolate hue, saturation and value across the gradient.
                float hue = start_hue + (end_hue - start_hue) * gradient_pos;
                float sat = start_sat + (end_sat - start_sat) * gradient_pos;
                float val = start_val + (end_val - start_val) * gradient_pos;

                // Wrap hue to [0, 255] range
                while (hue < 0.0f) hue += 255.0f;
                while (hue > 255.0f) hue -= 255.0f;

                // Create HSV color and convert to RGB
                CHSV hsv_color((uint8_t)hue, (uint8_t)sat, (uint8_t)val);
                outputBuffer[index] = hsv_color;
            }
        }
    }
    
    const char* getName() const override {
        return "gradient";
    }

    const char* getDisplayName() const override {
        return "Gradient";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("angle", "Angle", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("start_hue", "Start Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("end_hue", "End Hue", ParameterInfo::FLOAT, 96.0f, 0.0f, 255.0f),
            ParameterInfo("start_sat", "Start Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("end_sat", "End Saturation", ParameterInfo::FLOAT, 200.0f, 0.0f, 255.0f),
            ParameterInfo("start_val", "Start Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("end_val", "End Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(GradientOperator); 