#pragma once

#include "BaseOperator.h"

// Invert - photo-negative each pixel (255 - channel), blendable by amount.
class InvertOperator : public BaseOperator {
    inline uint8_t lerp8(uint8_t a, uint8_t b, float t) const {
        float v = a + (b - a) * t;
        return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v);
    }
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
        float amount = getFloat(parameters, 0, 1.0f);
        if (amount < 0) amount = 0; if (amount > 1) amount = 1;
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t i = 0; i < total; i++) {
            CRGB c = inputBuffer1[i];
            outputBuffer[i] = CRGB(lerp8(c.r, 255 - c.r, amount),
                                   lerp8(c.g, 255 - c.g, amount),
                                   lerp8(c.b, 255 - c.b, amount));
        }
    }

    const char* getName() const override { return "invert"; }
    const char* getDisplayName() const override { return "Invert"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(InvertOperator);
