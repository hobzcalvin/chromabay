#pragma once
#include "BaseOperator.h"

// Solid Color - every pixel one color. The constant you reach for when building effects by
// hand: the second input of a Blend (tint, multiply down, add a floor), the color behind a
// Shape, or something to automate.
class SolidOperator : public BaseOperator {
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t, uint32_t, const std::vector<ParameterValue>& p) override {
        CRGB c = getColor(p, 0, CRGB(255, 120, 0));
        float bri = getFloat(p, 1, 1.0f);
        if (bri < 0) bri = 0; if (bri > 1) bri = 1;
        c.nscale8_video((uint8_t)(bri * 255.0f + 0.5f));
        uint32_t n = width * height;
        for (uint32_t i = 0; i < n; i++) out[i] = c;
    }
    const char* getName() const override { return "solid"; }
    const char* getDisplayName() const override { return "Solid Color"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("color", "Color", ParameterInfo::COLOR, CRGB(255, 120, 0)),
            ParameterInfo("brightness", "Brightness", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f)
        };
    }
};
REGISTER_OPERATOR(SolidOperator);
