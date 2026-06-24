#pragma once

#include "BaseOperator.h"

// Glitch - a datamosh-style glitch filter: random horizontal slices get shoved
// sideways and their RGB channels split, changing over time. Pure transform of the
// input; black if no input.
class GlitchOperator : public BaseOperator {
    // Cheap integer hash -> 32 bits, for per-(frame,row) randomness.
    static inline uint32_t hash2(uint32_t a, uint32_t b) {
        uint32_t h = a * 374761393u + b * 668265263u;
        h = (h ^ (h >> 13)) * 1274126177u;
        return h ^ (h >> 16);
    }
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
        float intensity = getFloat(parameters, 0, 0.5f);  // 0..1
        float speed = getFloat(parameters, 1, 1.0f);       // glitch churn rate
        if (intensity < 0.0f) intensity = 0.0f;
        if (intensity > 1.0f) intensity = 1.0f;

        // Step the seed over time so the glitch pattern keeps changing.
        uint32_t frame = (uint32_t)(timestampMs * 0.001f * speed * 10.0f);
        // How far channels split (in px) and how big slice shoves can get, scale w/ intensity.
        int chanSplit = (int)(intensity * (float)width * 0.06f);
        int maxShift = (int)(intensity * (float)width * 0.5f);
        // Probability (0..255) that a given row is a glitched slice.
        uint32_t sliceProb = (uint32_t)(intensity * 200.0f);

        for (uint32_t y = 0; y < height; y++) {
            uint32_t hr = hash2(frame, y);
            int shift = ((hr & 0xFF) < sliceProb) ? ((int)((hr >> 8) % (uint32_t)(2 * maxShift + 1)) - maxShift) : 0;
            for (uint32_t x = 0; x < width; x++) {
                uint32_t base = y * width;
                CRGB src = inputBuffer1[base + (uint32_t)wrap((int)x - shift, (int)width)];
                if (chanSplit > 0) {
                    // Pull R from the left, B from the right -> RGB fringing.
                    CRGB rs = inputBuffer1[base + (uint32_t)wrap((int)x - shift - chanSplit, (int)width)];
                    CRGB bs = inputBuffer1[base + (uint32_t)wrap((int)x - shift + chanSplit, (int)width)];
                    outputBuffer[base + x] = CRGB(rs.r, src.g, bs.b);
                } else {
                    outputBuffer[base + x] = src;
                }
            }
        }
    }

    const char* getName() const override { return "glitch"; }
    const char* getDisplayName() const override { return "Glitch"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("intensity", "Intensity", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 5.0f)
        };
    }
};

REGISTER_OPERATOR(GlitchOperator);
