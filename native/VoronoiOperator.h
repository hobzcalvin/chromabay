#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"

// Voronoi - cellular noise: N seed points drift around the display and every pixel belongs to
// its nearest one. Show the cells as flat colours, as a distance field (bright at each seed),
// or as glowing borders between neighbours (after hydra's voronoi()). Seeds are a pure
// function of time, so the preview and every device agree.
class VoronoiOperator : public BaseOperator {
    static const int MAXN = 32;
public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        int n = getInt(p, 0, 10);
        if (n < 1) n = 1; if (n > MAXN) n = MAXN;
        float speed = getFloat(p, 1, 0.2f);
        int mode = getInt(p, 2, 0);              // 0 cells, 1 distance, 2 edges
        float hueSpread = getFloat(p, 3, 255.0f);
        float hueBase = getFloat(p, 4, 0.0f);
        float sat = getFloat(p, 5, 255.0f);
        float t = advancePhase(deltaTimeMs, speed);
        OpUtil::Frame f(width, height);
        float hx = f.cx * f.inv, hy = f.cy * f.inv; // visible half-extents; seeds live inside
        float sx[MAXN], sy[MAXN];
        for (int i = 0; i < n; i++) {
            // Each seed orbits its home on a Lissajous path with its own rates.
            float a = OpUtil::hash01(i * 7 + 1), b = OpUtil::hash01(i * 7 + 2);
            float ra = 0.5f + OpUtil::hash01(i * 7 + 3), rb = 0.5f + OpUtil::hash01(i * 7 + 4);
            sx[i] = (a * 2.0f - 1.0f) * hx + 0.35f * sinf(OpUtil::TAU_F * (t * ra + a));
            sy[i] = (b * 2.0f - 1.0f) * hy + 0.35f * cosf(OpUtil::TAU_F * (t * rb + b));
        }
        float cellScale = sqrtf((float)n);
        for (uint32_t y = 0; y < height; y++) {
            float v = f.v(y);
            for (uint32_t x = 0; x < width; x++) {
                float u = f.u(x);
                float d1 = 1e9f, d2 = 1e9f; int best = 0;
                for (int i = 0; i < n; i++) {
                    float dx = u - sx[i], dy = v - sy[i];
                    float d = dx * dx + dy * dy;
                    if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) d2 = d;
                }
                CRGB c;
                uint8_t hue = (uint8_t)((int)(hueBase + OpUtil::hash01(best * 7 + 5) * hueSpread) & 255);
                if (mode == 1) {
                    float val = 1.0f - OpUtil::clamp01(sqrtf(d1) * cellScale * 0.6f);
                    c = CHSV(hue, (uint8_t)sat, OpUtil::to8(val * val));
                } else if (mode == 2) {
                    float edge = sqrtf(d2) - sqrtf(d1);  // 0 on a border
                    float val = 1.0f - OpUtil::smooth(0.0f, 0.12f / cellScale + f.inv, edge);
                    c = CHSV(hue, (uint8_t)sat, OpUtil::to8(val));
                } else {
                    c = CHSV(hue, (uint8_t)sat, 255);
                }
                out[(size_t)y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "voronoi"; }
    const char* getDisplayName() const override { return "Voronoi"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("cells", "Cells", ParameterInfo::INT, 10, 1, 32),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 0.2f, -2.0f, 2.0f),
            ParameterInfo("mode", "Show", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Cells", "Distance", "Edges" }),
            ParameterInfo("hue_spread", "Hue spread", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("hue", "Base hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};
REGISTER_OPERATOR(VoronoiOperator);
