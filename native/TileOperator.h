#pragma once

#include "BaseOperator.h"
#include <math.h>

// Tile - repeats the input across the matrix in a tilesX x tilesY grid; each tile shows
// the WHOLE input scaled to the cell. Uses float cell sizes so tiles stay equal even
// when the matrix size isn't divisible by the tile count (an integer-modulo version
// drifted into progressively narrower tiles). Pure transform; black if no input.
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

        float cellW = (float)width / (float)tilesX;
        float cellH = (float)height / (float)tilesY;

        int idx = 0;
        for (uint32_t y = 0; y < height; y++) {
            float ly = fmodf((float)y, cellH);              // position within this row's cell
            int sy = (int)(ly / cellH * (float)height);
            if (sy >= (int)height) sy = (int)height - 1;
            for (uint32_t x = 0; x < width; x++, idx++) {
                float lx = fmodf((float)x, cellW);
                int sx = (int)(lx / cellW * (float)width);
                if (sx >= (int)width) sx = (int)width - 1;
                outputBuffer[idx] = inputBuffer1[(uint32_t)sy * width + (uint32_t)sx];
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
