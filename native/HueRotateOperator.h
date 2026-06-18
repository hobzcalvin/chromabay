#pragma once

#include "BaseOperator.h"

// Hue Rotate - spin every pixel's hue around the wheel over time (preserving saturation
// and value). Speed in hue-units/sec (256 = a full wheel); 0 = static shift by Offset.
class HueRotateOperator : public BaseOperator {
public:
    void render(
        CRGB* inputBuffer1,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 30.0f); // hue units per second
        int offset = getInt(parameters, 1, 0);
        uint32_t total = width * height;

        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        int shift = (int)(timestampMs * 0.001f * speed) + offset;
        uint8_t hShift = (uint8_t)(((shift % 256) + 256) % 256);

        for (uint32_t i = 0; i < total; i++) {
            CHSV hsv = rgb2hsv_approximate(inputBuffer1[i]);
            hsv.h = (uint8_t)(hsv.h + hShift);
            CRGB out = hsv;
            outputBuffer[i] = out;
        }
    }

    const char* getName() const override { return "huerotate"; }
    const char* getDisplayName() const override { return "Hue Rotate"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (hue/sec)", ParameterInfo::FLOAT, 30.0f, 0.0f, 255.0f),
            ParameterInfo("offset", "Offset", ParameterInfo::INT, 0, 0, 255)
        };
    }
};

REGISTER_OPERATOR(HueRotateOperator);
