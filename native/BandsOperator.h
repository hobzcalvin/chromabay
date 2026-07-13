#pragma once

#include "BaseOperator.h"
#include "Modulation.h"   // hash01 — per-band randomness (identical on WASM + firmware)
#include <cmath>

// Bands - several coloured stripes, each with its own hue, width, direction and speed, sweeping
// across the display and screen-blending where they cross. Motion is either Scroll (bands pass
// through and wrap) or Bounce (back and forth, so they linger). Spread controls turn it from
// parallel marching bars into a criss-cross of colours moving at all different angles. This is
// the "moving bands" idea — where Interference is a static moiré field, this is overt motion.
class BandsOperator : public BaseOperator {
    static constexpr float kTwoPi = 6.28318530718f;
    static inline uint8_t screen(uint8_t a, uint8_t b) { return (uint8_t)(255 - (255 - a) * (255 - b) / 255); }
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& params
    ) override {
        int count        = getInt(params, 0, 5);
        float widthFrac  = getFloat(params, 1, 0.15f);  // band width, fraction of the sweep axis
        float speed      = getFloat(params, 2, 25.0f);  // %/sec
        int motion       = getInt(params, 3, 0);        // 0 Scroll, 1 Bounce
        float baseAngle  = getFloat(params, 4, 90.0f);  // deg (90 = vertical bands, moving sideways)
        float spread     = getFloat(params, 5, 0.0f);   // 0 = parallel, 1 = every band its own angle
        uint8_t sat      = (uint8_t)getInt(params, 6, 255);
        // Baked-in variety (were separate sliders — trimmed as excessive): fixed seed + modest
        // per-band speed/width variation so the bands don't all march in lockstep.
        const uint32_t seed = 1u;
        const float speedSpread = 0.4f, widthSpread = 0.3f;

        if (count < 1) count = 1;
        if (count > 16) count = 16;
        uint32_t total = width * height;
        for (uint32_t i = 0; i < total; i++) out[i] = CRGB::Black;

        const float wf = (width > 0) ? (float)(width - 1) : 0.0f;
        const float hf = (height > 0) ? (float)(height - 1) : 0.0f;
        const float t = advancePhase(deltaTimeMs, speed * 0.01f); // cycles at base speed (smooth)

        for (int i = 0; i < count; i++) {
            uint8_t hue = (uint8_t)(255.0f * (float)i / (float)count); // hues spread round the wheel
            float aRnd = Modulation::hash01((uint32_t)(i * 4 + 1), seed);
            float ang = (baseAngle + spread * (aRnd * 360.0f - 180.0f)) * (kTwoPi / 360.0f);
            float dx = cosf(ang), dy = sinf(ang);
            float span = wf * fabsf(dx) + hf * fabsf(dy); if (span < 1.0f) span = 1.0f;
            float minP = (dx < 0 ? wf * dx : 0.0f) + (dy < 0 ? hf * dy : 0.0f);
            float spd = 1.0f + speedSpread * (Modulation::hash01((uint32_t)(i * 4 + 2), seed) * 2.0f - 1.0f);
            float wid = widthFrac * (1.0f + widthSpread * (Modulation::hash01((uint32_t)(i * 4 + 3), seed) * 2.0f - 1.0f));
            if (wid < 0.01f) wid = 0.01f;
            float phase = Modulation::hash01((uint32_t)(i * 4 + 0), seed);
            float m = t * spd + phase;
            float frac = m - floorf(m);
            float center = (motion == 1) ? (1.0f - fabsf(2.0f * frac - 1.0f)) : frac; // bounce vs scroll
            float halfW = wid * 0.5f;
            CRGB col = CHSV(hue, sat, 255);

            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    float p = ((float)x * dx + (float)y * dy - minP) / span; // 0..1 along the axis
                    float d = fabsf(p - center);
                    if (motion == 0 && d > 0.5f) d = 1.0f - d; // wrap distance (scroll is periodic)
                    if (d <= halfW) {
                        float b = 1.0f - d / halfW; // triangular profile: bright centre, faded edges
                        size_t idx = (size_t)y * width + x;
                        CRGB& o = out[idx];
                        o.r = screen(o.r, (uint8_t)(col.r * b));
                        o.g = screen(o.g, (uint8_t)(col.g * b));
                        o.b = screen(o.b, (uint8_t)(col.b * b));
                    }
                }
            }
        }
    }

    const char* getName() const override { return "bands"; }
    const char* getDisplayName() const override { return "Bands"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("count", "Bands", ParameterInfo::INT, 5, 1, 16),
            ParameterInfo("width", "Width", ParameterInfo::FLOAT, 0.15f, 0.02f, 1.0f),
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 25.0f, -200.0f, 200.0f),
            ParameterInfo("motion", "Motion", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Scroll", "Bounce" }),
            ParameterInfo("angle", "Angle", ParameterInfo::FLOAT, 90.0f, 0.0f, 360.0f),
            ParameterInfo("spread", "Spread", ParameterInfo::FLOAT, 0.0f, 0.0f, 1.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255)
        };
    }
};

REGISTER_OPERATOR(BandsOperator);
