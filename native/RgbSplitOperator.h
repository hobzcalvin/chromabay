#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// RGB Split - pulls the red and blue channels apart from green in opposite directions
// (chromatic aberration / hydra's shift()). Wobble swings the offset back and forth.
class RgbSplitOperator : public BaseOperator {
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        float amount = getFloat(p, 0, 0.06f);       // fraction of the long side
        float angle = getFloat(p, 1, 0.0f) * OpUtil::PI_F / 180.0f;
        float wobble = getFloat(p, 2, 0.0f);        // swings per second (0 = fixed)
        int edge = getInt(p, 3, 1);
        float ph = advancePhase(deltaTimeMs, wobble);
        float a = amount * (wobble != 0.0f ? sinf(ph * OpUtil::TAU_F) : 1.0f);
        OpUtil::Frame f(width, height);
        float dx = cosf(angle) * a / f.inv, dy = sinf(angle) * a / f.inv; // in pixels
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                CRGB r = OpUtil::sample(in1, width, height, (float)x - dx, (float)y - dy, edge);
                CRGB b = OpUtil::sample(in1, width, height, (float)x + dx, (float)y + dy, edge);
                out[(size_t)y * width + x] = CRGB(r.r, in1[(size_t)y * width + x].g, b.b);
            }
        }
    }
    const char* getName() const override { return "rgbsplit"; }
    const char* getDisplayName() const override { return "RGB Split"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 0.06f, 0.0f, 0.5f),
            ParameterInfo("angle", "Angle", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("wobble", "Wobble (/sec)", ParameterInfo::FLOAT, 0.0f, 0.0f, 5.0f),
            ParameterInfo("edge", "Edges", ParameterInfo::SELECT, 1, std::vector<std::string>{ "Clamp", "Wrap" })
        };
    }
};
REGISTER_OPERATOR(RgbSplitOperator);
