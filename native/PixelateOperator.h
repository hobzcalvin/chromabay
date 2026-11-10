#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"
#include <vector>

// Pixelate - snaps the input to a coarse grid of blocks, each filled with the average of the
// pixels it covers (or the centre sample). Block counts, not pixel sizes, so it looks the same
// at any resolution. Animate the counts for a "resolution" sweep.
class PixelateOperator : public BaseOperator {
    std::vector<uint32_t> _acc;
public:
    void render(CRGB* in1, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t, uint32_t, const std::vector<ParameterValue>& p) override {
        uint32_t n = width * height;
        if (!in1) { OpUtil::fillBlack(out, n); return; }
        int bx = getInt(p, 0, 8), by = getInt(p, 1, 8);
        bool average = getInt(p, 2, 0) == 0;
        if (bx < 1) bx = 1; if (by < 1) by = 1;
        if (bx > (int)width) bx = width; if (by > (int)height) by = height;
        size_t cells = (size_t)bx * by;
        _acc.assign(cells * 4, 0);
        for (uint32_t y = 0; y < height; y++) {
            int cy = (int)((uint64_t)y * by / height);
            for (uint32_t x = 0; x < width; x++) {
                int cx = (int)((uint64_t)x * bx / width);
                uint32_t* a = &_acc[((size_t)cy * bx + cx) * 4];
                const CRGB& c = in1[(size_t)y * width + x];
                a[0] += c.r; a[1] += c.g; a[2] += c.b; a[3]++;
            }
        }
        for (uint32_t y = 0; y < height; y++) {
            int cy = (int)((uint64_t)y * by / height);
            for (uint32_t x = 0; x < width; x++) {
                int cx = (int)((uint64_t)x * bx / width);
                CRGB c;
                if (average) {
                    uint32_t* a = &_acc[((size_t)cy * bx + cx) * 4];
                    uint32_t k = a[3] ? a[3] : 1;
                    c = CRGB((uint8_t)(a[0] / k), (uint8_t)(a[1] / k), (uint8_t)(a[2] / k));
                } else {
                    uint32_t sx = (uint32_t)(((float)cx + 0.5f) * width / bx);
                    uint32_t sy = (uint32_t)(((float)cy + 0.5f) * height / by);
                    if (sx >= width) sx = width - 1; if (sy >= height) sy = height - 1;
                    c = in1[(size_t)sy * width + sx];
                }
                out[(size_t)y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "pixelate"; }
    const char* getDisplayName() const override { return "Pixelate"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("blocksX", "Blocks X", ParameterInfo::INT, 8, 1, 64),
            ParameterInfo("blocksY", "Blocks Y", ParameterInfo::INT, 8, 1, 64),
            ParameterInfo("fill", "Fill", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Average", "Centre sample" })
        };
    }
};
REGISTER_OPERATOR(PixelateOperator);
