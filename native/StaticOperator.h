#pragma once

#include "BaseOperator.h"

// Static - TV-static random noise. Each pixel is reseeded every "frame" (rate set by
// Speed), mono or color, with an adjustable fill (fraction of pixels lit). Pure random
// energy to use raw or feed into the processing operators.
class StaticOperator : public BaseOperator {
    // Cheap integer hash -> 32-bit pseudo-random from (x, y, frame).
    static inline uint32_t hash3(uint32_t a, uint32_t b, uint32_t c) {
        uint32_t h = a * 374761393u + b * 668265263u + c * 2654435761u;
        h = (h ^ (h >> 13)) * 1274126177u;
        return h ^ (h >> 16);
    }
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 12.0f);  // reseeds per second
        bool colorMode = getBool(parameters, 1, false); // off = mono (grayscale), on = color
        float fill = getFloat(parameters, 2, 1.0f);    // 0..1 fraction lit
        if (fill < 0) fill = 0; if (fill > 1) fill = 1;

        uint32_t frame = (uint32_t)(timestampMs * 0.001f * speed);
        uint8_t fillThresh = (uint8_t)(fill * 255.0f);

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t hsh = hash3(x, y, frame);
                CRGB c;
                if ((hsh & 0xFF) > fillThresh) {
                    c = CRGB::Black;
                } else if (!colorMode) {
                    uint8_t g = (hsh >> 8) & 0xFF;
                    c = CRGB(g, g, g);
                } else {
                    uint8_t v = (uint8_t)(((hsh >> 16) & 0xFF) | 0x80); // keep it visible
                    c = CHSV((hsh >> 8) & 0xFF, 255, v);
                }
                outputBuffer[y * width + x] = c;
            }
        }
    }
    const char* getName() const override { return "static"; }
    const char* getDisplayName() const override { return "Static"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 12.0f, 0.0f, 60.0f),
            ParameterInfo("color", "Color", ParameterInfo::BOOL, false),
            ParameterInfo("fill", "Fill", ParameterInfo::FLOAT, 1.0f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(StaticOperator);
