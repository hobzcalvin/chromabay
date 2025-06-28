#pragma once

#include "BaseOperator.h"

// 2D Noise-based LED operator with color blending
class NoiseBlendOperator : public BaseOperator {
public:
    // Direct CRGB buffer access - no conversions needed!
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
        int hueOffset = getInt(parameters, 1, 0);
        float blendAmount = getFloat(parameters, 2, 0.5f);
        float scale = getFloat(parameters, 3, 50.0f);
        
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                
                // Generate 2D noise value using x,y coordinates and time
                uint8_t noise_val = inoise8(
                    x * scale,                                    // X spatial frequency
                    y * scale,                                    // Y spatial frequency  
                    (uint32_t)(timestampMs * speed)              // Time evolution
                );
                
                // Create vibrant noise color
                CRGB noise_color = CHSV(noise_val + hueOffset, 255, 255);
                
                // Blend with input buffer
                CRGB input_color = inputBuffer1 ? inputBuffer1[index] : CRGB::Black;
                outputBuffer[index] = blend(input_color, noise_color, (uint8_t)(blendAmount * 255));
            }
        }
    }
    
    const char* getDisplayName() const override {
        return "2D Noise Blend";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 5.0f),
            ParameterInfo("hueOffset", "Hue Offset", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("blendAmount", "Blend Amount", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("scale", "Noise Scale", ParameterInfo::FLOAT, 50.0f, 10.0f, 200.0f)
        };
    }
};

// Auto-register this operator
REGISTER_OPERATOR(NoiseBlendOperator); 