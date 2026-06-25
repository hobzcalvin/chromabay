#pragma once

#include "BaseOperator.h"
#include <cmath>

// Wave - traveling bands of a single colour at any angle. Generalizes the old Chase
// (hard moving bar) and Comet (bright head with a fading tail): each of the `bands`
// repeats has a width (`size`, % of its cell) and independent left/right edge fades.
//   - fadeLeft = fadeRight = 100%  -> a triangle wave (centre bright, fades both sides) [default]
//   - fadeLeft = fadeRight = 0%    -> hard-edged bars (Chase)
//   - fadeLeft = 0, fadeRight = 100% (1 band, big size) -> a comet (hard head, fading tail)
class WaveOperator : public BaseOperator {
    static constexpr float kTwoPi = 6.28318530718f;

    // Brightness within a band given signed position s in [-1,1] (0 = centre), with the
    // left/right fade fractions (0 = hard edge, 1 = fade all the way from centre to edge).
    static inline float bandBrightness(float s, float fadeL, float fadeR) {
        if (s < -1.0f || s > 1.0f) return 0.0f;
        float fade = (s < 0.0f) ? fadeL : fadeR;
        float d = fabsf(s);                 // 0 at centre .. 1 at edge
        if (fade <= 0.0f) return 1.0f;      // hard edge: full across the whole half
        float plateau = 1.0f - fade;        // bright region nearest the centre
        if (d <= plateau) return 1.0f;
        return 1.0f - (d - plateau) / fade; // linear ramp to 0 at the edge
    }

public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 30.0f);   // % of a loop per second
        float bands = getFloat(parameters, 1, 3.0f);    // repeats across the canvas
        float size = getFloat(parameters, 2, 100.0f);   // band width, % of its cell
        float fadeL = getFloat(parameters, 3, 100.0f) / 100.0f;
        float fadeR = getFloat(parameters, 4, 100.0f) / 100.0f;
        uint8_t hue = (uint8_t)getInt(parameters, 5, 160);
        uint8_t sat = (uint8_t)getInt(parameters, 6, 255);
        float angle = getFloat(parameters, 7, 0.0f);

        if (bands < 0.1f) bands = 0.1f;
        float halfSize = (size / 100.0f) * 0.5f; // half-width within a [0,1) cell
        if (halfSize <= 0.0f) halfSize = 0.001f;

        float rad = angle * (kTwoPi / 360.0f);
        float dx = (height <= 1) ? 1.0f : cosf(rad);
        float dy = (height <= 1) ? 0.0f : sinf(rad);
        float wf = (width > 0) ? (float)(width - 1) : 0.0f;
        float hf = (height > 0) ? (float)(height - 1) : 0.0f;
        float span = wf * fabsf(dx) + hf * fabsf(dy);
        if (span < 1.0f) span = 1.0f;
        float minP = (dx < 0 ? wf * dx : 0.0f) + (dy < 0 ? hf * dy : 0.0f);
        float phase = timestampMs * 0.001f * (speed / 100.0f);

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                float p = ((float)x * dx + (float)y * dy - minP) / span;   // 0..1 along axis
                float cell = (p - phase) * bands;                          // band coordinate
                float q = cell - floorf(cell);                             // 0..1 within cell
                float s = (q - 0.5f) / halfSize;                           // signed band pos
                float b = bandBrightness(s, fadeL, fadeR);
                outputBuffer[y * width + x] = CHSV(hue, sat, (uint8_t)(b * 255.0f));
            }
        }
    }

    const char* getName() const override { return "wave"; }
    const char* getDisplayName() const override { return "Wave"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 30.0f, -200.0f, 200.0f),
            ParameterInfo("bands", "Bands", ParameterInfo::FLOAT, 3.0f, 1.0f, 16.0f),
            ParameterInfo("size", "Size (%)", ParameterInfo::FLOAT, 100.0f, 1.0f, 100.0f),
            ParameterInfo("fadeLeft", "Fade Left (%)", ParameterInfo::FLOAT, 100.0f, 0.0f, 100.0f),
            ParameterInfo("fadeRight", "Fade Right (%)", ParameterInfo::FLOAT, 100.0f, 0.0f, 100.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 160, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 255, 0, 255),
            ParameterInfo("angle", "Angle (deg)", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f)
        };
    }
};

REGISTER_OPERATOR(WaveOperator);
