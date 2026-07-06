#pragma once

#include "BaseOperator.h"
#include "text_fonts.h"
#include <string>
#include <cmath>

// Text - renders a string with a bitmap font, static or scrolling. Picks the largest font
// that fits the display height (Spleen 5x8 / 8x16 / 16x32), so it's crisp at any size with
// no upscaling. Glyphs are threshold-rendered (no AA) — sharp on small matrices.
class TextOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        if (width == 0 || height == 0) return;
        std::string text = getString(parameters, 0, "ChromaBay");
        bool scroll      = getBool(parameters, 1, true);
        float speed      = getFloat(parameters, 2, 15.0f);   // pixels per second
        uint8_t hue      = (uint8_t)getFloat(parameters, 3, 0.0f);
        uint8_t sat      = (uint8_t)getFloat(parameters, 4, 255.0f);

        for (uint32_t i = 0; i < width * height; i++) outputBuffer[i] = CRGB::Black;
        if (text.empty()) return;
        if (text.size() > 255) text.resize(255);

        // Pick the largest font whose height fits; floor to the 5x8 (clipped on tiny displays).
        const TextFonts::BitmapFont* f = &TextFonts::FONT_5x8;
        if (height >= TextFonts::FONT_16x32.h) f = &TextFonts::FONT_16x32;
        else if (height >= TextFonts::FONT_8x16.h) f = &TextFonts::FONT_8x16;
        const int fw = f->w, fh = f->h, bpr = f->bytesPerRow;
        const int advance = fw;                              // Spleen cell already includes side spacing
        const int textW = (int)text.size() * advance;
        const int vOff = ((int)height - fh) / 2;             // vertical centre

        // Horizontal start x of the text's left edge (screen coords).
        int startX;
        if (scroll) {
            const int span = textW + (int)width;             // travel one full text width + a screen
            float off = fmodf((float)timestampMs * 0.001f * speed, (float)span);
            if (off < 0) off += span;
            startX = (int)width - (int)off;                  // enters from the right, moves left
        } else {
            startX = (textW <= (int)width) ? ((int)width - textW) / 2 : 0; // centre, else left-align
        }

        for (uint32_t y = 0; y < height; y++) {
            int ty = (int)y - vOff;
            if (ty < 0 || ty >= fh) continue;
            for (uint32_t x = 0; x < width; x++) {
                int tx = (int)x - startX;
                if (tx < 0 || tx >= textW) continue;
                int gi = tx / advance;                       // which character
                int col = tx % advance;                      // column within the cell
                if (col >= fw) continue;                     // (spacing gap, if advance > fw)
                unsigned char ch = (unsigned char)text[gi];
                if (ch < TextFonts::FIRST_CHAR || ch >= TextFonts::FIRST_CHAR + TextFonts::NUM_GLYPHS) continue;
                int g = ch - TextFonts::FIRST_CHAR;
                uint8_t byte = f->data[(size_t)(g * fh + ty) * bpr + (col >> 3)];
                if (byte & (0x80 >> (col & 7))) outputBuffer[(size_t)y * width + x] = CHSV(hue, sat, 255);
            }
        }
    }

    const char* getName() const override { return "text"; }
    const char* getDisplayName() const override { return "Text"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("text", "Text", ParameterInfo::STRING, ParameterValue(std::string("ChromaBay"))),
            ParameterInfo("scroll", "Scroll", ParameterInfo::BOOL, ParameterValue(true)),
            ParameterInfo("speed", "Speed (px/s)", ParameterInfo::FLOAT, 15.0f, 0.0f, 100.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(TextOperator);
