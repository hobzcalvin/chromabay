#pragma once

#include "BaseOperator.h"
#include <algorithm>

// Test operator - draws a simple white rectangle for testing purposes
class TestOperator : public BaseOperator {
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
        float x = getFloat(parameters, 0, 0.0f);
        float y = getFloat(parameters, 1, 0.0f);
        float rect_width = getFloat(parameters, 2, 0.0f);
        float rect_height = getFloat(parameters, 3, 0.0f);
        
        uint32_t totalPixels = width * height;
        
        // Clear buffer first (everything black)
        for (uint32_t i = 0; i < totalPixels; i++) {
            outputBuffer[i] = CRGB::Black;
        }
        
        // Map parameters (0-1) to buffer coordinates
        int start_x = (int)(x * width);
        int start_y = (int)(y * height);
        int pixel_width = std::max(1, (int)(rect_width * width));
        int pixel_height = std::max(1, (int)(rect_height * height));
        
        // Clamp to buffer bounds
        start_x = std::max(0, std::min(start_x, (int)width - 1));
        start_y = std::max(0, std::min(start_y, (int)height - 1));
        int end_x = std::min(start_x + pixel_width, (int)width);
        int end_y = std::min(start_y + pixel_height, (int)height);
        
        // Draw white rectangle
        for (int py = start_y; py < end_y; py++) {
            for (int px = start_x; px < end_x; px++) {
                uint32_t index = py * width + px;
                outputBuffer[index] = CRGB(255, 255, 255);
            }
        }
    }
    
    const char* getName() const override {
        return "test";
    }

    const char* getDisplayName() const override {
        return "Test Rectangle";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("x", "X Position", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f),
            ParameterInfo("y", "Y Position", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f),
            ParameterInfo("width", "Width", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f),
            ParameterInfo("height", "Height", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(TestOperator); 