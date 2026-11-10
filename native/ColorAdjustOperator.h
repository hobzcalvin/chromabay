#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Colour Adjust - the per-pixel colour controls a grading tool has: brightness, contrast,
// saturation, gamma, and red/green/blue gains (after hydra's brightness/contrast/saturate/
// color). Gamma and the gains also make it a manual colour correction for a strip whose
// whites look tinted. A 256-entry table per channel keeps it cheap on the device.
class ColorAdjustOperator : public BaseOperator {
    uint8_t _lut[3][256];
    float _key[7] = { -1, -1, -1, -1, -1, -1, -1 };
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t, uint32_t, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        float bri = getFloat(p, 0, 0.0f);       // -1..1 added
        float con = getFloat(p, 1, 1.0f);       // around mid-grey
        float sat = getFloat(p, 2, 1.0f);       // 0 = grey, 2 = vivid
        float gamma = getFloat(p, 3, 1.0f);     // >1 darkens mids (LED-style), <1 lifts
        float gr = getFloat(p, 4, 1.0f), gg = getFloat(p, 5, 1.0f), gb = getFloat(p, 6, 1.0f);
        float key[7] = { bri, con, gamma, gr, gg, gb, 0 };
        bool dirty = false;
        for (int i = 0; i < 6; i++) if (key[i] != _key[i]) { dirty = true; _key[i] = key[i]; }
        if (dirty) {
            float gains[3] = { gr, gg, gb };
            float g = gamma > 0.05f ? gamma : 0.05f;
            for (int ch = 0; ch < 3; ch++) for (int v = 0; v < 256; v++) {
                float x = (float)v / 255.0f;
                x = (x - 0.5f) * con + 0.5f + bri;
                x = OpUtil::clamp01(x);
                x = powf(x, g) * gains[ch];
                _lut[ch][v] = OpUtil::to8(x);
            }
        }
        for (uint32_t i = 0; i < n; i++) {
            CRGB c = in1[i];
            if (sat != 1.0f) {
                float l = 0.299f * c.r + 0.587f * c.g + 0.114f * c.b;
                float r = l + (c.r - l) * sat, g2 = l + (c.g - l) * sat, b = l + (c.b - l) * sat;
                c = CRGB((uint8_t)(r < 0 ? 0 : r > 255 ? 255 : r), (uint8_t)(g2 < 0 ? 0 : g2 > 255 ? 255 : g2),
                         (uint8_t)(b < 0 ? 0 : b > 255 ? 255 : b));
            }
            out[i] = CRGB(_lut[0][c.r], _lut[1][c.g], _lut[2][c.b]);
        }
    }
    const char* getName() const override { return "coloradjust"; }
    const char* getDisplayName() const override { return "Colour Adjust"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("brightness", "Brightness", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("contrast", "Contrast", ParameterInfo::FLOAT, 1.0f, 0.0f, 4.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 1.0f, 0.0f, 3.0f),
            ParameterInfo("gamma", "Gamma", ParameterInfo::FLOAT, 1.0f, 0.2f, 4.0f),
            ParameterInfo("red", "Red gain", ParameterInfo::FLOAT, 1.0f, 0.0f, 2.0f),
            ParameterInfo("green", "Green gain", ParameterInfo::FLOAT, 1.0f, 0.0f, 2.0f),
            ParameterInfo("blue", "Blue gain", ParameterInfo::FLOAT, 1.0f, 0.0f, 2.0f)
        };
    }
};
REGISTER_OPERATOR(ColorAdjustOperator);
