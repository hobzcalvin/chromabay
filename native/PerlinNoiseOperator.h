#pragma once

#include "BaseOperator.h"

// Perlin Noise operator - creates 2D noise patterns with multiple layers
class PerlinNoiseOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        float scale = getFloat(parameters, 0, 4.0f); // Noise scale
        float speed = getFloat(parameters, 1, 50.0f); // Animation speed
        float hue_base = getFloat(parameters, 2, 0.0f); // Base hue
        float hue_range = getFloat(parameters, 3, 60.0f); // Hue variation range
        float saturation = getFloat(parameters, 4, 255.0f);
        int octaves = getInt(parameters, 5, 1);          // fractal detail (1 = plain Perlin)
        float warp = getFloat(parameters, 6, 0.0f);      // domain warp: organic swirl/flow

        // Integrated time factor (smooth when speed changes; see BaseOperator::advancePhase).
        uint16_t time_factor = (uint16_t)fmodf(advancePhase(deltaTimeMs, speed * 10.0f), 65536.0f);

        // Scale factor for noise coordinates
        uint16_t noise_scale = (uint16_t)(scale * 1000.0f);
        // Domain-warp strength in noise units (sighack-style flow field): a low-frequency
        // noise vector displaces each sample point, bending the field into flowing curves.
        float warp_amt = warp * noise_scale * 0.5f;

        // Loop through all pixels
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;

                // Scale around the display CENTER (not the top-left corner), so changing Scale
                // zooms in/out about the middle. The center pixel always samples the same fixed
                // noise coordinate (32768); pixels fan out from there by ±0.5·noise_scale.
                float cx = (float)x - (float)width * 0.5f;
                float cy = (float)y - (float)height * 0.5f;
                float noise_x = 32768.0f + (cx / (float)width) * noise_scale;
                float noise_y = 32768.0f + (cy / (float)height) * noise_scale;

                if (warp_amt > 0.0f) {
                    // Displace the sample point by a slow, low-frequency noise vector.
                    float wx = (int)inoise8((uint16_t)(noise_x * 0.5f), (uint16_t)(noise_y * 0.5f), time_factor / 2) - 128;
                    float wy = (int)inoise8((uint16_t)(noise_x * 0.5f) + 32768, (uint16_t)(noise_y * 0.5f) + 32768, time_factor / 2) - 128;
                    noise_x += wx / 128.0f * warp_amt;
                    noise_y += wy / 128.0f * warp_amt;
                }

                // Generate noise value (fractal when octaves > 1)
                uint8_t noise_val = fbm8((uint32_t)noise_x, (uint32_t)noise_y, time_factor, octaves);

                // Map noise to hue
                float hue = hue_base + ((float)noise_val / 255.0f * hue_range);
                while (hue > 255.0f) hue -= 255.0f;
                while (hue < 0.0f) hue += 255.0f;

                // Full brightness: the noise drives HUE, not value. (A second noise layer
                // used to dim each pixel to 0.3..1.0, so it never looked fully lit even at
                // value=255 — that's why this looked dim vs. a plain noise->hue map.)
                CHSV hsv_color((uint8_t)hue, (uint8_t)saturation, 255);
                outputBuffer[index] = hsv_color;
            }
        }
    }
    
    const char* getName() const override {
        return "perlinnoise";
    }

    const char* getDisplayName() const override {
        return "Perlin Noise";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("scale", "Scale (cycles/display)", ParameterInfo::FLOAT, 4.0f, 1.0f, 20.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 50.0f, 0.0f, 200.0f),
            ParameterInfo("hue_base", "Base Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("hue_range", "Hue Range", ParameterInfo::FLOAT, 60.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("octaves", "Octaves", ParameterInfo::INT, 1, 1, 6),
            ParameterInfo("warp", "Warp", ParameterInfo::FLOAT, 0.0f, 0.0f, 2.0f)
        };
    }
};

REGISTER_OPERATOR(PerlinNoiseOperator); 