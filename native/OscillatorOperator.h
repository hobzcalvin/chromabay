#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Oscillator - the most basic periodic source: a sine wave across the display, one per colour
// channel. With Colour offset 0 it is grey stripes; raising it phase-shifts R, G and B apart
// into rainbow-edged bands (after hydra's osc()). A building block: feed it to Threshold for
// hard stripes, to Displace as a warp field, or to Gradient Map to colour it.
class OscillatorOperator : public BaseOperator {
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        float freq = getFloat(p, 0, 4.0f);       // cycles across the display
        float speed = getFloat(p, 1, 0.5f);      // cycles per second
        float offset = getFloat(p, 2, 0.0f);     // R/G/B phase separation, in cycles
        float angle = getFloat(p, 3, 0.0f) * OpUtil::PI_F / 180.0f;
        int shape = getInt(p, 4, 0);             // 0 sine, 1 triangle, 2 saw, 3 square
        float phase = advancePhase(deltaTimeMs, speed);
        float ca = cosf(angle), sa = sinf(angle);
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            float v = f.v(y);
            for (uint32_t x = 0; x < width; x++) {
                // Position along the wave direction, 0..1 across the display's long side.
                float s = (f.u(x) * ca + v * sa) * 0.5f * freq - phase;
                out[(size_t)y * width + x] = CRGB(OpUtil::to8(wave(shape, s)),
                                                  OpUtil::to8(wave(shape, s + offset)),
                                                  OpUtil::to8(wave(shape, s + 2.0f * offset)));
            }
        }
    }
    static float wave(int shape, float s) {
        float t = OpUtil::fract(s);
        switch (shape) {
            case 1: return 1.0f - fabsf(2.0f * t - 1.0f);
            case 2: return t;
            case 3: return t < 0.5f ? 1.0f : 0.0f;
            default: return 0.5f + 0.5f * sinf(OpUtil::TAU_F * t);
        }
    }
    const char* getName() const override { return "osc"; }
    const char* getDisplayName() const override { return "Oscillator"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("frequency", "Frequency", ParameterInfo::FLOAT, 4.0f, 0.0f, 40.0f),
            ParameterInfo("speed", "Speed (cycles/sec)", ParameterInfo::FLOAT, 0.5f, -5.0f, 5.0f),
            ParameterInfo("offset", "Colour offset", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f),
            ParameterInfo("angle", "Angle", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("shape", "Shape", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Sine", "Triangle", "Saw", "Square" })
        };
    }
};
REGISTER_OPERATOR(OscillatorOperator);
