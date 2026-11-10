#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Pinwheel - N arms radiating from a centre, spinning, optionally twisted into a spiral.
// Arms alternate between colour and black (or sweep the colour wheel), with a soft edge.
class PinwheelOperator : public BaseOperator {
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        int arms = getInt(p, 0, 6);
        if (arms < 1) arms = 1;
        float speed = getFloat(p, 1, 0.25f);     // turns per second
        float twist = getFloat(p, 2, 0.0f);      // turns per unit radius
        float width01 = getFloat(p, 3, 0.5f);    // arm width as a fraction of its slot
        float softness = getFloat(p, 4, 0.15f);
        float hue = getFloat(p, 5, 0.0f);
        float hueSpread = getFloat(p, 6, 255.0f);
        float sat = getFloat(p, 7, 255.0f);
        float ox = getFloat(p, 8, 0.0f), oy = getFloat(p, 9, 0.0f);
        float turn = advancePhase(deltaTimeMs, speed);
        float soft = softness * 0.5f + 0.001f;
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float u = f.u(x) - ox, v = f.v(y) - oy;
                float r = sqrtf(u * u + v * v);
                float a = atan2f(v, u) / OpUtil::TAU_F;              // turns, -0.5..0.5
                float s = (a - turn + twist * r) * (float)arms;      // arm coordinate
                float local = OpUtil::fract(s);                      // 0..1 across one slot
                float d = fabsf(local - 0.5f);                       // 0 at the arm centre
                float m = 1.0f - OpUtil::smooth(width01 * 0.5f - soft, width01 * 0.5f + soft, d);
                float armIdx = floorf(s);
                uint8_t h = (uint8_t)((int)(hue + OpUtil::fract(armIdx / (float)arms) * hueSpread) & 255);
                out[(size_t)y * width + x] = CHSV(h, (uint8_t)sat, OpUtil::to8(m));
            }
        }
    }
    const char* getName() const override { return "pinwheel"; }
    const char* getDisplayName() const override { return "Pinwheel"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("arms", "Arms", ParameterInfo::INT, 6, 1, 24),
            ParameterInfo("speed", "Spin (turns/sec)", ParameterInfo::FLOAT, 0.25f, -3.0f, 3.0f),
            ParameterInfo("twist", "Twist", ParameterInfo::FLOAT, 0.0f, -3.0f, 3.0f),
            ParameterInfo("width", "Arm width", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("softness", "Softness", ParameterInfo::FLOAT, 0.15f, 0.0f, 1.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("hue_spread", "Hue spread", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("x", "Centre X", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("y", "Centre Y", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f)
        };
    }
};
REGISTER_OPERATOR(PinwheelOperator);
