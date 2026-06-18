#pragma once

#include "BaseOperator.h"

// Brightness -> Rainbow. Maps each pixel's luma to a hue around the full color wheel.
// At defaults (offset 0, cycles 1): black and white are red (hue wraps), 50% gray is
// cyan. Output is full-saturation, full-value color. `cycles` packs more rainbow bands
// across the brightness range; `offset` rotates the mapping.
class LumaToHueOperator : public BaseOperator {
public:
    void render(
        CRGB* inputBuffer1,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        int offset = getInt(parameters, 0, 0);
        float cycles = getFloat(parameters, 1, 1.0f);
        uint8_t sat = (uint8_t)getInt(parameters, 2, 255);
        uint32_t total = width * height;

        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t i = 0; i < total; i++) {
            CRGB c = inputBuffer1[i];
            float luma = 0.299f * c.r + 0.587f * c.g + 0.114f * c.b; // 0..255
            int hue = (int)(luma * cycles) + offset;
            uint8_t h = (uint8_t)(((hue % 256) + 256) % 256);
            CRGB out = CHSV(h, sat, 255);
            outputBuffer[i] = out;
        }
    }

    const char* getName() const override { return "lumahue"; }
    const char* getDisplayName() const override { return "Brightness → Rainbow"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("offset", "Hue Offset", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("cycles", "Cycles", ParameterInfo::FLOAT, 1.0f, 0.25f, 6.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255)
        };
    }
};

REGISTER_OPERATOR(LumaToHueOperator);
