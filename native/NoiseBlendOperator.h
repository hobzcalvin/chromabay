#pragma once

#include "BaseOperator.h"

// Noise-based LED operator with color blending
class NoiseBlendOperator : public BaseOperator {
public:
    // Direct CRGB buffer access - no conversions needed!
    void render(
        CRGB* inputBuffer1,
        CRGB* inputBuffer2,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 1.0f);
        int hueOffset = getInt(parameters, 1, 0);
        float blendAmount = getFloat(parameters, 2, 0.5f);
        
        uint32_t totalPixels = width * height;
        
        for (uint32_t i = 0; i < totalPixels; i++) {
            // Generate noise value
            uint8_t noise_val = inoise8(i * 40, (uint32_t)(timestampMs * speed / 3));
            
            // Create vibrant noise color
            CRGB noise_color = CHSV(noise_val + hueOffset, 255, 255);
            
            // Blend with input buffer
            CRGB input_color = inputBuffer1 ? inputBuffer1[i] : CRGB::Black;
            outputBuffer[i] = blend(input_color, noise_color, (uint8_t)(blendAmount * 255));
        }
    }
    
    const char* getDisplayName() const override {
        return "Noise Blend";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 5.0f),
            ParameterInfo("hueOffset", "Hue Offset", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("blendAmount", "Blend Amount", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f)
        };
    }
};

// Auto-register this operator
REGISTER_OPERATOR(NoiseBlendOperator); 