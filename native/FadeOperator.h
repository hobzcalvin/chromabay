#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Fade operator - creates sine wave-based fade effects
class FadeOperator : public BaseOperator {
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
        float speed = getFloat(parameters, 0, 1.0f);
        float hue = getFloat(parameters, 1, 30.0f); // Default to orange-ish
        float saturation = getFloat(parameters, 2, 255.0f);
        float value = getFloat(parameters, 3, 255.0f);
        
        // Calculate fade intensity using sine wave
        float timeInSeconds = timestampMs * 0.001f;
        float fadeIntensity = (sin(timeInSeconds * speed) + 1.0f) * 0.5f; // 0.0 to 1.0
        
        uint32_t totalPixels = width * height;
        
        if (inputBuffer1) {
            // Apply fade effect to input buffer
            for (uint32_t i = 0; i < totalPixels; i++) {
                CRGB input_color = inputBuffer1[i];
                // Scale the input color by the fade intensity
                outputBuffer[i] = CRGB(
                    (uint8_t)(input_color.r * fadeIntensity),
                    (uint8_t)(input_color.g * fadeIntensity),
                    (uint8_t)(input_color.b * fadeIntensity)
                );
            }
        } else {
            // Apply fade to solid color
            uint8_t actualValue = (uint8_t)(value * fadeIntensity);
            CHSV fade_hsv((uint8_t)hue, (uint8_t)saturation, actualValue);
            CRGB fade_color = fade_hsv;
            
            // Fill entire buffer with faded color
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = fade_color;
            }
        }
    }
    
    const char* getDisplayName() const override {
        return "Fade";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 10.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 30.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(FadeOperator); 