#pragma once

#include "BaseOperator.h"
#include <cmath>

// Plasma - classic demoscene plasma: summed sine fields flowing over time, mapped to
// hue. A lush, always-moving color source to build on.
class PlasmaOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 1.0f);
        float scale = getFloat(parameters, 1, 0.25f); // spatial frequency, in cycles relative to a 32px display
        int hueShift = getInt(parameters, 2, 0);
        uint8_t sat = (uint8_t)getInt(parameters, 3, 255);

        // Resolution-independent: normalize coordinates to the display (x by width, y by height,
        // matching Rainbow/Gradient/Perlin) and multiply by a reference dimension, so a tiny display
        // and a large one show the SAME pattern at the same Scale. Centered so Scale zooms about the middle.
        const float REF = 32.0f;
        float t = timestampMs * 0.001f * speed;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float fx = ((float)x - width * 0.5f) / (float)width * REF * scale;
                float fy = ((float)y - height * 0.5f) / (float)height * REF * scale;
                float v = sinf(fx + t)
                        + sinf(fy + t * 1.3f)
                        + sinf((fx + fy) * 0.5f + t * 0.7f)
                        + sinf(sqrtf(fx * fx + fy * fy) * 0.8f + t * 1.1f);
                // v in [-4,4] -> hue
                int hue = (int)((v + 4.0f) * (255.0f / 8.0f)) + hueShift;
                uint8_t h = (uint8_t)(((hue % 256) + 256) % 256);
                outputBuffer[y * width + x] = CHSV(h, sat, 255);
            }
        }
    }
    const char* getName() const override { return "plasma"; }
    const char* getDisplayName() const override { return "Plasma"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.0f, 5.0f),
            ParameterInfo("scale", "Scale", ParameterInfo::FLOAT, 0.25f, 0.02f, 1.0f),
            ParameterInfo("hue_shift", "Hue Shift", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255)
        };
    }
};

REGISTER_OPERATOR(PlasmaOperator);
