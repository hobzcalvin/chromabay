#pragma once

#include "BaseOperator.h"
#include <cmath>

// Chase operator - creates moving vertical bars
class ChaseOperator : public BaseOperator {
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
        float speed = getFloat(parameters, 0, 20.0f);
        float size = getFloat(parameters, 1, 4.0f);
        float hue = getFloat(parameters, 2, 0.0f);
        float saturation = getFloat(parameters, 3, 0.0f); // 0 = white
        float value = getFloat(parameters, 4, 255.0f);
        
        uint32_t totalPixels = width * height;
        
        // Start with input buffer if available, otherwise clear to black
        if (inputBuffer1) {
            // Copy input buffer to output as base
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = inputBuffer1[i];
            }
        } else {
            // Clear the buffer if no input
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = CRGB::Black;
            }
        }
        
        // Calculate chase position
        float timeInSeconds = timestampMs * 0.001f;
        // Use normalized speed (0-1 coordinate system) instead of width-dependent
        float normalizedSpeed = speed / 100.0f; // Speed parameter now represents % of width per second
        float normalizedPosition = fmod(timeInSeconds * normalizedSpeed, 1.0f);

        // Create chase color
        CHSV chase_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
        CRGB chase_color = chase_hsv;

        // Proportional bar sizing with 1-pixel minimum.
        int w = (int)width;
        int barWidth = (int)fmax(1.0f, (size / 100.0f) * (float)width);
        if (barWidth > w) barWidth = w;
        // Map the [0,1) phase across the full width so the bar travels one whole loop
        // per cycle, and wrap each pixel toroidally: a bar running off the right edge
        // reappears on the left (half off right => half on left), with no off-screen gap.
        float position = normalizedPosition * (float)width;
        int startX = (int)floorf(position);

        for (int i = 0; i < barWidth; i++) {
            int px = ((startX + i) % w + w) % w;
            for (uint32_t y = 0; y < height; y++) {
                outputBuffer[y * width + px] = chase_color;
            }
        }
    }
    
    const char* getName() const override {
        return "chase";
    }

    const char* getDisplayName() const override {
        return "Chase";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 20.0f, 1.0f, 100.0f),
            ParameterInfo("size", "Size (% width)", ParameterInfo::FLOAT, 10.0f, 1.0f, 50.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(ChaseOperator); 