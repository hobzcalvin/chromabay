#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Shape - one filled regular polygon (or circle) as a colour on black, with a soft edge.
// The plain mask source the graph was missing: multiply it with anything to cut that pattern
// to a shape, tile or kaleidoscope it, or displace it (after hydra's shape()).
class ShapeOperator : public BaseOperator {
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        int sides = getInt(p, 0, 0);                 // 0 = circle, else 3..12
        float radius = getFloat(p, 1, 0.4f);         // fraction of the long half-side
        float softness = getFloat(p, 2, 0.05f);
        float rot = getFloat(p, 3, 0.0f) * OpUtil::PI_F / 180.0f;
        float spin = getFloat(p, 4, 0.0f);           // degrees per second
        float ox = getFloat(p, 5, 0.0f), oy = getFloat(p, 6, 0.0f);
        CRGB color = getColor(p, 7, CRGB::White);
        bool outline = getBool(p, 8, false);
        rot += advancePhase(deltaTimeMs, spin) * OpUtil::PI_F / 180.0f;
        if (sides > 0 && sides < 3) sides = 3;
        float soft = softness > 0.001f ? softness : 0.001f;
        float lineW = radius * 0.15f + soft;
        OpUtil::Frame f(width, height);
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float u = f.u(x) - ox, v = f.v(y) - oy;
                float d; // signed distance-ish: <0 inside
                if (sides == 0) {
                    d = sqrtf(u * u + v * v) - radius;
                } else {
                    // Distance to a regular polygon via polar folding (Inigo Quilez style).
                    float a = atan2f(v, u) - rot + OpUtil::PI_F / (float)sides + OpUtil::PI_F * 0.5f; // a flat edge at the bottom
                    float seg = OpUtil::TAU_F / (float)sides;
                    float r = sqrtf(u * u + v * v);
                    float k = floorf(a / seg + 0.5f);
                    d = cosf(a - k * seg) * r - radius * cosf(seg * 0.5f);
                }
                float m = outline ? 1.0f - OpUtil::smooth(lineW - soft, lineW, fabsf(d))
                                  : 1.0f - OpUtil::smooth(-soft, soft, d);
                uint8_t s = OpUtil::to8(m);
                CRGB c = color;
                c.nscale8_video(s);
                out[(size_t)y * width + x] = s ? c : CRGB::Black;
            }
        }
    }
    const char* getName() const override { return "shape"; }
    const char* getDisplayName() const override { return "Shape"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("sides", "Sides (0 = circle)", ParameterInfo::INT, 0, 0, 12),
            ParameterInfo("radius", "Size", ParameterInfo::FLOAT, 0.4f, 0.0f, 2.0f),
            ParameterInfo("softness", "Softness", ParameterInfo::FLOAT, 0.05f, 0.0f, 1.0f),
            ParameterInfo("rotation", "Rotation", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("spin", "Spin (deg/sec)", ParameterInfo::FLOAT, 0.0f, -360.0f, 360.0f),
            ParameterInfo("x", "Centre X", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("y", "Centre Y", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("color", "Colour", ParameterInfo::COLOR, CRGB(255, 255, 255)),
            ParameterInfo("outline", "Outline only", ParameterInfo::BOOL, false)
        };
    }
};
REGISTER_OPERATOR(ShapeOperator);
