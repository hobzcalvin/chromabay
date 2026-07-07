#pragma once

#include "BaseOperator.h"

// Glitch - a datamosh-style filter: the image is broken into a grid of blocks and
// random blocks get shoved in X AND Y (not just horizontal slices) with RGB channel
// fringing, churning over time. Pure transform of the input; black if no input.
class GlitchOperator : public BaseOperator {
    static inline uint32_t hash3(uint32_t a, uint32_t b, uint32_t c) {
        uint32_t h = a * 374761393u + b * 668265263u + c * 2246822519u;
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
        uint32_t /* timestampMs */,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        float intensity = getFloat(parameters, 0, 0.5f);  // 0..1
        float speed = getFloat(parameters, 1, 1.0f);
        float blockSize = getFloat(parameters, 2, 14.0f); // base block size, % of min dimension
        if (intensity < 0.0f) intensity = 0.0f;
        if (intensity > 1.0f) intensity = 1.0f;

        int minDim = (int)((width < height) ? width : height);
        int base = (int)(blockSize / 100.0f * (float)minDim); if (base < 1) base = 1;
        int superSz = base * 3; // a super-cell spans up to a 3x block; its hash sets the
                                // local block size (1x/2x/3x) so some blocks are small and
                                // some large instead of one regular grid.
        int maxOff = (int)(intensity * 0.6f * (float)minDim);
        if (maxOff < 1) maxOff = 1;
        int chan = (int)(intensity * (float)width * 0.05f);
        uint32_t prob = (uint32_t)(intensity * 255.0f); // chance a block is displaced
        uint32_t frame = (uint32_t)advancePhase(deltaTimeMs, speed * 8.0f); // integrated: smooth speed changes

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t scx = x / (uint32_t)superSz, scy = y / (uint32_t)superSz;
                int mult = 1 + (int)(hash3(777u, scx, scy) % 3u); // 1..3 -> block size varies
                int bsz = base * mult;
                uint32_t bx = x / (uint32_t)bsz, by = y / (uint32_t)bsz;
                uint32_t hh = hash3(frame, bx * 131u + scx, by * 131u + scy);
                bool active = (hh & 0xFF) < prob;
                int ox = 0, oy = 0;
                if (active) {
                    ox = (int)((hh >> 8) % (uint32_t)(2 * maxOff + 1)) - maxOff;
                    oy = (int)((hh >> 20) % (uint32_t)(2 * maxOff + 1)) - maxOff;
                }
                int sx = wrap((int)x - ox, (int)width);
                int sy = wrap((int)y - oy, (int)height);
                CRGB c = inputBuffer1[(uint32_t)sy * width + (uint32_t)sx];
                if (active && chan > 0) {
                    CRGB rs = inputBuffer1[(uint32_t)sy * width + (uint32_t)wrap(sx - chan, (int)width)];
                    CRGB bs = inputBuffer1[(uint32_t)sy * width + (uint32_t)wrap(sx + chan, (int)width)];
                    outputBuffer[y * width + x] = CRGB(rs.r, c.g, bs.b);
                } else {
                    outputBuffer[y * width + x] = c;
                }
            }
        }
    }

    const char* getName() const override { return "glitch"; }
    const char* getDisplayName() const override { return "Glitch"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("intensity", "Intensity", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 5.0f),
            ParameterInfo("blockSize", "Block Size (%)", ParameterInfo::FLOAT, 14.0f, 4.0f, 40.0f)
        };
    }
};

REGISTER_OPERATOR(GlitchOperator);
