#pragma once

#include "BaseOperator.h"
#include <cmath>

// Twinkle - soft ambient twinkling. Each pixel breathes on its own hashed phase
// (unlike Sparkle's hard random pops), so a fraction of the canvas gently glows in and
// out. A calm starfield-ish base.
class TwinkleOperator : public BaseOperator {
    static constexpr float kTwoPi = 6.28318530718f;
    static inline uint32_t hash2(uint32_t a, uint32_t b) {
        uint32_t h = a * 374761393u + b * 668265263u;
        h = (h ^ (h >> 13)) * 1274126177u;
        return h ^ (h >> 16);
    }
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 1.0f);
        uint8_t hue = (uint8_t)getInt(parameters, 1, 160);
        uint8_t sat = (uint8_t)getInt(parameters, 2, 200);
        float density = getFloat(parameters, 3, 0.5f); // fraction that twinkle
        if (density < 0) density = 0; if (density > 1) density = 1;
        uint8_t densThresh = (uint8_t)(density * 255.0f);

        float t = timestampMs * 0.001f * speed;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t hsh = hash2(x, y);
                CRGB c = CRGB::Black;
                if ((hsh & 0xFF) <= densThresh) {
                    float phase = ((hsh >> 8) & 0xFFFF) / 65535.0f * kTwoPi;
                    float b = (sinf(t + phase) + 1.0f) * 0.5f;
                    b = b * b; // sharper, more star-like peaks
                    uint8_t h = (uint8_t)(hue + ((hsh >> 24) & 0x1F)); // slight hue variation
                    c = CHSV(h, sat, (uint8_t)(b * 255.0f));
                }
                outputBuffer[y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "twinkle"; }
    const char* getDisplayName() const override { return "Twinkle"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.0f, 5.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 160, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 200, 0, 255),
            ParameterInfo("density", "Density", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(TwinkleOperator);
