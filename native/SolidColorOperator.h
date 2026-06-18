#pragma once

#include "BaseOperator.h"

// Solid Color - fill the whole canvas with one HSV color. The simplest base layer.
class SolidColorOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        uint8_t hue = (uint8_t)getInt(parameters, 0, 0);
        uint8_t sat = (uint8_t)getInt(parameters, 1, 255);
        uint8_t val = (uint8_t)getInt(parameters, 2, 255);
        CRGB c = CHSV(hue, sat, val);
        uint32_t total = width * height;
        for (uint32_t i = 0; i < total; i++) outputBuffer[i] = c;
    }
    const char* getName() const override { return "solidcolor"; }
    const char* getDisplayName() const override { return "Solid Color"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 0, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("value", "Value", ParameterInfo::INT, 255, 0, 255)
        };
    }
};

REGISTER_OPERATOR(SolidColorOperator);
