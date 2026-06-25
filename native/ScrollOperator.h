#pragma once

#include "BaseOperator.h"
#include <math.h>

// Scroll - shifts the whole input horizontally or vertically over time, wrapping
// toroidally so the entire image is preserved (the edge that goes off one side comes
// back on the other). Note #16 ("moving pixel shift to make patterns chase"). Arbitrary
// angles can't shift a rectangular image without tearing the corners, so this is a
// clean single-axis shift chosen by the `vertical` toggle.
class ScrollOperator : public BaseOperator {
    static inline int wrap(int v, int n) { v %= n; return v < 0 ? v + n : v; }

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
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        float speed = getFloat(parameters, 0, 30.0f);    // % of span per second (negative reverses)
        bool vertical = getBool(parameters, 1, false);

        int span = vertical ? (int)height : (int)width;
        if (span < 1) span = 1;
        // %/sec is resolution-independent: 100%/sec scrolls the whole image across in 1s.
        int shift = wrap((int)lroundf((timestampMs * 0.001f) * (speed / 100.0f) * (float)span), span);

        int idx = 0;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++, idx++) {
                if (vertical) {
                    int sy = wrap((int)y - shift, (int)height);
                    outputBuffer[idx] = inputBuffer1[(uint32_t)sy * width + x];
                } else {
                    int sx = wrap((int)x - shift, (int)width);
                    outputBuffer[idx] = inputBuffer1[y * width + (uint32_t)sx];
                }
            }
        }
    }

    const char* getName() const override { return "scroll"; }
    const char* getDisplayName() const override { return "Scroll"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 30.0f, -200.0f, 200.0f),
            ParameterInfo("vertical", "Vertical", ParameterInfo::BOOL, false)
        };
    }
};

REGISTER_OPERATOR(ScrollOperator);
