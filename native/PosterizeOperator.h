#pragma once

#include "BaseOperator.h"
#include <cmath>

// Posterize - quantize each channel to a small number of levels for a banded, graphic
// look (think Warhol / cell-shading). 2 levels = harsh; higher = subtler.
class PosterizeOperator : public BaseOperator {
private:
    inline uint8_t quant(uint8_t c, int levels) const {
        if (levels < 2) levels = 2;
        float step = 255.0f / (levels - 1);
        return (uint8_t)(roundf(c / step) * step);
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
        int levels = getInt(parameters, 0, 3);
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t i = 0; i < total; i++) {
            CRGB c = inputBuffer1[i];
            outputBuffer[i] = CRGB(quant(c.r, levels), quant(c.g, levels), quant(c.b, levels));
        }
    }

    const char* getName() const override { return "posterize"; }
    const char* getDisplayName() const override { return "Posterize"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("levels", "Levels", ParameterInfo::INT, 3, 2, 16)
        };
    }
};

REGISTER_OPERATOR(PosterizeOperator);
