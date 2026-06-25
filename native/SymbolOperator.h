#pragma once

#include "BaseOperator.h"
#include <math.h>

// Symbol - draws a glyph scaled to the matrix and (optionally) cycles through a set over
// time. The glyphs are PROCEDURAL (defined as shapes in normalized [-1,1] space, not
// bitmaps), so they stay crisp at any matrix resolution and are antialiased by
// supersampling — no "cut off" low-res bitmap problem. Set speed=0 to FREEZE on the glyph
// chosen by the Glyph selector; speed>0 cycles through all of them.
class SymbolOperator : public BaseOperator {
public:
    // Keep this list in sync with getParameterInfo()'s Glyph options.
    enum Glyph {
        HEART = 0, SMILEY, STAR, DIAMOND, SQUARE, CIRCLE, RING, PLUS, CROSS,
        TRIANGLE, ARROW_UP, ARROW_RIGHT, GLYPH_COUNT
    };

private:
    static constexpr float kPI = 3.14159265358979f;

    // Is normalized point (u,v) inside glyph `g`? u,v in [-1,1], v positive = down.
    static bool inside(int g, float u, float v) {
        float r2 = u * u + v * v;
        switch (g) {
            case CIRCLE:   return r2 <= 0.85f * 0.85f;
            case RING:     return r2 <= 0.9f * 0.9f && r2 >= 0.55f * 0.55f;
            case SQUARE:   return fabsf(u) <= 0.8f && fabsf(v) <= 0.8f;
            case DIAMOND:  return fabsf(u) + fabsf(v) <= 0.95f;
            case PLUS:     return (fabsf(u) <= 0.28f && fabsf(v) <= 0.85f) ||
                                  (fabsf(v) <= 0.28f && fabsf(u) <= 0.85f);
            case CROSS: {  // X: two diagonal bars
                float d = fminf(fabsf(u - v), fabsf(u + v)) * 0.70710678f;
                return d <= 0.22f && fabsf(u) <= 0.85f && fabsf(v) <= 0.85f;
            }
            case TRIANGLE: { // pointing up: apex at v=-0.85, base at v=0.75
                if (v > 0.75f || v < -0.85f) return false;
                float t = (v + 0.85f) / 1.6f;          // 0 at apex .. 1 at base
                return fabsf(u) <= 0.9f * t;
            }
            case ARROW_UP: { // shaft + head, pointing up
                bool head = (v <= 0.0f && v >= -0.9f) && fabsf(u) <= 0.85f * ((v + 0.9f) / 0.9f);
                bool shaft = fabsf(u) <= 0.22f && v >= -0.1f && v <= 0.85f;
                return head || shaft;
            }
            case ARROW_RIGHT: { // shaft + head, pointing right (ARROW_UP rotated 90° cw)
                float a = -v, b = u;                    // rotate
                bool head = (a <= 0.0f && a >= -0.9f) && fabsf(b) <= 0.85f * ((a + 0.9f) / 0.9f);
                bool shaft = fabsf(b) <= 0.22f && a >= -0.1f && a <= 0.85f;
                return head || shaft;
            }
            case STAR: {     // 5-point star, one point up
                float ang = atan2f(-v, u) - kPI * 0.5f;  // 0 at top, ccw
                float seg = 2.0f * kPI / 5.0f;
                float t = fmodf(ang, seg); if (t < 0) t += seg;
                t = fabsf(t - seg * 0.5f) / (seg * 0.5f); // 0 aligned w/ spike .. 1 between
                float edge = 0.95f - (0.95f - 0.40f) * t;
                return sqrtf(r2) <= edge;
            }
            case SMILEY: {   // yellow face disc, minus eyes and a smile arc
                if (r2 > 0.92f * 0.92f) return false;
                float ex = 0.34f, ey = -0.25f, er = 0.14f;
                if ((u + ex) * (u + ex) + (v - ey) * (v - ey) <= er * er) return false; // L eye
                if ((u - ex) * (u - ex) + (v - ey) * (v - ey) <= er * er) return false; // R eye
                float md = sqrtf(u * u + (v - 0.05f) * (v - 0.05f));                    // smile
                if (v > 0.12f && md >= 0.42f && md <= 0.58f) return false;
                return true;
            }
            case HEART:
            default: {       // classic implicit heart, point down
                float x = u * 1.15f, y = -v * 1.15f;    // y up
                float a = x * x + y * y - 1.0f;
                return a * a * a - x * x * y * y * y <= 0.0f;
            }
        }
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
        float speed      = getFloat(parameters, 0, 0.5f);   // glyphs per second (0 = freeze)
        int   chosen     = getInt(parameters, 1, 0);        // Glyph selector (used when frozen)
        float hue        = getFloat(parameters, 2, 40.0f);
        float saturation = getFloat(parameters, 3, 255.0f);
        float value      = getFloat(parameters, 4, 255.0f);

        int idx;
        if (speed > 0.0f) {
            idx = (int)((timestampMs * 0.001f) * speed) % GLYPH_COUNT;
            if (idx < 0) idx += GLYPH_COUNT;
        } else {
            idx = chosen % GLYPH_COUNT;
            if (idx < 0) idx += GLYPH_COUNT;
        }

        CRGB on = CHSV((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);

        // 3x3 supersampling for antialiased edges (crisp shrink at any resolution).
        const int SS = 3;
        const float inv = 1.0f / (float)SS;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                int hits = 0;
                for (int sy = 0; sy < SS; sy++) {
                    float v = (height <= 1) ? 0.0f
                            : (((float)y + (sy + 0.5f) * inv) / (float)height) * 2.0f - 1.0f;
                    for (int sx = 0; sx < SS; sx++) {
                        float u = (width <= 1) ? 0.0f
                                : (((float)x + (sx + 0.5f) * inv) / (float)width) * 2.0f - 1.0f;
                        if (inside(idx, u, v)) hits++;
                    }
                }
                int s = (hits * 255) / (SS * SS);
                if (s == 0 && hits > 0) s = 1;
                outputBuffer[y * width + x] = CRGB((on.r * s) / 255, (on.g * s) / 255, (on.b * s) / 255);
            }
        }
    }

    const char* getName() const override { return "symbol"; }
    const char* getDisplayName() const override { return "Symbol"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Cycle (glyphs/sec, 0=freeze)", ParameterInfo::FLOAT, 0.5f, 0.0f, 5.0f),
            ParameterInfo("glyph", "Glyph (when frozen)", ParameterInfo::SELECT, 0,
                std::vector<std::string>{ "Heart", "Smiley", "Star", "Diamond", "Square",
                                          "Circle", "Ring", "Plus", "X", "Triangle",
                                          "Arrow Up", "Arrow Right" }),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 40.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(SymbolOperator);
