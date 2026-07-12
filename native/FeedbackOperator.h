#pragma once

#include "BaseOperator.h"
#include <vector>
#include <cmath>

// Feedback - mixes the PREVIOUS output frame back in, optionally zoomed / rotated / shifted, so
// the graph gains memory (a unit delay). This is the "video feedback" primitive: trails, echoes,
// infinite zoom tunnels, spirals. Self-contained (no graph cycle) — it keeps its own copy of last
// frame. All motion is per-second and scaled by the real frame delta, so it looks the same at any
// frame rate; zoom/rotate/shift are relative, so it's resolution-independent too.
class FeedbackOperator : public BaseOperator {
    std::vector<CRGB> _prev;   // last frame's output (persists across frames)
    bool _have = false;

    // Bilinear sample of _prev at (fx,fy); black outside the canvas so new edges come from input.
    inline CRGB sample(float fx, float fy, uint32_t w, uint32_t h) const {
        if (fx < 0 || fy < 0 || fx > (float)(w - 1) || fy > (float)(h - 1)) return CRGB::Black;
        int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
        int x1 = x0 + 1 < (int)w ? x0 + 1 : x0;
        int y1 = y0 + 1 < (int)h ? y0 + 1 : y0;
        float tx = fx - x0, ty = fy - y0;
        const CRGB& a = _prev[(size_t)y0 * w + x0];
        const CRGB& b = _prev[(size_t)y0 * w + x1];
        const CRGB& c = _prev[(size_t)y1 * w + x0];
        const CRGB& d = _prev[(size_t)y1 * w + x1];
        auto lerp = [](uint8_t p, uint8_t q, float t) { return p + (q - p) * t; };
        float top_r = lerp(a.r, b.r, tx), bot_r = lerp(c.r, d.r, tx);
        float top_g = lerp(a.g, b.g, tx), bot_g = lerp(c.g, d.g, tx);
        float top_b = lerp(a.b, b.b, tx), bot_b = lerp(c.b, d.b, tx);
        return CRGB((uint8_t)(top_r + (bot_r - top_r) * ty),
                    (uint8_t)(top_g + (bot_g - top_g) * ty),
                    (uint8_t)(top_b + (bot_b - top_b) * ty));
    }
    static inline uint8_t clamp8(int v) { return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v); }

public:
    void render(
        CRGB* in1, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& params
    ) override {
        uint32_t total = width * height;
        float feedback = getFloat(params, 0, 0.90f);
        float zoom     = getFloat(params, 1, 1.0f);
        float rotate   = getFloat(params, 2, 0.0f);   // deg / sec
        float dx       = getFloat(params, 3, 0.0f);   // fraction of width / sec
        float dy       = getFloat(params, 4, 0.0f);   // fraction of height / sec
        int mode       = getInt(params, 5, 0);        // 0 Lighten, 1 Add, 2 Screen

        // Frame-rate independent: express the per-frame amounts from per-second params over dt.
        float dt = (float)deltaTimeMs * 0.001f;
        if (dt < 0.0f || dt > 0.5f) dt = 0.016f;
        float fb   = powf(feedback < 0 ? 0 : (feedback > 1 ? 1 : feedback), dt); // persistence/sec
        float Z    = powf(zoom > 0.01f ? zoom : 0.01f, dt);
        float rad  = rotate * dt * (float)M_PI / 180.0f;
        float txPx = dx * dt * (float)width;
        float tyPx = dy * dt * (float)height;

        if (!in1) { for (uint32_t i = 0; i < total; i++) out[i] = CRGB::Black; }
        else if (!_have || _prev.size() != total) {
            for (uint32_t i = 0; i < total; i++) out[i] = in1[i]; // first frame: just the input
        } else {
            float cx = width * 0.5f, cy = height * 0.5f;
            float cs = cosf(-rad), sn = sinf(-rad); // inverse rotation for back-sampling
            float invZ = 1.0f / Z;
            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    // Back-map this pixel into the previous frame (undo shift, rotate, zoom).
                    float px = (float)x - txPx - cx, py = (float)y - tyPx - cy;
                    float rx = px * cs - py * sn, ry = px * sn + py * cs;
                    CRGB fedC = sample(cx + rx * invZ, cy + ry * invZ, width, height);
                    int fr = (int)(fedC.r * fb), fg = (int)(fedC.g * fb), fb2 = (int)(fedC.b * fb);
                    const CRGB& ic = in1[(size_t)y * width + x];
                    CRGB o;
                    if (mode == 1) {        // Add
                        o = CRGB(clamp8(ic.r + fr), clamp8(ic.g + fg), clamp8(ic.b + fb2));
                    } else if (mode == 2) { // Screen
                        o = CRGB(255 - (255 - ic.r) * (255 - fr) / 255,
                                 255 - (255 - ic.g) * (255 - fg) / 255,
                                 255 - (255 - ic.b) * (255 - fb2) / 255);
                    } else {                // Lighten (max) — clean trails, no blowout
                        o = CRGB(ic.r > fr ? ic.r : fr, ic.g > fg ? ic.g : fg, ic.b > fb2 ? ic.b : fb2);
                    }
                    out[(size_t)y * width + x] = o;
                }
            }
        }

        // Remember this frame for the next one.
        if (_prev.size() != total) _prev.resize(total);
        for (uint32_t i = 0; i < total; i++) _prev[i] = out[i];
        _have = true;
    }

    const char* getName() const override { return "feedback"; }
    const char* getDisplayName() const override { return "Feedback"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("feedback", "Feedback", ParameterInfo::FLOAT, 0.90f, 0.0f, 1.0f),
            ParameterInfo("zoom", "Zoom /sec", ParameterInfo::FLOAT, 1.0f, 0.25f, 4.0f),
            ParameterInfo("rotate", "Rotate (deg/sec)", ParameterInfo::FLOAT, 0.0f, -360.0f, 360.0f),
            ParameterInfo("dx", "Drift X /sec", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("dy", "Drift Y /sec", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("mode", "Blend", ParameterInfo::SELECT, 0,
                std::vector<std::string>{ "Lighten", "Add", "Screen" })
        };
    }
};

REGISTER_OPERATOR(FeedbackOperator);
