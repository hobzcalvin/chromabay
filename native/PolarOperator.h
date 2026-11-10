#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Polar Warp - remaps between straight and round. "Tunnel" wraps the input's x around the
// centre and runs its y outward, so horizontal stripes become rings and vertical ones become
// spokes; Flow scrolls that outward for an endless tunnel. "Unwrap" is the inverse: it reads
// the input around a circle and lays it out flat (rings become rows).
class PolarOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        int mode = getInt(p, 0, 0);
        float repeat = getFloat(p, 1, 1.0f);      // times the input wraps around
        float twist = getFloat(p, 2, 0.0f);       // turns per unit radius
        float flow = getFloat(p, 3, 0.0f);        // outward scroll, input heights per second
        float spin = getFloat(p, 4, 0.0f);        // turns per second
        bool depth = getBool(p, 5, false);        // tunnel: log radius (perspective)
        float flowPh = advancePhase(deltaTimeMs, flow);
        // Spin integrates separately (advancePhase holds one phase per operator, used by Flow).
        float dt = (float)deltaTimeMs * 0.001f; if (dt < 0 || dt > 0.5f) dt = 0.016f;
        _spin += dt * spin;
        OpUtil::Frame f(width, height);
        float hx = f.cx * f.inv, hy = f.cy * f.inv;
        float rmax = sqrtf(hx * hx + hy * hy);
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float sx, sy;
                if (mode == 1) { // unwrap: output x = angle, output y = radius
                    float ang = ((float)x + 0.5f) / (float)width * OpUtil::TAU_F / (repeat > 0.01f ? repeat : 0.01f)
                                + _spin * OpUtil::TAU_F;
                    float r = ((float)y + 0.5f) / (float)height * rmax;
                    ang += twist * r * OpUtil::TAU_F;
                    sx = f.px(cosf(ang) * r); sy = f.py(sinf(ang) * r);
                    out[(size_t)y * width + x] = OpUtil::sample(in1, width, height, sx, sy, 0);
                } else {         // tunnel: angle -> input x, radius -> input y
                    float u = f.u(x), v = f.v(y);
                    float r = sqrtf(u * u + v * v);
                    float a = atan2f(v, u) / OpUtil::TAU_F + 0.5f + _spin + twist * r;
                    float rr = depth ? (r > 0.001f ? -logf(r) * 0.35f : 3.0f) : r / rmax;
                    sx = OpUtil::fract(a * repeat) * (float)width - 0.5f;
                    sy = OpUtil::fract(rr - flowPh) * (float)height - 0.5f;
                    out[(size_t)y * width + x] = OpUtil::sample(in1, width, height, sx, sy, 1);
                }
            }
        }
    }
    const char* getName() const override { return "polar"; }
    const char* getDisplayName() const override { return "Polar Warp"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("mode", "Mode", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Tunnel", "Unwrap" }),
            ParameterInfo("repeat", "Repeat", ParameterInfo::FLOAT, 1.0f, 0.25f, 8.0f),
            ParameterInfo("twist", "Twist", ParameterInfo::FLOAT, 0.0f, -2.0f, 2.0f),
            ParameterInfo("flow", "Flow", ParameterInfo::FLOAT, 0.0f, -2.0f, 2.0f),
            ParameterInfo("spin", "Spin (turns/sec)", ParameterInfo::FLOAT, 0.0f, -2.0f, 2.0f),
            ParameterInfo("depth", "Perspective", ParameterInfo::BOOL, false)
        };
    }
private:
    float _spin = 0.0f;
};
REGISTER_OPERATOR(PolarOperator);
