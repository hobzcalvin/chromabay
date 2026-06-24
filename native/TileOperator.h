#pragma once

#include "BaseOperator.h"

// Tile - repeats the input across the matrix tilesX x tilesY times (each tile is the
// whole input squeezed down). Pure transform of the input; black if no input.
class TileOperator : public BaseOperator {
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
        uint32_t total = width * height;
        if (!inputBuffer1) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }
        int tilesX = getInt(parameters, 0, 2);
        int tilesY = getInt(parameters, 1, 2);
        if (tilesX < 1) tilesX = 1;
        if (tilesY < 1) tilesY = 1;

        // Sampling the input at tilesX/tilesY frequency repeats it that many times.
        int idx = 0;
        for (uint32_t y = 0; y < height; y++) {
            uint32_t sy = (uint32_t)((y * (uint32_t)tilesY) % height);
            for (uint32_t x = 0; x < width; x++, idx++) {
                uint32_t sx = (uint32_t)((x * (uint32_t)tilesX) % width);
                outputBuffer[idx] = inputBuffer1[sy * width + sx];
            }
        }
    }

    const char* getName() const override { return "tile"; }
    const char* getDisplayName() const override { return "Tile"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("tilesX", "Tiles X", ParameterInfo::INT, 2, 1, 8),
            ParameterInfo("tilesY", "Tiles Y", ParameterInfo::INT, 2, 1, 8)
        };
    }
};

REGISTER_OPERATOR(TileOperator);
