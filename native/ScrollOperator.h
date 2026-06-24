#pragma once

#include "BaseOperator.h"
#include <math.h>

// Scroll - shifts the whole input across the matrix at any angle, wrapping toroidally.
// Makes an entire pattern "chase" in a direction (note: "moving pixel shift to make
// entire patterns chase at any angle"). Pure transform of the input; black if no input.
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
        float speed = getFloat(parameters, 0, 20.0f);  // pixels/sec along the direction
        float angle = getFloat(parameters, 1, 0.0f);    // degrees

        const float kPi = 3.14159265358979323846f;
        float rad = angle * kPi / 180.0f;
        float dist = (timestampMs * 0.001f) * speed;
        // A 1-row strip has no vertical axis — force horizontal.
        float dx = dist * cosf(rad);
        float dy = (height <= 1) ? 0.0f : dist * sinf(rad);

        int idx = 0;
        for (uint32_t y = 0; y < height; y++) {
            int sy = wrap((int)lroundf((float)y - dy), (int)height);
            for (uint32_t x = 0; x < width; x++, idx++) {
                int sx = wrap((int)lroundf((float)x - dx), (int)width);
                outputBuffer[idx] = inputBuffer1[(uint32_t)sy * width + (uint32_t)sx];
            }
        }
    }

    const char* getName() const override { return "scroll"; }
    const char* getDisplayName() const override { return "Scroll"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (px/sec)", ParameterInfo::FLOAT, 20.0f, -200.0f, 200.0f),
            ParameterInfo("angle", "Angle (deg)", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(ScrollOperator);
