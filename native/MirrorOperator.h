#pragma once

#include "BaseOperator.h"

// Mirror / Kaleidoscope - fold the image so it's symmetric. Mode: 0 = mirror left↔right,
// 1 = mirror top↔bottom, 2 = quad (both, 4-fold kaleidoscope). The first half (or
// quadrant) is the source; the rest reflects it.
class MirrorOperator : public BaseOperator {
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
        int mode = getInt(parameters, 0, 0);
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t sx = x, sy = y;
                if (mode == 0 || mode == 2) {                 // fold X about the center
                    if (x >= width - x - 1) sx = width - x - 1;
                }
                if (mode == 1 || mode == 2) {                 // fold Y about the center
                    if (y >= height - y - 1) sy = height - y - 1;
                }
                outputBuffer[y * width + x] = inputBuffer1[sy * width + sx];
            }
        }
    }

    const char* getName() const override { return "mirror"; }
    const char* getDisplayName() const override { return "Mirror"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            // 0 = Left/Right, 1 = Top/Bottom, 2 = Quad
            ParameterInfo("mode", "Mode", ParameterInfo::INT, 0, 0, 2)
        };
    }
};

REGISTER_OPERATOR(MirrorOperator);
