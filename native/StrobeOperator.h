#pragma once

#include "BaseOperator.h"
#include <cmath>

// Strobe operator - creates flashing strobe effects
class StrobeOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        float rate = getFloat(parameters, 0, 2.0f); // Flashes per second
        float duty_cycle = getFloat(parameters, 1, 0.1f); // 0.0 to 1.0 (fraction of time ON)
        float hue = getFloat(parameters, 2, 0.0f);
        float saturation = getFloat(parameters, 3, 0.0f); // 0 = white strobe

        // Integrated flash phase (smooth when rate changes; see BaseOperator::advancePhase).
        float cycles = advancePhase(deltaTimeMs, rate);
        float frac = cycles - floorf(cycles); // 0..1 within the current flash
        bool is_on = frac < duty_cycle;
        
        uint32_t totalPixels = width * height;
        
        if (is_on) {
            // Fill buffer with strobe color
            CHSV strobe_hsv((uint8_t)hue, (uint8_t)saturation, 255);
            CRGB strobe_color = strobe_hsv;
            
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = strobe_color;
            }
        } else {
            // Clear buffer (OFF phase)
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = CRGB::Black;
            }
        }
    }
    
    const char* getName() const override {
        return "strobe";
    }

    const char* getDisplayName() const override {
        return "Strobe";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("rate", "Rate (Hz)", ParameterInfo::FLOAT, 2.0f, 0.1f, 20.0f),
            ParameterInfo("duty_cycle", "Duty Cycle", ParameterInfo::FLOAT, 0.1f, 0.01f, 0.9f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(StrobeOperator); 