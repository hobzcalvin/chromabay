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
        uint32_t /* timestampMs */, uint32_t deltaTimeMs,
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
        const int vOff = ((int)height - fh) / 2;             // vertical centre

        // Per-glyph advance: proportional fonts carry a widths[] table; monospace fonts (Spleen)
        // advance by the cell width. This is what makes spacing look right (r narrow, m wide).
        auto advOf = [&](unsigned char ch) -> int {
            int g = (int)ch - TextFonts::FIRST_CHAR;
            if (g < 0 || g >= TextFonts::NUM_GLYPHS) return 0;
            return f->widths ? (int)f->widths[g] : fw;
        };
        int textW = 0;
        for (size_t i = 0; i < text.size(); i++) textW += advOf((unsigned char)text[i]);

        int startX;
        if (scroll) {
            const int span = textW + (int)width;             // travel one full text width + a screen
            float off = fmodf(advancePhase(deltaTimeMs, speed), (float)span); // integrated: smooth speed changes
            if (off < 0) off += span;
            startX = (int)width - (int)off;                  // enters from the right, moves left
        } else {
            startX = (textW <= (int)width) ? ((int)width - textW) / 2 : 0; // centre, else left-align
        }

        // Blit each glyph at the running cursor, advancing by its own width. We write the whole
        // fixed-width cell but only set lit pixels, so the blank right of a narrow glyph never
        // clobbers the next one.
        int cursor = startX;
        for (size_t ci = 0; ci < text.size(); ci++) {
            unsigned char ch = (unsigned char)text[ci];
            int g = (int)ch - TextFonts::FIRST_CHAR;
            const int a = advOf(ch);
            if (g >= 0 && g < TextFonts::NUM_GLYPHS && cursor + fw > 0 && cursor < (int)width) {
                for (int ty = 0; ty < fh; ty++) {
                    int sy = vOff + ty;
                    if (sy < 0 || sy >= (int)height) continue;
                    for (int col = 0; col < fw; col++) {
                        int sx = cursor + col;
                        if (sx < 0 || sx >= (int)width) continue;
                        uint8_t byte = f->data[(size_t)(g * fh + ty) * bpr + (col >> 3)];
                        if (byte & (0x80 >> (col & 7))) outputBuffer[(size_t)sy * width + sx] = CHSV(hue, sat, 255);
                    }
                }
            }
            cursor += a;
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
