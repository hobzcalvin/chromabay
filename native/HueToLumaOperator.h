#pragma once

#include "BaseOperator.h"

// Hue -> Grayscale (the reverse of Brightness → Rainbow). Each pixel's hue becomes its
// brightness: a full rainbow flattens to a grayscale ramp. `offset` rotates which hue
// maps to black; `invert` flips light/dark. Fully-desaturated (gray) input has an
// undefined hue, so it collapses toward black — feed it color.
class HueToLumaOperator : public BaseOperator {
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
        int offset = getInt(parameters, 0, 0);
        bool invert = getBool(parameters, 1, false);
        uint32_t total = width * height;

        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        for (uint32_t i = 0; i < total; i++) {
            CHSV hsv = rgb2hsv_approximate(inputBuffer1[i]);
            int g = ((hsv.h + offset) % 256 + 256) % 256;
            // Scale by saturation so near-gray pixels (no real hue) don't get a bogus level.
            g = (int)(g * (hsv.s / 255.0f));
            if (invert) g = 255 - g;
            uint8_t gray = (uint8_t)g;
            outputBuffer[i] = CRGB(gray, gray, gray);
        }
    }

    const char* getName() const override { return "huegray"; }
    const char* getDisplayName() const override { return "Hue → Grayscale"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("offset", "Hue Offset", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("invert", "Invert", ParameterInfo::BOOL, false)
        };
    }
};

REGISTER_OPERATOR(HueToLumaOperator);
