#pragma once

#include "BaseOperator.h"
#include "text_fonts.h"
#include "WallClock.h"
#include <string>
#include <cstdio>

// Clock - renders the current wall-clock time (HH:MM, optionally :SS) using the bitmap font.
// Time comes from WallClock::get() (Unix seconds), which the host keeps current; a per-node
// timezone offset (hours, quarter-hour steps allowed) shifts it. Shows "--:--" until synced.
// Great for a desk clock, and the source ticks so downstream effects can react each second.
class TimeOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        if (width == 0 || height == 0) return;
        float  tzHours   = getFloat(parameters, 0, 0.0f);   // -12 .. +14
        int    is12h     = getInt(parameters, 1, 0);        // SELECT: 0 = 24-hour, 1 = 12-hour
        bool   showSecs  = getBool(parameters, 2, false);
        CRGB   color     = getColor(parameters, 3, CRGB(255, 255, 255));

        for (uint32_t i = 0; i < width * height; i++) outputBuffer[i] = CRGB::Black;

        char text[12];
        uint32_t epoch = WallClock::get();
        if (epoch == 0) {
            // Not synced yet — show placeholder so it's obviously "waiting", not broken.
            snprintf(text, sizeof(text), showSecs ? "--:--:--" : "--:--");
        } else {
            long local = (long)epoch + (long)(tzHours * 3600.0f);
            local %= 86400; if (local < 0) local += 86400;
            int h = (int)(local / 3600), m = (int)((local % 3600) / 60), s = (int)(local % 60);
            if (is12h) {
                int h12 = h % 12; if (h12 == 0) h12 = 12;
                if (showSecs) snprintf(text, sizeof(text), "%d:%02d:%02d", h12, m, s);
                else          snprintf(text, sizeof(text), "%d:%02d", h12, m);
            } else {
                if (showSecs) snprintf(text, sizeof(text), "%02d:%02d:%02d", h, m, s);
                else          snprintf(text, sizeof(text), "%02d:%02d", h, m);
            }
        }
        drawCentered(outputBuffer, width, height, text, color);
    }

    const char* getName() const override { return "clock"; }
    const char* getDisplayName() const override { return "Clock"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("tz", "Timezone (hrs)", ParameterInfo::FLOAT, 0.0f, -12.0f, 14.0f),
            ParameterInfo("format", "Format", ParameterInfo::SELECT, 0, std::vector<std::string>{ "24-hour", "12-hour" }),
            ParameterInfo("seconds", "Show seconds", ParameterInfo::BOOL, ParameterValue(false)),
            ParameterInfo("color", "Color", ParameterInfo::COLOR, ParameterValue(CRGB(255, 255, 255)))
        };
    }

private:
    // Blit a string centered, picking the largest font that fits the height (same approach as
    // TextOperator). Monospace fonts advance by cell width; proportional ones use widths[].
    static void drawCentered(CRGB* out, uint32_t width, uint32_t height, const char* text, const CRGB& color) {
        const TextFonts::BitmapFont* f = &TextFonts::FONT_5x8;
        if (height >= TextFonts::FONT_16x32.h) f = &TextFonts::FONT_16x32;
        else if (height >= TextFonts::FONT_8x16.h) f = &TextFonts::FONT_8x16;
        const int fw = f->w, fh = f->h, bpr = f->bytesPerRow;
        const int vOff = ((int)height - fh) / 2;
        auto advOf = [&](unsigned char ch) -> int {
            int g = (int)ch - TextFonts::FIRST_CHAR;
            if (g < 0 || g >= TextFonts::NUM_GLYPHS) return 0;
            return f->widths ? (int)f->widths[g] : fw;
        };
        int textW = 0;
        for (const char* p = text; *p; p++) textW += advOf((unsigned char)*p);
        int cursor = (textW <= (int)width) ? ((int)width - textW) / 2 : 0;
        for (const char* p = text; *p; p++) {
            unsigned char ch = (unsigned char)*p;
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
                        if (byte & (0x80 >> (col & 7))) out[(size_t)sy * width + sx] = color;
                    }
                }
            }
            cursor += a;
        }
    }
};

REGISTER_OPERATOR(TimeOperator);
