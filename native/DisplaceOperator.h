#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Displace - warps input 1 using input 2 as a map (hydra's modulate()). Each output pixel
// reads input 1 from somewhere else, offset by input 2 at that spot:
//   Vector: red pushes along x and green along y (mid-grey = no move), so an Oscillator or
//           noise makes ripples and liquid wobble;
//   Brightness: pushes outward from the centre by the map's brightness (a lens / bulge);
//   Rotate: turns the sample point about the centre by the map's brightness (a swirl).
class DisplaceOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* in2, CRGB* out, uint32_t width, uint32_t height,
                uint32_t, uint32_t, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        if (!in2) { OpUtil::copy(in1, out, n); return; }
        float amount = getFloat(p, 0, 0.2f);
        int mode = getInt(p, 1, 0);
        int edge = getInt(p, 2, 1);
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                size_t i = (size_t)y * width + x;
                const CRGB& m = in2[i];
                float u = f.u(x), v = f.v(y);
                float su = u, sv = v;
                if (mode == 1) {
                    float k = 1.0f - OpUtil::luma(m) * amount;
                    su = u * k; sv = v * k;
                } else if (mode == 2) {
                    float a = (OpUtil::luma(m) - 0.5f) * amount * OpUtil::TAU_F;
                    float ca = cosf(a), sa = sinf(a);
                    su = u * ca - v * sa; sv = u * sa + v * ca;
                } else {
                    su = u + ((float)m.r / 255.0f - 0.5f) * amount * 2.0f;
                    sv = v + ((float)m.g / 255.0f - 0.5f) * amount * 2.0f;
                }
                out[i] = OpUtil::sample(in1, width, height, f.px(su), f.py(sv), edge);
            }
        }
    }
    const char* getName() const override { return "displace"; }
    const char* getDisplayName() const override { return "Displace"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 0.2f, -2.0f, 2.0f),
            ParameterInfo("mode", "Mode", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Vector (R/G)", "Brightness (lens)", "Rotate (swirl)" }),
            ParameterInfo("edge", "Edges", ParameterInfo::SELECT, 1, std::vector<std::string>{ "Clamp", "Wrap" })
        };
    }
};
REGISTER_OPERATOR(DisplaceOperator);
