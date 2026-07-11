#pragma once

#include "BaseOperator.h"
#include <vector>
#include <cmath>

// Blur - a low-pass filter with a variable radius. Separable (a horizontal pass then a
// vertical pass) so the cost is O(pixels · radius), not O(pixels · radius²). Box uses flat
// weights (fast, slightly boxy); Gaussian uses bell weights (smoother). `amount` mixes the
// blurred result back over the original, so it doubles as strength (and 0 = passthrough).
class BlurOperator : public BaseOperator {
    static constexpr int MAXR = 16; // cap kernel radius for perf; a big display × max radius clamps here
    std::vector<CRGB> _tmp;   // intermediate (horizontal-pass) buffer, reused across frames
    std::vector<float> _k;    // 1D kernel weights, rebuilt only when pixel radius/type change
    float _lastPx = -1.0f;
    int _lastType = -1;

    void buildKernel(int type, float px) {
        int R = (int)ceilf(px);
        if (R < 0) R = 0;
        if (R > MAXR) R = MAXR;
        _k.assign(2 * R + 1, 0.0f);
        float sum = 0.0f;
        if (type == 1) { // Gaussian
            float sigma = px > 0.01f ? px * 0.5f : 0.01f;
            for (int i = -R; i <= R; i++) { float w = expf(-(float)(i * i) / (2.0f * sigma * sigma)); _k[i + R] = w; sum += w; }
        } else {         // Box
            for (int i = -R; i <= R; i++) { _k[i + R] = 1.0f; sum += 1.0f; }
        }
        if (sum > 0.0f) for (float& w : _k) w /= sum;
    }

public:
    void render(
        CRGB* in1, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& params
    ) override {
        uint32_t total = width * height;
        if (!in1) { for (uint32_t i = 0; i < total; i++) out[i] = CRGB::Black; return; }

        int type = getInt(params, 0, 0);
        float radiusFrac = getFloat(params, 1, 0.12f);   // fraction of the display's short side
        float amount = getFloat(params, 2, 1.0f);
        if (amount < 0) amount = 0; if (amount > 1) amount = 1;
        // Resolution-independent: the blur reach is a fraction of the display, not a fixed pixel
        // count, so the SAME pattern looks the same on a 20px and a 200px display.
        float base = (float)(width < height ? width : height);
        float px = radiusFrac * base;
        int R = (int)ceilf(px);
        if (R > MAXR) R = MAXR;
        // Nothing to do → passthrough (also covers radius 0 / amount 0).
        if (R <= 0 || px <= 0.01f || amount <= 0.0f) { for (uint32_t i = 0; i < total; i++) out[i] = in1[i]; return; }

        if (px != _lastPx || type != _lastType) { buildKernel(type, px); _lastPx = px; _lastType = type; }
        if (_tmp.size() != total) _tmp.resize(total);

        // Horizontal pass: in1 → _tmp (edges clamp). Reads in1 only; safe even if in1 aliases out.
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float r = 0, g = 0, b = 0;
                for (int k = -R; k <= R; k++) {
                    int xx = (int)x + k; if (xx < 0) xx = 0; if (xx >= (int)width) xx = (int)width - 1;
                    const CRGB& c = in1[(size_t)y * width + xx]; float w = _k[k + R];
                    r += c.r * w; g += c.g * w; b += c.b * w;
                }
                _tmp[(size_t)y * width + x] = CRGB((uint8_t)(r + 0.5f), (uint8_t)(g + 0.5f), (uint8_t)(b + 0.5f));
            }
        }
        // Vertical pass: _tmp → out, mixing the blurred value back over the original by amount.
        // Reads in1 only at the SAME index it writes, so this stays correct even in-place.
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float r = 0, g = 0, b = 0;
                for (int k = -R; k <= R; k++) {
                    int yy = (int)y + k; if (yy < 0) yy = 0; if (yy >= (int)height) yy = (int)height - 1;
                    const CRGB& c = _tmp[(size_t)yy * width + x]; float w = _k[k + R];
                    r += c.r * w; g += c.g * w; b += c.b * w;
                }
                const CRGB& o = in1[(size_t)y * width + x];
                out[(size_t)y * width + x] = CRGB(
                    (uint8_t)(o.r + (r - o.r) * amount + 0.5f),
                    (uint8_t)(o.g + (g - o.g) * amount + 0.5f),
                    (uint8_t)(o.b + (b - o.b) * amount + 0.5f));
            }
        }
    }

    const char* getName() const override { return "blur"; }
    const char* getDisplayName() const override { return "Blur"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("type", "Type", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Box", "Gaussian" }),
            ParameterInfo("radius", "Radius", ParameterInfo::FLOAT, 0.12f, 0.0f, 1.0f),
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(BlurOperator);
