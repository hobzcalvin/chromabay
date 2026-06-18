#pragma once

#include "BaseOperator.h"
#include <cmath>

// Comet - a bright head that races across the canvas (at any angle) trailing a fading
// tail, wrapping around. Great on a strip; works on a matrix too.
class CometOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 30.0f);  // % of a loop per second
        float trail = getFloat(parameters, 1, 30.0f);  // tail length, % of span
        uint8_t hue = (uint8_t)getInt(parameters, 2, 0);
        uint8_t sat = (uint8_t)getInt(parameters, 3, 255);
        float angle = getFloat(parameters, 4, 0.0f);

        float rad = angle * 0.01745329252f; // deg->rad
        float dx = (height <= 1) ? 1.0f : cosf(rad);
        float dy = (height <= 1) ? 0.0f : sinf(rad);
        float wf = (width > 0) ? (float)(width - 1) : 0.0f;
        float hf = (height > 0) ? (float)(height - 1) : 0.0f;
        float span = wf * fabsf(dx) + hf * fabsf(dy);
        if (span < 1.0f) span = 1.0f;
        float minP = (dx < 0 ? wf * dx : 0.0f) + (dy < 0 ? hf * dy : 0.0f);

        float phase = fmodf(timestampMs * 0.001f * (speed / 100.0f), 1.0f);
        if (phase < 0) phase += 1.0f;
        float head = phase * span;
        float trailLen = fmaxf(1.0f, (trail / 100.0f) * span);

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float coord = (float)x * dx + (float)y * dy - minP;
                float behind = fmodf(head - coord, span);
                if (behind < 0) behind += span;
                CRGB c = CRGB::Black;
                if (behind < trailLen) {
                    float b = 1.0f - behind / trailLen; // 1 at head -> 0 at tail
                    c = CHSV(hue, sat, (uint8_t)(b * b * 255.0f)); // quadratic falloff
                }
                outputBuffer[y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "comet"; }
    const char* getDisplayName() const override { return "Comet"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 30.0f, 1.0f, 200.0f),
            ParameterInfo("trail", "Trail (%)", ParameterInfo::FLOAT, 30.0f, 1.0f, 100.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("angle", "Angle (deg)", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(CometOperator);
