#pragma once

#include "BaseOperator.h"
#include <math.h>

// Symbol - draws a glyph scaled to the matrix and (optionally) cycles through a set over
// time. Glyphs are PROCEDURAL (shapes in normalized [-1,1] space), so they stay crisp at
// any resolution. Supersampled for antialiasing on larger matrices, but THRESHOLDED on
// tiny ones (< ~12px) so thin shapes (e.g. a plus on a 5x5) read crisply instead of
// blurring into a faded blob. speed=0 freezes on the selected Glyph; speed>0 cycles.
class SymbolOperator : public BaseOperator {
public:
    // Keep in sync with getParameterInfo()'s Glyph options.
    enum Glyph {
        HEART = 0, SMILEY, STAR, DIAMOND, SQUARE, CIRCLE, RING, PLUS, CROSS,
        TRIANGLE, ARROW_UP, ARROW_RIGHT, ARROW_DOWN, ARROW_LEFT, LIGHTNING,
        CRESCENT, SPARKLE4, GLYPH_COUNT
    };

private:
    static constexpr float kPI = 3.14159265358979f;

    // Up-pointing arrow (points toward -a); rotate the inputs to aim it elsewhere.
    static bool arrowShape(float a, float b) {
        bool head = (a <= 0.0f && a >= -0.9f) && fabsf(b) <= 0.85f * ((a + 0.9f) / 0.9f);
        bool shaft = fabsf(b) <= 0.22f && a >= -0.1f && a <= 0.85f;
        return head || shaft;
    }
    static float segDist(float px, float py, float ax, float ay, float bx, float by) {
        float vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
        float t = (wx * vx + wy * vy) / (vx * vx + vy * vy + 1e-6f);
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        float dx = px - (ax + t * vx), dy = py - (ay + t * vy);
        return sqrtf(dx * dx + dy * dy);
    }
    // n-point polar star/sparkle: spike radius `outer`, valley `inner`.
    static bool starN(float u, float v, float r2, int n, float outer, float inner) {
        float ang = atan2f(-v, u) - kPI * 0.5f;
        float seg = 2.0f * kPI / (float)n;
        float t = fmodf(ang, seg); if (t < 0) t += seg;
        t = fabsf(t - seg * 0.5f) / (seg * 0.5f);
        float edge = outer - (outer - inner) * t;
        return sqrtf(r2) <= edge;
    }

    static bool inside(int g, float u, float v) {
        float r2 = u * u + v * v;
        switch (g) {
            case CIRCLE:   return r2 <= 0.85f * 0.85f;
            case RING:     return r2 <= 0.9f * 0.9f && r2 >= 0.55f * 0.55f;
            case SQUARE:   return fabsf(u) <= 0.8f && fabsf(v) <= 0.8f;
            case DIAMOND:  return fabsf(u) + fabsf(v) <= 0.95f;
            case PLUS:     return (fabsf(u) <= 0.28f && fabsf(v) <= 0.85f) ||
                                  (fabsf(v) <= 0.28f && fabsf(u) <= 0.85f);
            case CROSS: {
                float d = fminf(fabsf(u - v), fabsf(u + v)) * 0.70710678f;
                return d <= 0.22f && fabsf(u) <= 0.85f && fabsf(v) <= 0.85f;
            }
            case TRIANGLE: {
                if (v > 0.75f || v < -0.85f) return false;
                float t = (v + 0.85f) / 1.6f;
                return fabsf(u) <= 0.9f * t;
            }
            case ARROW_UP:    return arrowShape(v, u);
            case ARROW_DOWN:  return arrowShape(-v, u);
            case ARROW_RIGHT: return arrowShape(-u, v);
            case ARROW_LEFT:  return arrowShape(u, v);
            case STAR:        return starN(u, v, r2, 5, 0.95f, 0.40f);
            case SPARKLE4:    return starN(u, v, r2, 4, 0.98f, 0.12f); // sharp 4-point twinkle
            case LIGHTNING: { // zig-zag bolt
                float th = 0.13f;
                return segDist(u, v, 0.20f, -0.85f, -0.25f, 0.0f) <= th ||
                       segDist(u, v, -0.25f, 0.0f, 0.25f, 0.0f) <= th ||
                       segDist(u, v, 0.25f, 0.0f, -0.20f, 0.85f) <= th;
            }
            case CRESCENT: {  // moon: big disc minus an offset disc (opening right)
                bool body = r2 <= 0.88f * 0.88f;
                float ox = u - 0.42f, oy = v + 0.12f;
                bool bite = ox * ox + oy * oy <= 0.80f * 0.80f;
                return body && !bite;
            }
            case SMILEY: {
                if (r2 > 0.92f * 0.92f) return false;
                float ex = 0.34f, ey = -0.25f, er = 0.14f;
                if ((u + ex) * (u + ex) + (v - ey) * (v - ey) <= er * er) return false;
                if ((u - ex) * (u - ex) + (v - ey) * (v - ey) <= er * er) return false;
                float md = sqrtf(u * u + (v - 0.05f) * (v - 0.05f));
                if (v > 0.12f && md >= 0.42f && md <= 0.58f) return false;
                return true;
            }
            case HEART:
            default: {        // classic implicit heart; scaled+shifted so the lobes aren't clipped
                float x = u * 1.3f, y = -v * 1.3f + 0.15f;
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
        float speed      = getFloat(parameters, 0, 1.5f);   // glyphs per second (0 = freeze)
        int   chosen     = getInt(parameters, 1, 0);        // Glyph selector (used when frozen)
        float hue        = getFloat(parameters, 2, 40.0f);
        float saturation = getFloat(parameters, 3, 255.0f);

        int idx;
        if (speed > 0.0f) {
            idx = (int)((timestampMs * 0.001f) * speed) % GLYPH_COUNT;
            if (idx < 0) idx += GLYPH_COUNT;
        } else {
            idx = chosen % GLYPH_COUNT;
            if (idx < 0) idx += GLYPH_COUNT;
        }

        CRGB on = CHSV((uint8_t)hue, (uint8_t)saturation, 255);

        // On small matrices, antialiasing turns thin glyphs into faded blobs, so threshold
        // to hard on/off there; supersample for smooth edges only when there's room.
        uint32_t minDim = (width < height) ? width : height;
        bool crisp = minDim < 12;
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
                float frac = (float)hits / (float)(SS * SS);
                int s = crisp ? (frac >= 0.5f ? 255 : 0) : (int)(frac * 255.0f + 0.5f);
                if (!crisp && s == 0 && hits > 0) s = 1;
                outputBuffer[y * width + x] = CRGB((on.r * s) / 255, (on.g * s) / 255, (on.b * s) / 255);
            }
        }
    }

    const char* getName() const override { return "symbol"; }
    const char* getDisplayName() const override { return "Symbol"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Cycle (glyphs/sec, 0=freeze)", ParameterInfo::FLOAT, 1.5f, 0.0f, 5.0f),
            ParameterInfo("glyph", "Glyph (when frozen)", ParameterInfo::SELECT, 0,
                std::vector<std::string>{ "Heart", "Smiley", "Star", "Diamond", "Square",
                                          "Circle", "Ring", "Plus", "X", "Triangle",
                                          "Arrow Up", "Arrow Right", "Arrow Down", "Arrow Left",
                                          "Lightning", "Crescent", "Sparkle" }),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 40.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(SymbolOperator);
