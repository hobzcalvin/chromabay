#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Kaleidoscope - folds the input around a centre into N mirrored wedges (after hydra's
// kaleid()). Every wedge shows the same slice of the input, mirrored at its edges so the
// seams match; Rotate turns the slice being sampled, Spin animates that.
class KaleidoscopeOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        int seg = getInt(p, 0, 6);
        if (seg < 1) seg = 1;
        float rot = getFloat(p, 1, 0.0f) / 360.0f;
        float spin = getFloat(p, 2, 0.0f);       // turns per second of the sampled slice
        float ox = getFloat(p, 3, 0.0f), oy = getFloat(p, 4, 0.0f);
        float zoom = getFloat(p, 5, 1.0f);
        float turn = rot + advancePhase(deltaTimeMs, spin);
        float wedge = OpUtil::TAU_F / (float)seg;
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float u = f.u(x) - ox, v = f.v(y) - oy;
                float r = sqrtf(u * u + v * v) / (zoom > 0.05f ? zoom : 0.05f);
                float a = atan2f(v, u);
                a = a - wedge * floorf(a / wedge);            // 0..wedge
                if (a > wedge * 0.5f) a = wedge - a;          // mirror: seams line up
                a += turn * OpUtil::TAU_F;
                // Sample the input around the display centre.
                float su = cosf(a) * r, sv = sinf(a) * r;
                out[(size_t)y * width + x] = OpUtil::sample(in1, width, height, f.px(su), f.py(sv), 0);
            }
        }
    }
    const char* getName() const override { return "kaleid"; }
    const char* getDisplayName() const override { return "Kaleidoscope"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("segments", "Segments", ParameterInfo::INT, 6, 1, 24),
            ParameterInfo("rotation", "Rotate", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("spin", "Spin (turns/sec)", ParameterInfo::FLOAT, 0.0f, -2.0f, 2.0f),
            ParameterInfo("x", "Centre X", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("y", "Centre Y", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("zoom", "Zoom", ParameterInfo::FLOAT, 1.0f, 0.1f, 4.0f)
        };
    }
};
REGISTER_OPERATOR(KaleidoscopeOperator);
