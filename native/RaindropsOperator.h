#pragma once

#include "BaseOperator.h"
#include <map>
#include <vector>

// Raindrops - stochastic falling rain. Drops are emitted at random times and columns and
// fall by SHIFTING a persistent intensity field downward each step (no per-drop tracking),
// leaving a short fading streak behind the head. Like Fire, the field is kept per strip
// size and advanced once per frame so mirrored same-size strips stay in sync.
class RaindropsOperator : public BaseOperator {
    struct Field {
        std::vector<uint8_t> v;   // per-pixel intensity (0..255)
        uint16_t w = 0, h = 0;
        uint32_t lastStamp = 0;
        float accum = 0.0f;       // ms toward the next downward step
        bool started = false;
    };
    std::map<uint32_t, Field> fields_;
    uint32_t rng_ = 0;
    inline uint32_t rnd() { rng_ ^= rng_ << 13; rng_ ^= rng_ >> 17; rng_ ^= rng_ << 5; return rng_; }

    // Shift the field down one row, then emit `nDrops` new streaks at random columns.
    void step(Field& f, int nDrops, int tail) {
        uint16_t w = f.w, h = f.h;
        uint8_t* v = f.v.data();
        for (int y = (int)h - 1; y > 0; y--)
            for (int x = 0; x < (int)w; x++)
                v[(uint32_t)y * w + x] = v[(uint32_t)(y - 1) * w + x];
        for (int x = 0; x < (int)w; x++) v[x] = 0; // clear top row

        for (int d = 0; d < nDrops; d++) {
            int x = (int)(rnd() % (uint32_t)w);
            // A streak occupies the top `tail` rows: head (row 0) brightest, fading upward.
            for (int k = 0; k < tail && k < (int)h; k++) {
                uint8_t b = (uint8_t)(255 - (k * 200 / (tail > 1 ? tail : 1)));
                uint32_t idx = (uint32_t)k * w + x;
                if (b > v[idx]) v[idx] = b;
            }
        }
    }

public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t timestampMs, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        if (width == 0 || height == 0) return;
        float speed = getFloat(parameters, 0, 60.0f);   // fall speed, % of height per second
        float rate  = getFloat(parameters, 1, 12.0f);   // drops emitted per second (whole display)
        int   tail  = (int)((getFloat(parameters, 2, 30.0f) / 100.0f) * (float)height); // streak len
        if (tail < 1) tail = 1;
        uint8_t hue = (uint8_t)getInt(parameters, 3, 160);
        uint8_t sat = (uint8_t)getInt(parameters, 4, 200);

        if (rng_ == 0) {
            rng_ = (uint32_t)((uintptr_t)this) ^ (timestampMs * 2654435761u) ^ 0x9E3779B9u;
            if (rng_ == 0) rng_ = 0x1234567u;
        }

        uint32_t key = ((uint32_t)width << 16) | (uint32_t)height;
        Field& f = fields_[key];
        if (f.w != width || f.h != height) {
            f.w = (uint16_t)width; f.h = (uint16_t)height;
            f.v.assign((size_t)width * height, 0);
            f.accum = 0.0f; f.started = false;
        }

        // One downward step per (speed) rows-per-second. Rows/sec = speed% of height.
        float rowsPerSec = (speed / 100.0f) * (float)height;
        if (rowsPerSec < 0.1f) rowsPerSec = 0.1f;
        float stepMs = 1000.0f / rowsPerSec;
        // Expected drops per step from the drops/sec rate; spawn the integer part plus a
        // fractional chance so low rates still emit occasionally.
        float dropsPerStep = rate * (stepMs / 1000.0f);

        if (!f.started) {
            f.started = true; f.lastStamp = timestampMs;
        } else if (timestampMs != f.lastStamp) {
            int32_t d = (int32_t)(timestampMs - f.lastStamp);
            f.lastStamp = timestampMs;
            float dt = (d > 0 && d <= 100) ? (float)d : (d > 100 ? 100.0f : 16.0f);
            f.accum += dt;
            int steps = 0;
            while (f.accum >= stepMs && steps < 8) {
                int nd = (int)dropsPerStep;
                if ((rnd() & 0xFFFF) < (uint32_t)((dropsPerStep - (float)nd) * 65535.0f)) nd++;
                step(f, nd, tail);
                f.accum -= stepMs; steps++;
            }
        }

        const uint8_t* v = f.v.data();
        for (uint32_t i = 0; i < (uint32_t)width * height; i++)
            outputBuffer[i] = v[i] ? (CRGB)CHSV(hue, sat, v[i]) : CRGB::Black;
    }

    const char* getName() const override { return "raindrops"; }
    const char* getDisplayName() const override { return "Raindrops"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Fall Speed (%/sec)", ParameterInfo::FLOAT, 60.0f, 10.0f, 300.0f),
            ParameterInfo("rate", "Rate (drops/sec)", ParameterInfo::FLOAT, 12.0f, 1.0f, 60.0f),
            ParameterInfo("tail", "Tail (%)", ParameterInfo::FLOAT, 30.0f, 0.0f, 100.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::INT, 160, 0, 255),
            ParameterInfo("saturation", "Saturation", ParameterInfo::INT, 200, 0, 255)
        };
    }
};

REGISTER_OPERATOR(RaindropsOperator);
