#pragma once

#include "BaseOperator.h"
#include <cmath>

// Color Grade - pass an image through a "film/Instagram filter" look. Pick a grade
// type and blend it in by amount. e.g. feed a full-saturation rainbow and get a warm
// 70s palette out. Stateless: input -> graded output.
class ColorGradeOperator : public BaseOperator {
private:
    inline uint8_t clamp255(float v) const { return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v); }
    inline uint8_t lerp8(uint8_t a, uint8_t b, float t) const { return clamp255(a + (b - a) * t); }

    // Map one pixel through the selected grade.
    CRGB grade(CRGB c, int type) const {
        float r = c.r, g = c.g, b = c.b;
        float luma = 0.299f * r + 0.587f * g + 0.114f * b;
        switch (type) {
            case 0: // Warm — push toward orange, cool down blues
                return CRGB(clamp255(r * 1.12f + 12), clamp255(g * 1.04f), clamp255(b * 0.82f));
            case 1: // Cool — push toward blue
                return CRGB(clamp255(r * 0.82f), clamp255(g * 1.02f), clamp255(b * 1.14f + 12));
            case 2: { // 70s — warm, muted, lifted; mix each channel toward a tan midpoint
                float t = 0.45f;
                float rr = r * (1.0f - t) + (luma * 0.55f + 100.0f) * t;
                float gg = g * (1.0f - t) + (luma * 0.50f + 70.0f) * t;
                float bb = b * (1.0f - t) + (luma * 0.35f + 35.0f) * t;
                return CRGB(clamp255(rr * 1.05f), clamp255(gg), clamp255(bb * 0.9f));
            }
            case 3: // Sepia (classic matrix)
                return CRGB(clamp255(0.393f * r + 0.769f * g + 0.189f * b),
                            clamp255(0.349f * r + 0.686f * g + 0.168f * b),
                            clamp255(0.272f * r + 0.534f * g + 0.131f * b));
            case 4: // B&W (luma)
                return CRGB(clamp255(luma), clamp255(luma), clamp255(luma));
            case 5: { // Vintage / faded — lift blacks, reduce contrast, slight warm
                float lift = 24.0f, contrast = 0.78f;
                float rr = (r - 128.0f) * contrast + 128.0f + lift;
                float gg = (g - 128.0f) * contrast + 128.0f + lift * 0.8f;
                float bb = (b - 128.0f) * contrast + 128.0f + lift * 0.5f;
                return CRGB(clamp255(rr * 1.04f), clamp255(gg), clamp255(bb * 0.96f));
            }
            case 6: { // Neon — crush saturation up, lift value
                CHSV hsv = rgb2hsv_approximate(c);
                hsv.s = clamp255(hsv.s * 1.6f + 40);
                hsv.v = clamp255(hsv.v * 1.1f + 20);
                CRGB out = hsv;
                return out;
            }
            default:
                return c;
        }
    }

public:
    void render(
        CRGB* inputBuffer1,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        int type = getInt(parameters, 0, 0);
        float amount = getFloat(parameters, 1, 1.0f);
        if (amount < 0) amount = 0; if (amount > 1) amount = 1;
        uint32_t total = width * height;

        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t i = 0; i < total; i++) {
            CRGB in = inputBuffer1[i];
            CRGB gr = grade(in, type);
            outputBuffer[i] = CRGB(lerp8(in.r, gr.r, amount),
                                   lerp8(in.g, gr.g, amount),
                                   lerp8(in.b, gr.b, amount));
        }
    }

    const char* getName() const override { return "colorgrade"; }
    const char* getDisplayName() const override { return "Color Grade"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            // 0 Warm, 1 Cool, 2 70s, 3 Sepia, 4 B&W, 5 Vintage, 6 Neon
            ParameterInfo("type", "Look", ParameterInfo::INT, 0, 0, 6),
            ParameterInfo("amount", "Amount", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(ColorGradeOperator);
