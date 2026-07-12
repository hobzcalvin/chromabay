#pragma once

#include "BaseOperator.h"
#include "Modulation.h"   // hash01 — deterministic per-wave randomness (matches WASM + firmware)
#include <cmath>

// Interference - a field built from the SUM of several plane waves, each with a randomized
// direction, wavelength, speed and phase (seeded, so it's reproducible and identical on every
// device). One wave is a plain grating; a handful summed gives moiré / ocean-swell / rippling
// interference. Wavelength is a FRACTION of the display's short side, so it looks the same at
// any resolution. This is the "random waves from random directions" generalization of Wave.
class InterferenceOperator : public BaseOperator {
    static constexpr float kTwoPi = 6.28318530718f;
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        int count       = getInt(parameters, 0, 4);
        float wavelength = getFloat(parameters, 1, 0.30f);  // fraction of min(w,h)
        float speed      = getFloat(parameters, 2, 20.0f);  // %/sec of a cycle
        float spread     = getFloat(parameters, 3, 1.0f);   // 0 = one direction, 1 = fully random
        uint8_t hue      = (uint8_t)getInt(parameters, 4, 150);
        uint8_t sat      = (uint8_t)getInt(parameters, 5, 255);
        float contrast   = getFloat(parameters, 6, 1.0f);
        uint32_t seed    = (uint32_t)getInt(parameters, 7, 1);

        if (count < 1) count = 1;
        if (count > 12) count = 12;
        const float base = (float)(width < height ? width : height);
        const float wlPx = (wavelength > 0.001f ? wavelength : 0.001f) * base; // wavelength in pixels
        // Integrated seconds (smooth when speed changes; see BaseOperator::advancePhase).
        const float secs = advancePhase(deltaTimeMs, speed * 0.01f);

        // Precompute each wave's random parameters once per frame.
        struct W { float dx, dy, k, spd, ph; };
        W waves[12];
        for (int i = 0; i < count; i++) {
            float a = kTwoPi * (Modulation::hash01((uint32_t)(i * 4 + 1), seed) * spread); // direction
            waves[i].dx = cosf(a);
            waves[i].dy = sinf(a);
            float wl = wlPx * (0.6f + 0.8f * Modulation::hash01((uint32_t)(i * 4 + 2), seed)); // 0.6x–1.4x
            waves[i].k = kTwoPi / (wl > 0.5f ? wl : 0.5f);
            float sp = 0.5f + Modulation::hash01((uint32_t)(i * 4 + 3), seed);                // 0.5x–1.5x
            waves[i].spd = (Modulation::hash01((uint32_t)(i * 4 + 0), seed) < 0.5f ? -sp : sp);
            waves[i].ph = kTwoPi * Modulation::hash01((uint32_t)(i * 4 + 2), seed + 7u);
        }

        const float invCount = 1.0f / (float)count;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float sum = 0.0f;
                for (int i = 0; i < count; i++) {
                    float proj = (float)x * waves[i].dx + (float)y * waves[i].dy;
                    sum += cosf(waves[i].k * proj - kTwoPi * waves[i].spd * secs + waves[i].ph);
                }
                float v = 0.5f + 0.5f * contrast * (sum * invCount); // → ~[0,1]
                if (v < 0.0f) v = 0.0f; if (v > 1.0f) v = 1.0f;
                outputBuffer[(size_t)y * width + x] = CHSV(hue, sat, (uint8_t)(v * 255.0f));
            }
        }
    }

    const char* getName() const override { return "interference"; }
    const char* getDisplayName() const override { return "Interference"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("count", "Waves", ParameterInfo::INT, 4, 1, 12),
            ParameterInfo("wavelength", "Wavelength", ParameterInfo::FLOAT, 0.30f, 0.02f, 1.0f),
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 20.0f, -200.0f, 200.0f),
            ParameterInfo("spread", "Direction spread", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 150, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("contrast", "Contrast", ParameterInfo::FLOAT, 1.0f, 0.1f, 3.0f),
            ParameterInfo("seed", "Seed", ParameterInfo::INT, 1, 0, 999)
        };
    }
};

REGISTER_OPERATOR(InterferenceOperator);
