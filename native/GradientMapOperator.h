#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Gradient Map - recolors the input by brightness: black maps to the first color, mid-grey
// to the middle one, white to the last (a "colorama" with chosen colors). Turns any grey
// source (Oscillator, Voronoi distance, Threshold, noise) into a palette, or re-themes a
// colored pattern. Shift cycles the map so the colors flow through the image.
class GradientMapOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        CRGB c0 = getColor(p, 0, CRGB(0, 0, 40));
        CRGB c1 = getColor(p, 1, CRGB(255, 0, 120));
        CRGB c2 = getColor(p, 2, CRGB(255, 220, 80));
        float shift = getFloat(p, 3, 0.0f);   // cycles per second
        bool wrap = getBool(p, 4, false);     // wrap the ends together (needed for smooth shifting)
        float ph = advancePhase(deltaTimeMs, shift);
        CRGB lut[256];
        for (int i = 0; i < 256; i++) {
            float t = (float)i / 255.0f + ph;
            if (wrap || shift != 0.0f) { t = OpUtil::fract(t); t = t < 0.5f ? t * 2.0f : 2.0f - t * 2.0f; }
            t = OpUtil::clamp01(t);
            CRGB a, b; float k;
            if (t < 0.5f) { a = c0; b = c1; k = t * 2.0f; } else { a = c1; b = c2; k = t * 2.0f - 1.0f; }
            lut[i] = CRGB((uint8_t)(a.r + (b.r - a.r) * k), (uint8_t)(a.g + (b.g - a.g) * k), (uint8_t)(a.b + (b.b - a.b) * k));
        }
        for (uint32_t i = 0; i < n; i++) out[i] = lut[OpUtil::to8(OpUtil::luma(in1[i]))];
    }
    const char* getName() const override { return "gradmap"; }
    const char* getDisplayName() const override { return "Gradient Map"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("dark", "Dark color", ParameterInfo::COLOR, CRGB(0, 0, 40)),
            ParameterInfo("mid", "Mid color", ParameterInfo::COLOR, CRGB(255, 0, 120)),
            ParameterInfo("light", "Light color", ParameterInfo::COLOR, CRGB(255, 220, 80)),
            ParameterInfo("shift", "Shift (/sec)", ParameterInfo::FLOAT, 0.0f, -2.0f, 2.0f),
            ParameterInfo("mirror", "Mirror ends", ParameterInfo::BOOL, false)
        };
    }
};
REGISTER_OPERATOR(GradientMapOperator);
