#pragma once

#include "BaseOperator.h"
#include <cmath>

// Venn - three additive R/G/B circles orbiting the centre, so their overlaps sweep through
// cyan / magenta / yellow / white (the classic colour-mixing image behind every modifier's
// preview). It's a GENERATOR whose default actually MOVES — the circles orbit — unlike the
// static preview. Resolution-independent: sizes are fractions of the short side.
class VennOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& params
    ) override {
        float radius = getFloat(params, 0, 0.32f);   // circle radius, fraction of min(w,h)
        float orbit  = getFloat(params, 1, 0.18f);   // orbit radius, fraction
        float speed  = getFloat(params, 2, 20.0f);   // %/sec around the orbit
        uint8_t val  = (uint8_t)getInt(params, 3, 255);
        bool soft    = getBool(params, 4, false);    // feathered vs hard edges

        uint32_t total = width * height;
        for (uint32_t i = 0; i < total; i++) out[i] = CRGB::Black;
        const float base = (float)(width < height ? width : height);
        const float R = radius * base, R2 = R * R, orb = orbit * base;
        const float cx = width * 0.5f, cy = height * 0.5f;
        const float twoPi = 6.28318530718f;
        const float t = advancePhase(deltaTimeMs, speed * 0.01f); // cycles (smooth on speed change)

        // Three centres, 120° apart on the orbit. Each circle lights ONE channel, so overlaps
        // add naturally: R+G = yellow, all three = white.
        float ccx[3], ccy[3];
        for (int i = 0; i < 3; i++) {
            float a = t * twoPi + i * (twoPi / 3.0f);
            ccx[i] = cx + orb * cosf(a);
            ccy[i] = cy + orb * sinf(a);
        }

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint8_t rgb[3] = { 0, 0, 0 };
                for (int i = 0; i < 3; i++) {
                    float dx = (x + 0.5f) - ccx[i], dy = (y + 0.5f) - ccy[i];
                    float d2 = dx * dx + dy * dy;
                    if (soft) {
                        float e = 1.0f - sqrtf(d2) / R;
                        if (e > 0) { uint8_t v = (uint8_t)(e * val); if (v > rgb[i]) rgb[i] = v; }
                    } else if (d2 <= R2) {
                        rgb[i] = val;
                    }
                }
                out[(size_t)y * width + x] = CRGB(rgb[0], rgb[1], rgb[2]);
            }
        }
    }

    const char* getName() const override { return "venn"; }
    const char* getDisplayName() const override { return "Venn"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("radius", "Radius", ParameterInfo::FLOAT, 0.32f, 0.05f, 0.6f),
            ParameterInfo("orbit", "Orbit", ParameterInfo::FLOAT, 0.18f, 0.0f, 0.5f),
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 20.0f, -200.0f, 200.0f),
            ParameterInfo("brightness", "Brightness", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("soft", "Soft edges", ParameterInfo::BOOL, ParameterValue(false))
        };
    }
};

REGISTER_OPERATOR(VennOperator);
