#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Threshold - splits the input by brightness at a level, with an adjustable soft edge (after
// hydra's thresh() and luma()). "White / black" turns anything into a hard mask; "Keep color"
// is a luma key that keeps the bright parts in their own colors and drops the rest.
class ThresholdOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t, uint32_t, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        float level = getFloat(p, 0, 0.5f);
        float soft = getFloat(p, 1, 0.05f);
        int mode = getInt(p, 2, 0);
        bool invert = getBool(p, 3, false);
        for (uint32_t i = 0; i < n; i++) {
            float m = OpUtil::smooth(level - soft * 0.5f, level + soft * 0.5f + 0.0001f, OpUtil::luma(in1[i]));
            if (invert) m = 1.0f - m;
            uint8_t s = OpUtil::to8(m);
            if (mode == 1) { CRGB c = in1[i]; c.nscale8_video(s); out[i] = s ? c : CRGB::Black; }
            else out[i] = CRGB(s, s, s);
        }
    }
    const char* getName() const override { return "threshold"; }
    const char* getDisplayName() const override { return "Threshold"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("level", "Level", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("softness", "Softness", ParameterInfo::FLOAT, 0.05f, 0.0f, 1.0f),
            ParameterInfo("mode", "Output", ParameterInfo::SELECT, 0, std::vector<std::string>{ "White / black", "Keep color" }),
            ParameterInfo("invert", "Invert", ParameterInfo::BOOL, false)
        };
    }
};
REGISTER_OPERATOR(ThresholdOperator);
