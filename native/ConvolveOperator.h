#pragma once

#include "BaseOperator.h"
#include <vector>

// Convolve - a 3x3 kernel filter. One node covers a whole family of "funky" filters via
// presets (Sharpen / Edge Detect / Emboss / Outline), or a fully custom 3x3 kernel entered
// as 9 cells (k1..k9, row-major: the "boxes around the center"). `amount` mixes the result
// back over the original, so it doubles as strength.
//
// The center cell is k5 (index 4). Custom kernels are normalised by the sum of their weights
// (so a blur-ish kernel keeps brightness); a zero-sum kernel (edge/emboss-style) is left as-is.
class ConvolveOperator : public BaseOperator {
    std::vector<CRGB> _src; // snapshot of the input, so neighbour reads are correct even if in aliases out

    struct Kernel { float k[9]; float div; float bias; };
    Kernel presetFor(int preset, const std::vector<ParameterValue>& params) const {
        switch (preset) {
            case 1: return {{  0, -1,  0,  -1,  5, -1,   0, -1,  0 }, 1.0f,   0.0f}; // Sharpen
            case 2: return {{ -1, -1, -1,  -1,  8, -1,  -1, -1, -1 }, 1.0f,   0.0f}; // Edge Detect (8-neighbour Laplacian)
            case 3: return {{ -2, -1,  0,  -1,  1,  1,   0,  1,  2 }, 1.0f, 128.0f}; // Emboss (biased to mid-gray)
            case 4: return {{  0, -1,  0,  -1,  4, -1,   0, -1,  0 }, 1.0f,   0.0f}; // Outline (4-neighbour Laplacian)
            default: { // Custom (0): read k1..k9, normalise by sum unless it's ~0
                Kernel c; float sum = 0.0f;
                for (int i = 0; i < 9; i++) { c.k[i] = getFloat(params, 2 + i, i == 4 ? 1.0f : 0.0f); sum += c.k[i]; }
                c.div = (sum > 0.001f || sum < -0.001f) ? sum : 1.0f;
                c.bias = 0.0f;
                return c;
            }
        }
    }
    static inline uint8_t clamp8(float v) { return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)(v + 0.5f)); }

public:
    void render(
        CRGB* in1, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& params
    ) override {
        uint32_t total = width * height;
        if (!in1) { for (uint32_t i = 0; i < total; i++) out[i] = CRGB::Black; return; }

        int preset = getInt(params, 0, 2);
        float amount = getFloat(params, 1, 1.0f);
        if (amount < 0) amount = 0; if (amount > 1) amount = 1;

        const Kernel ker = presetFor(preset, params);
        const float inv = ker.div != 0.0f ? 1.0f / ker.div : 1.0f;

        // Snapshot the input so a 3x3 neighbourhood read is always the ORIGINAL, even when the
        // buffer system hands us the same lane for input and output (in-place convolution would
        // otherwise read pixels we've already overwritten).
        if (_src.size() != total) _src.resize(total);
        for (uint32_t i = 0; i < total; i++) _src[i] = in1[i];

        // Resolution-independent reach. A 3x3 kernel is defined in pixels, so on a high-res
        // display it would only touch immediate neighbours and its effect would shrink to a
        // hairline. Sample the 3x3 neighbourhood at a spacing (d px) that scales with the
        // display, anchored so a ~REF_DIM-pixel display uses the native 1px 3x3. Below that it
        // simply can't get finer than adjacent pixels (d stays 1).
        const int REF_DIM = 48;
        int base = (int)(width < height ? width : height);
        int d = (base + REF_DIM / 2) / REF_DIM; if (d < 1) d = 1; // round(base / REF_DIM)

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float r = 0, g = 0, b = 0;
                for (int ky = -1; ky <= 1; ky++) {
                    int yy = (int)y + ky * d; if (yy < 0) yy = 0; if (yy >= (int)height) yy = (int)height - 1;
                    for (int kx = -1; kx <= 1; kx++) {
                        int xx = (int)x + kx * d; if (xx < 0) xx = 0; if (xx >= (int)width) xx = (int)width - 1;
                        float w = ker.k[(ky + 1) * 3 + (kx + 1)];
                        const CRGB& c = _src[(size_t)yy * width + xx];
                        r += c.r * w; g += c.g * w; b += c.b * w;
                    }
                }
                r = r * inv + ker.bias; g = g * inv + ker.bias; b = b * inv + ker.bias;
                const CRGB& o = _src[(size_t)y * width + x];
                out[(size_t)y * width + x] = CRGB(
                    clamp8(o.r + (r - o.r) * amount),
                    clamp8(o.g + (g - o.g) * amount),
                    clamp8(o.b + (b - o.b) * amount));
            }
        }
    }

    const char* getName() const override { return "convolve"; }
    const char* getDisplayName() const override { return "Convolve"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("preset", "Preset", ParameterInfo::SELECT, 2,
                std::vector<std::string>{ "Custom", "Sharpen", "Edge Detect", "Emboss", "Outline" }),
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f),
            ParameterInfo("k1", "k1", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k2", "k2", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k3", "k3", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k4", "k4", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k5", "k5", ParameterInfo::FLOAT, 1.0f, -8.0f, 8.0f),
            ParameterInfo("k6", "k6", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k7", "k7", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k8", "k8", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f),
            ParameterInfo("k9", "k9", ParameterInfo::FLOAT, 0.0f, -8.0f, 8.0f)
        };
    }
};

REGISTER_OPERATOR(ConvolveOperator);
