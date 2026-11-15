#pragma once

#include "BaseOperator.h"
#include "AudioReactive.h"
#include <cmath>

// Audio - turns the audio input (Audio::g_features) into an image, so every other node can use
// it: Blend → Multiply a pattern by Level to pulse it with the music, by Bass/Mid/Treble to
// drive each color channel from its band, Gradient Map a Spectrum to color it, Threshold the
// Beat into flashes, Polar Warp the Bars into a radial analyzer, or Feedback (Drift Y) a
// Spectrum into a scrolling waterfall. Grey modes are tinted by Color (white = plain grey).
class AudioOperator : public BaseOperator {
public:
    enum Mode { LEVEL = 0, RGB_BANDS = 1, SPECTRUM = 2, BARS = 3, BEAT = 4 };
    enum Axis { HORIZONTAL = 0, VERTICAL = 1, CENTER = 2 };

    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& params
    ) override {
        if (width == 0 || height == 0) return;
        int mode    = getInt(params, 0, SPECTRUM);
        int axis    = getInt(params, 1, HORIZONTAL);
        float gain  = getFloat(params, 2, 1.0f);
        CRGB color  = getColor(params, 3, CRGB(255, 255, 255));
        bool peaks  = getBool(params, 4, true);
        const Audio::Features& f = Audio::get();
        const uint32_t total = width * height;

        auto tint = [&](float v) -> CRGB {
            v = Audio::clamp01(v);
            return CRGB((uint8_t)(color.r * v), (uint8_t)(color.g * v), (uint8_t)(color.b * v));
        };

        if (mode == LEVEL || mode == BEAT) {
            CRGB c = tint((mode == LEVEL ? f.volume : f.beat) * gain);
            for (uint32_t i = 0; i < total; i++) out[i] = c;
            return;
        }
        if (mode == RGB_BANDS) {
            CRGB c((uint8_t)(255.0f * Audio::clamp01(f.bass * gain)),
                   (uint8_t)(255.0f * Audio::clamp01(f.mid * gain)),
                   (uint8_t)(255.0f * Audio::clamp01(f.treble * gain)));
            for (uint32_t i = 0; i < total; i++) out[i] = c;
            return;
        }

        // Frequency runs along the chosen axis: low → high left-to-right, bottom-to-top, or
        // from the centre outwards (mirrored, along the long side).
        const bool vertical = axis == VERTICAL;
        const uint32_t freqLen = vertical ? height : width;
        const uint32_t barLen  = vertical ? width : height;
        auto freqPos = [&](uint32_t i) -> float {
            if (freqLen <= 1) return 0.0f;
            float p = (float)i / (float)(freqLen - 1);
            if (vertical) p = 1.0f - p;                  // low frequencies at the bottom
            if (axis == CENTER) p = fabsf(2.0f * p - 1.0f);
            return p;
        };

        // A 1-pixel-tall canvas (a strip) cannot show bar heights: show it as a spectrum.
        if (mode == SPECTRUM || barLen <= 1) {
            for (uint32_t fi = 0; fi < freqLen; fi++) {
                CRGB c = tint(Audio::bandAt(f, freqPos(fi)) * gain);
                for (uint32_t bi = 0; bi < barLen; bi++) {
                    uint32_t x = vertical ? bi : fi, y = vertical ? fi : bi;
                    out[y * width + x] = c;
                }
            }
            return;
        }

        // BARS: one bar per frequency position, growing from the bottom (or the left when
        // vertical), with a peak marker that falls back slowly.
        float dt = (float)deltaTimeMs * 0.001f;
        if (dt < 0.0f || dt > 0.5f) dt = 0.016f;
        for (int b = 0; b < Audio::kBands; b++) {
            float v = Audio::clamp01(f.bands[b] * gain);
            _peak[b] = v >= _peak[b] ? v : fmaxf(v, _peak[b] - dt * 0.6f);
        }
        const float L = (float)barLen;
        for (uint32_t fi = 0; fi < freqLen; fi++) {
            float p = freqPos(fi);
            float level = Audio::clamp01(Audio::bandAt(f, p) * gain) * L;
            float pk = peakAt(p) * L;
            int pkPix = (int)fminf(L - 1.0f, floorf(pk));
            for (uint32_t bi = 0; bi < barLen; bi++) {
                // d = distance from the bar's base, in pixels
                uint32_t d = vertical ? bi : (barLen - 1 - bi);
                float cover = Audio::clamp01(level - (float)d); // soft top pixel
                if (peaks && pk >= 1.0f && (int)d == pkPix && cover < 1.0f) cover = 1.0f;
                uint32_t x = vertical ? bi : fi, y = vertical ? fi : bi;
                out[y * width + x] = tint(cover);
            }
        }
    }

    const char* getName() const override { return "audio"; }
    const char* getDisplayName() const override { return "Audio"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("mode", "Show", ParameterInfo::SELECT, SPECTRUM,
                std::vector<std::string>{ "Level", "Bass/Mid/Treble → R/G/B", "Spectrum", "Bars", "Beat" }),
            ParameterInfo("axis", "Frequency axis", ParameterInfo::SELECT, HORIZONTAL,
                std::vector<std::string>{ "Horizontal", "Vertical", "Center out" }),
            ParameterInfo("gain", "Gain", ParameterInfo::FLOAT, 1.0f, 0.0f, 4.0f),
            ParameterInfo("color", "Color", ParameterInfo::COLOR, ParameterValue(CRGB(255, 255, 255))),
            ParameterInfo("peaks", "Peak markers", ParameterInfo::BOOL, ParameterValue(true))
        };
    }

private:
    float _peak[Audio::kBands] = {};
    float peakAt(float p) const {
        float x = Audio::clamp01(p) * (float)(Audio::kBands - 1);
        int i = (int)x; if (i >= Audio::kBands - 1) return _peak[Audio::kBands - 1];
        float t = x - (float)i;
        return _peak[i] + (_peak[i + 1] - _peak[i]) * t;
    }
};

REGISTER_OPERATOR(AudioOperator);
