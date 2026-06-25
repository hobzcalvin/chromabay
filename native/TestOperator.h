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
        // Pixel coordinates (not fractions): easy to reason about for a test pattern.
        int start_x = getInt(parameters, 0, 2);
        int start_y = getInt(parameters, 1, 4);
        int pixel_width = std::max(1, getInt(parameters, 2, 3));
        int pixel_height = std::max(1, getInt(parameters, 3, 5));

        uint32_t totalPixels = width * height;

        // Clear buffer first (everything black)
        for (uint32_t i = 0; i < totalPixels; i++) {
            outputBuffer[i] = CRGB::Black;
        }

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
            ParameterInfo("x", "X (px)", ParameterInfo::INT, 2, 0, 500),
            ParameterInfo("y", "Y (px)", ParameterInfo::INT, 4, 0, 500),
            ParameterInfo("width", "Width (px)", ParameterInfo::INT, 3, 1, 500),
            ParameterInfo("height", "Height (px)", ParameterInfo::INT, 5, 1, 500)
        };
    }
};

REGISTER_OPERATOR(TestOperator); 