#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Quasicrystal - the sum of N plane waves at evenly spaced angles, each drifting in phase.
// Five or seven waves give endlessly non-repeating Penrose-like rosettes that slowly turn
// inside out. Rendered as brightness of one hue, or mapped round the color wheel.
class QuasicrystalOperator : public BaseOperator {
    static const int MAXW = 13;
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        int waves = getInt(p, 0, 7);
        if (waves < 1) waves = 1; if (waves > MAXW) waves = MAXW;
        float scale = getFloat(p, 1, 3.5f);     // wave crests across the display
        float speed = getFloat(p, 2, 0.3f);     // cycles per second
        int color = getInt(p, 3, 1);            // 0 mono, 1 rainbow
        float hue = getFloat(p, 4, 160.0f);
        float sat = getFloat(p, 5, 255.0f);
        float contrast = getFloat(p, 6, 1.0f);
        float phase = advancePhase(deltaTimeMs, speed) * OpUtil::TAU_F;
        float kx[MAXW], ky[MAXW];
        float k = scale * OpUtil::PI_F;
        for (int i = 0; i < waves; i++) {
            float a = OpUtil::PI_F * (float)i / (float)waves;
            kx[i] = cosf(a) * k; ky[i] = sinf(a) * k;
        }
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            float v = f.v(y);
            for (uint32_t x = 0; x < width; x++) {
                float u = f.u(x);
                float s = 0.0f;
                for (int i = 0; i < waves; i++) s += 0.5f + 0.5f * cosf(u * kx[i] + v * ky[i] + phase);
                // Folding the sum back into 0..1 (rather than averaging) is what makes the
                // interference rings, and it stays well spread for any wave count.
                float w = s - floorf(s);
                w = (floorf(s) == (float)((int)s & ~1)) ? w : 1.0f - w;
                if (contrast != 1.0f) w = OpUtil::clamp01((w - 0.5f) * contrast + 0.5f);
                CRGB c;
                if (color == 1) c = CHSV((uint8_t)((int)(hue + w * 255.0f) & 255), (uint8_t)sat, 255);
                else c = CHSV((uint8_t)hue, (uint8_t)sat, OpUtil::to8(w));
                out[(size_t)y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "quasicrystal"; }
    const char* getDisplayName() const override { return "Quasicrystal"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("waves", "Symmetry (waves)", ParameterInfo::INT, 7, 1, 13),
            ParameterInfo("scale", "Scale", ParameterInfo::FLOAT, 3.5f, 0.5f, 30.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 0.3f, -3.0f, 3.0f),
            ParameterInfo("color", "Color", ParameterInfo::SELECT, 1, std::vector<std::string>{ "One hue", "Rainbow" }),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 160.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("contrast", "Contrast", ParameterInfo::FLOAT, 1.0f, 0.2f, 4.0f)
        };
    }
};
REGISTER_OPERATOR(QuasicrystalOperator);
