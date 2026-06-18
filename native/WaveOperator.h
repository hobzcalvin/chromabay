#pragma once

#include "BaseOperator.h"
#include <cmath>

// Wave - moving sine-wave bands of a single color, traveling at any angle. Brightness
// pulses across the canvas in bands; good as a rhythmic base layer.
class WaveOperator : public BaseOperator {
    static constexpr float kTwoPi = 6.28318530718f;
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 1.0f);
        float freq = getFloat(parameters, 1, 2.0f);   // wave cycles across the canvas
        uint8_t hue = (uint8_t)getInt(parameters, 2, 160);
        uint8_t sat = (uint8_t)getInt(parameters, 3, 255);
        float angle = getFloat(parameters, 4, 0.0f);

        float rad = angle * (kTwoPi / 360.0f);
        float dx = (height <= 1) ? 1.0f : cosf(rad);
        float dy = (height <= 1) ? 0.0f : sinf(rad);
        float wf = (width > 0) ? (float)(width - 1) : 0.0f;
        float hf = (height > 0) ? (float)(height - 1) : 0.0f;
        float span = wf * fabsf(dx) + hf * fabsf(dy);
        if (span < 1.0f) span = 1.0f;
        float minP = (dx < 0 ? wf * dx : 0.0f) + (dy < 0 ? hf * dy : 0.0f);
        float t = timestampMs * 0.001f * speed;

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float coord = ((float)x * dx + (float)y * dy - minP) / span; // 0..1
                float b = (sinf(coord * freq * kTwoPi - t * kTwoPi) + 1.0f) * 0.5f;
                outputBuffer[y * width + x] = CHSV(hue, sat, (uint8_t)(b * 255.0f));
            }
        }
    }
    const char* getName() const override { return "wave"; }
    const char* getDisplayName() const override { return "Wave"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.0f, 5.0f),
            ParameterInfo("frequency", "Bands", ParameterInfo::FLOAT, 2.0f, 0.5f, 12.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 160, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("angle", "Angle (deg)", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(WaveOperator);
