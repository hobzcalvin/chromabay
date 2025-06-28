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
        float position = fmod(timeInSeconds * speed, (float)width);
        
        // Create chase color
        CHSV chase_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
        CRGB chase_color = chase_hsv;
        
        // Draw vertical bar at current position
        int startX = (int)position;
        int barWidth = (int)size;
        
        for (int x = startX; x < startX + barWidth && x < (int)width; x++) {
            if (x >= 0) {
                for (uint32_t y = 0; y < height; y++) {
                    uint32_t index = y * width + x;
                    outputBuffer[index] = chase_color;
                }
            }
        }
    }
    
    const char* getDisplayName() const override {
        return "Chase";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 20.0f, 5.0f, 100.0f),
            ParameterInfo("size", "Size", ParameterInfo::FLOAT, 4.0f, 1.0f, 20.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(ChaseOperator); 