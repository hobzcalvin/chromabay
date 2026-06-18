#pragma once

#include "BaseOperator.h"
#include <map>
#include <vector>
#include <math.h>

// Fire - a stateful port of FastLED's classic Fire2012 (cool -> heat rises -> random
// sparks at the base -> map heat to the black->red->yellow->white palette).
//
// Fire2012 keeps a persistent heat[] buffer that evolves frame to frame. This engine
// renders a single operator instance once per strip per frame, each at that strip's own
// dimensions, so we can't keep just one buffer. Instead we keep a MAP of heat fields
// keyed by (width,height): every distinct strip size gets its own persistent fire,
// advanced exactly once per frame (a same-size mirror strip rendered again in the same
// frame just re-renders the existing field). Different-sized strips therefore each run
// their own independent fire - which is what you want for an organic effect; no two
// strips need to be in sync.
//
// 1xN linear strips run the original 1D Fire2012 along their length; WxH matrices run a
// 2D version where heat also spreads sideways as it rises.
class FireOperator : public BaseOperator {
    struct HeatField {
        std::vector<uint8_t> heat;
        uint16_t w = 0, h = 0;
        uint32_t lastStamp = 0;   // frame timestamp this field was last advanced at
        float accum = 0.0f;       // accumulated ms toward the next sim step
        bool started = false;
    };
    std::map<uint32_t, HeatField> fields_;
    uint32_t rng_ = 0;            // per-instance PRNG state

    // xorshift32 -> 0..255 (self-contained; no dependence on FastLED's global rng seed)
    inline uint8_t rnd8() {
        rng_ ^= rng_ << 13; rng_ ^= rng_ >> 17; rng_ ^= rng_ << 5;
        return (uint8_t)(rng_ >> 24);
    }
    inline uint8_t rndRange(uint8_t lo, uint8_t hi) {
        if (hi <= lo) return lo;
        return (uint8_t)(lo + (rnd8() % (uint8_t)(hi - lo + 1)));
    }
    // Random index in [0, n) using the full 32-bit state. rnd8() only spans 0..255, so
    // `rnd8() % w` would cap spark columns at 256 — leaving wide canvases (e.g. the
    // 500px fullscreen render) lit only on the left. Use this for any index up to width.
    inline uint32_t rndIndex(uint32_t n) {
        rng_ ^= rng_ << 13; rng_ ^= rng_ >> 17; rng_ ^= rng_ << 5;
        return n ? (rng_ % n) : 0;
    }
    static inline uint8_t qadd8_(uint8_t a, uint8_t b) { unsigned s = (unsigned)a + b; return s > 255 ? 255 : (uint8_t)s; }
    static inline uint8_t qsub8_(uint8_t a, uint8_t b) { return a > b ? (uint8_t)(a - b) : 0; }

    // Fire2012's HeatColor: temperature 0..255 -> black->red->yellow->white.
    static CRGB heatColor(uint8_t temperature) {
        uint8_t t192 = (uint8_t)(((uint16_t)temperature * 191) / 255);
        uint8_t ramp = (uint8_t)((t192 & 0x3F) << 2); // 0..252
        if (t192 & 0x80) return CRGB(255, 255, ramp);   // hottest third: white-hot
        if (t192 & 0x40) return CRGB(255, ramp, 0);      // middle third: orange/yellow
        return CRGB(ramp, 0, 0);                          // coolest third: red -> black
    }

    // Pre-fill the base hot so flames appear immediately instead of fading up from black.
    void seedField(HeatField& f) {
        uint16_t w = f.w, h = f.h;
        uint8_t* heat = f.heat.data();
        if (h <= 1) {
            int span = w < 7 ? w : 7;
            for (int x = 0; x < (int)w; x++) heat[x] = (x < span) ? rndRange(160, 255) : 0;
            return;
        }
        int baseRows = h / 4; if (baseRows < 1) baseRows = 1;
        for (int y = (int)h - baseRows; y < (int)h; y++)
            for (int x = 0; x < (int)w; x++)
                heat[(uint32_t)y * w + x] = rndRange(120, 255);
    }

    // One Fire2012 step on a 1xN linear strip (base at x=0, flames travel up the strip).
    void step1D(HeatField& f, int cooling, int sparking) {
        uint16_t w = f.w;
        uint8_t* heat = f.heat.data();
        int coolMax = (cooling * 10) / (w > 0 ? w : 1) + 2;
        for (int x = 0; x < (int)w; x++) heat[x] = qsub8_(heat[x], rndRange(0, (uint8_t)coolMax));
        for (int x = (int)w - 1; x >= 2; x--)
            heat[x] = (uint8_t)((heat[x - 1] + heat[x - 2] + heat[x - 2]) / 3);
        if (rnd8() < sparking) {
            int span = w < 7 ? (int)w : 7;
            int x = span > 0 ? (rnd8() % span) : 0;
            heat[x] = qadd8_(heat[x], rndRange(160, 255));
        }
    }

    // One step on a WxH matrix. Bottom row (y = h-1) is the hot base; heat rises toward
    // y=0 and spreads sideways into its diagonal neighbours.
    void step2D(HeatField& f, int cooling, int sparking) {
        uint16_t w = f.w, h = f.h;
        uint8_t* heat = f.heat.data();
        // 1) Cool every cell a little.
        int coolMax = (cooling * 10) / (h > 0 ? h : 1) + 2;
        for (uint32_t i = 0; i < (uint32_t)w * h; i++)
            heat[i] = qsub8_(heat[i], rndRange(0, (uint8_t)coolMax));
        // 2) Rise + spread: each cell pulls from the (hotter) row below it.
        for (int y = 0; y <= (int)h - 2; y++) {
            for (int x = 0; x < (int)w; x++) {
                int xl = x > 0 ? x - 1 : x;
                int xr = x < (int)w - 1 ? x + 1 : x;
                int below = heat[(uint32_t)(y + 1) * w + x];
                int bl = heat[(uint32_t)(y + 1) * w + xl];
                int br = heat[(uint32_t)(y + 1) * w + xr];
                heat[(uint32_t)y * w + x] = (uint8_t)((below + below + bl + br) / 4);
            }
        }
        // 3) Randomly ignite sparks along the bottom row.
        int attempts = (int)w / 3; if (attempts < 1) attempts = 1;
        for (int i = 0; i < attempts; i++) {
            if (rnd8() < sparking) {
                int x = (int)rndIndex(w); // full-width (rnd8() would cap at column 255)
                uint32_t idx = (uint32_t)(h - 1) * w + x;
                heat[idx] = qadd8_(heat[idx], rndRange(160, 255));
            }
        }
    }

    void renderField(const HeatField& f, CRGB* out, uint32_t count, int hueShift) {
        const uint8_t* heat = f.heat.data();
        if (hueShift == 0) {
            // Exact classic Fire2012 palette (also the identity case of the rotation below).
            for (uint32_t i = 0; i < count; i++) out[i] = heatColor(heat[i]);
            return;
        }
        // Rotate hue about the RGB grey axis. This is *exactly* the identity at hueShift=0,
        // so the effect is continuous from the classic fire (no jump), and it rotates colour
        // smoothly while leaving achromatic white-hot tips white — unlike a lossy rgb<->hsv
        // round-trip, which shifts every colour the instant it's enabled.
        const float kTwoPi = 6.28318530718f;
        float a = (float)hueShift / 255.0f * kTwoPi;
        float c = cosf(a), s = sinf(a);
        float t = (1.0f - c) / 3.0f;
        const float sq = 0.57735027f; // 1/sqrt(3)
        float m00 = c + t,      m01 = t - sq * s, m02 = t + sq * s;
        float m10 = t + sq * s, m11 = c + t,      m12 = t - sq * s;
        float m20 = t - sq * s, m21 = t + sq * s, m22 = c + t;
        for (uint32_t i = 0; i < count; i++) {
            CRGB col = heatColor(heat[i]);
            float r = col.r, g = col.g, b = col.b;
            int nr = (int)(r * m00 + g * m01 + b * m02 + 0.5f);
            int ng = (int)(r * m10 + g * m11 + b * m12 + 0.5f);
            int nb = (int)(r * m20 + g * m21 + b * m22 + 0.5f);
            out[i] = CRGB(
                (uint8_t)(nr < 0 ? 0 : (nr > 255 ? 255 : nr)),
                (uint8_t)(ng < 0 ? 0 : (ng > 255 ? 255 : ng)),
                (uint8_t)(nb < 0 ? 0 : (nb > 255 ? 255 : nb))
            );
        }
    }

public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        if (width == 0 || height == 0) return;
        float speed    = getFloat(parameters, 0, 1.0f);   // flame animation rate
        int   cooling  = getInt(parameters, 1, 55);       // Fire2012 COOLING (higher = shorter flames)
        int   sparking = getInt(parameters, 2, 120);      // Fire2012 SPARKING (higher = more/taller flames)
        int   hueShift = getInt(parameters, 3, 0);        // 0 = classic fire; shift for blue/green

        if (rng_ == 0) {
            rng_ = (uint32_t)((uintptr_t)this) ^ (timestampMs * 2654435761u) ^ 0x9E3779B9u;
            if (rng_ == 0) rng_ = 0x1234567u;
        }

        uint32_t key = ((uint32_t)width << 16) | (uint32_t)height;
        HeatField& f = fields_[key];
        if (f.w != width || f.h != height) {
            f.w = (uint16_t)width;
            f.h = (uint16_t)height;
            f.heat.assign((size_t)width * height, 0);
            seedField(f);
            f.accum = 0.0f;
            f.started = false;
        }

        // Advance the sim once per frame for this field. Mirror strips of the same size
        // share the field and render the same instant; the first call wins, later calls
        // in the same frame (same timestamp) just re-render. Flame speed uses a fixed
        // timestep, so it's independent of the render frame rate. dt comes from the
        // timestamp delta (the passed deltaTimeMs isn't reliable across all callers).
        if (!f.started) {
            f.started = true;
            f.lastStamp = timestampMs; // render the freshly-seeded base this first frame
        } else if (timestampMs != f.lastStamp) {
            int32_t d = (int32_t)(timestampMs - f.lastStamp);
            f.lastStamp = timestampMs;
            float dt = (d > 0 && d <= 100) ? (float)d : (d > 100 ? 100.0f : 16.0f);
            f.accum += dt;
            float stepMs = 45.0f / (speed > 0.05f ? speed : 0.05f);
            int steps = 0;
            while (f.accum >= stepMs && steps < 6) {
                if (height <= 1) step1D(f, cooling, sparking);
                else step2D(f, cooling, sparking);
                f.accum -= stepMs;
                steps++;
            }
        }

        renderField(f, outputBuffer, (uint32_t)width * height, hueShift);
    }

    const char* getName() const override { return "fire"; }
    const char* getDisplayName() const override { return "Fire"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.2f, 5.0f),
            ParameterInfo("cooling", "Cooling", ParameterInfo::INT, 55, 10, 100),
            ParameterInfo("sparking", "Sparking", ParameterInfo::INT, 120, 50, 200),
            ParameterInfo("hueShift", "Hue Shift", ParameterInfo::INT, 0, 0, 255)
        };
    }
};

REGISTER_OPERATOR(FireOperator);
