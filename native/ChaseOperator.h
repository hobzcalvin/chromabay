#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Chase operator - a moving bar that travels across the matrix at any angle and wraps
// toroidally. Angle 0 = horizontal (a vertical bar moving right); 90 = vertical, etc.
class ChaseOperator : public BaseOperator {
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
        float speed = getFloat(parameters, 0, 20.0f);
        float size = getFloat(parameters, 1, 10.0f);
        float hue = getFloat(parameters, 2, 0.0f);
        float saturation = getFloat(parameters, 3, 0.0f); // 0 = white
        float value = getFloat(parameters, 4, 255.0f);
        float angle = getFloat(parameters, 5, 0.0f);       // degrees; travel direction

        uint32_t totalPixels = width * height;

        // Start with input buffer if available, otherwise clear to black
        if (inputBuffer1) {
            for (uint32_t i = 0; i < totalPixels; i++) outputBuffer[i] = inputBuffer1[i];
        } else {
            for (uint32_t i = 0; i < totalPixels; i++) outputBuffer[i] = CRGB::Black;
        }

        float timeInSeconds = timestampMs * 0.001f;
        float normalizedSpeed = speed / 100.0f;           // % of a full loop per second
        float phase = fmodf(timeInSeconds * normalizedSpeed, 1.0f);
        if (phase < 0.0f) phase += 1.0f;

        CHSV chase_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
        CRGB chase_color = chase_hsv;

        // Travel direction. A 1-row strip has no meaningful vertical axis, so force
        // horizontal there regardless of angle.
        float rad = angle * (float)M_PI / 180.0f;
        float dirX = (height <= 1) ? 1.0f : cosf(rad);
        float dirY = (height <= 1) ? 0.0f : sinf(rad);

        // Project pixels onto the direction. spanP = projection extent across the
        // matrix; minP shifts the projection so the smallest value is 0.
        float wf = (width > 0) ? (float)(width - 1) : 0.0f;
        float hf = (height > 0) ? (float)(height - 1) : 0.0f;
        float spanP = wf * fabsf(dirX) + hf * fabsf(dirY);
        if (spanP < 1.0f) spanP = 1.0f;
        float minP = (dirX < 0.0f ? wf * dirX : 0.0f) + (dirY < 0.0f ? hf * dirY : 0.0f);

        float barW = fmaxf(1.0f, (size / 100.0f) * spanP);
        float head = phase * spanP; // bar's leading edge along the projection

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float coord = (float)x * dirX + (float)y * dirY - minP; // 0..spanP
                float d = fmodf(coord - head, spanP);
                if (d < 0.0f) d += spanP;
                if (d < barW) outputBuffer[y * width + x] = chase_color;
            }
        }
    }

    const char* getName() const override { return "chase"; }
    const char* getDisplayName() const override { return "Chase"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 20.0f, 1.0f, 100.0f),
            ParameterInfo("size", "Size (%)", ParameterInfo::FLOAT, 10.0f, 1.0f, 50.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("angle", "Angle (deg)", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(ChaseOperator);