#pragma once

#include "BaseOperator.h"
#include <math.h>

// Symbol - draws a glyph from a small built-in set, scaled to the matrix, and cycles
// through them over time (note: "symbol node, can cycle thru wingdings"). A generator:
// ignores input, draws the glyph in the chosen colour on black.
class SymbolOperator : public BaseOperator {
    // 8x8 monochrome glyphs, one byte per row, MSB = leftmost column.
    static const uint8_t* glyphs(int& count) {
        static const uint8_t G[][8] = {
            { 0x00,0x66,0xFF,0xFF,0xFF,0x7E,0x3C,0x18 }, // heart
            { 0x3C,0x42,0xA5,0x81,0xA5,0x99,0x42,0x3C }, // smiley
            { 0x18,0x3C,0x7E,0xFF,0xFF,0x7E,0x3C,0x18 }, // diamond
            { 0xFF,0x81,0x81,0x81,0x81,0x81,0x81,0xFF }, // square
            { 0x18,0x3C,0x7E,0xFF,0x18,0x18,0x18,0x18 }, // arrow up
            { 0x81,0x42,0x24,0x18,0x18,0x24,0x42,0x81 }, // X
            { 0x18,0x18,0x18,0xFF,0xFF,0x18,0x18,0x18 }, // plus
            { 0x18,0x18,0xFF,0x7E,0x3C,0x66,0x42,0x00 }, // star-ish
        };
        count = (int)(sizeof(G) / sizeof(G[0]));
        return &G[0][0];
    }

public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 0.5f);     // glyphs per second (0 = hold first)
        float hue = getFloat(parameters, 1, 0.0f);
        float saturation = getFloat(parameters, 2, 255.0f);
        float value = getFloat(parameters, 3, 255.0f);

        int count = 0;
        const uint8_t* g = glyphs(count);
        int idx = 0;
        if (speed > 0.0f) {
            idx = (int)((timestampMs * 0.001f) * speed) % count;
            if (idx < 0) idx += count;
        }
        const uint8_t* glyph = g + idx * 8;

        CRGB on = CHSV((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);

        // Area-average downsample of the 8x8 glyph onto the WxH matrix: each output pixel
        // covers a rectangle in glyph space, and its brightness is the lit fraction of that
        // rectangle. Point-sampling (nearest) silently dropped whole columns/rows on small
        // matrices (e.g. 5x5), so thin features vanished and glyphs looked "cut off"; this
        // keeps the whole shape, just dimmer at partially-covered edges.
        for (uint32_t y = 0; y < height; y++) {
            float fy0 = (float)y * 8.0f / (float)height;
            float fy1 = (float)(y + 1) * 8.0f / (float)height;
            for (uint32_t x = 0; x < width; x++) {
                float fx0 = (float)x * 8.0f / (float)width;
                float fx1 = (float)(x + 1) * 8.0f / (float)width;

                float covered = 0.0f, area = 0.0f;
                for (int gy = (int)floorf(fy0); gy < (int)ceilf(fy1) && gy < 8; gy++) {
                    if (gy < 0) continue;
                    float oy = fminf(fy1, (float)(gy + 1)) - fmaxf(fy0, (float)gy);
                    if (oy <= 0.0f) continue;
                    uint8_t row = glyph[gy];
                    for (int gx = (int)floorf(fx0); gx < (int)ceilf(fx1) && gx < 8; gx++) {
                        if (gx < 0) continue;
                        float ox = fminf(fx1, (float)(gx + 1)) - fmaxf(fx0, (float)gx);
                        if (ox <= 0.0f) continue;
                        float a = ox * oy;
                        area += a;
                        if ((row >> (7 - gx)) & 0x01) covered += a;
                    }
                }

                float frac = (area > 0.0f) ? covered / area : 0.0f;
                int s = (int)(frac * 255.0f + 0.5f);
                if (s == 0 && frac > 0.0f) s = 1; // keep slivers barely visible, not black
                outputBuffer[y * width + x] = CRGB((on.r * s) / 255, (on.g * s) / 255, (on.b * s) / 255);
            }
        }
    }

    const char* getName() const override { return "symbol"; }
    const char* getDisplayName() const override { return "Symbol"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Cycle (glyphs/sec)", ParameterInfo::FLOAT, 0.5f, 0.0f, 5.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(SymbolOperator);
