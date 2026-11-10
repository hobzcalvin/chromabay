#pragma once
// Small helpers shared by the low-level operators (Oscillator, Shape, Kaleidoscope, …).
// Header-only and C++11, so it compiles unchanged into the WASM preview and the firmware.
#include <FastLED.h>
#include <math.h>
#include <stdint.h>

namespace OpUtil {

static const float PI_F = 3.14159265f;
static const float TAU_F = 6.28318531f;

inline float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }
inline uint8_t to8(float v01) { return (uint8_t)(clamp01(v01) * 255.0f + 0.5f); }
inline float fract(float v) { return v - floorf(v); }
inline float mixf(float a, float b, float t) { return a + (b - a) * t; }
inline float smooth(float e0, float e1, float x) {
    if (e1 == e0) return x < e0 ? 0.0f : 1.0f;
    float t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3.0f - 2.0f * t);
}

// Perceptual luma 0..1 (Rec. 601 weights, the same ones FastLED's getLuma uses).
inline float luma(const CRGB& c) { return (0.299f * c.r + 0.587f * c.g + 0.114f * c.b) / 255.0f; }

// Aspect-correct, resolution-independent coordinates. The longer side spans -1..1 and the
// shorter side proportionally less, so a circle stays round on a 32x8 matrix and the SAME
// pattern looks the same on a 16px and a 160px display. A 1-row strip is a slice through y=0.
struct Frame {
    float cx, cy, inv; // pixel centre and 1 / half-extent of the longer side
    Frame(uint32_t w, uint32_t h) {
        cx = (float)w * 0.5f;
        cy = (float)h * 0.5f;
        float half = (float)(w > h ? w : h) * 0.5f;
        inv = half > 0.0f ? 1.0f / half : 1.0f;
    }
    float u(uint32_t x) const { return ((float)x + 0.5f - cx) * inv; }
    float v(uint32_t y) const { return ((float)y + 0.5f - cy) * inv; }
    // Back from normalised coordinates to (fractional) pixel coordinates.
    float px(float u) const { return u / inv + cx - 0.5f; }
    float py(float v) const { return v / inv + cy - 0.5f; }
};

inline int wrapi(int v, int n) { int r = v % n; return r < 0 ? r + n : r; }

// Sample `buf` at a fractional pixel position. Edge: 0 clamp, 1 wrap. Bilinear.
inline CRGB sample(const CRGB* buf, uint32_t w, uint32_t h, float fx, float fy, int edge) {
    if (w == 0 || h == 0) return CRGB::Black;
    int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
    float tx = fx - (float)x0, ty = fy - (float)y0;
    int x1 = x0 + 1, y1 = y0 + 1;
    if (edge == 1) {
        x0 = wrapi(x0, (int)w); x1 = wrapi(x1, (int)w); y0 = wrapi(y0, (int)h); y1 = wrapi(y1, (int)h);
    } else {
        int mx = (int)w - 1, my = (int)h - 1;
        x0 = x0 < 0 ? 0 : (x0 > mx ? mx : x0); x1 = x1 < 0 ? 0 : (x1 > mx ? mx : x1);
        y0 = y0 < 0 ? 0 : (y0 > my ? my : y0); y1 = y1 < 0 ? 0 : (y1 > my ? my : y1);
    }
    const CRGB& a = buf[(size_t)y0 * w + x0];
    const CRGB& b = buf[(size_t)y0 * w + x1];
    const CRGB& c = buf[(size_t)y1 * w + x0];
    const CRGB& d = buf[(size_t)y1 * w + x1];
    float w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    return CRGB((uint8_t)(a.r * w00 + b.r * w10 + c.r * w01 + d.r * w11 + 0.5f),
                (uint8_t)(a.g * w00 + b.g * w10 + c.g * w01 + d.g * w11 + 0.5f),
                (uint8_t)(a.b * w00 + b.b * w10 + c.b * w01 + d.b * w11 + 0.5f));
}

// Integer hash -> [0,1). Deterministic across toolchains (no libc rand()).
inline float hash01(uint32_t n) {
    n = (n ^ 61u) ^ (n >> 16); n *= 9u; n ^= n >> 4; n *= 0x27d4eb2du; n ^= n >> 15;
    return (float)(n & 0x00FFFFFFu) / 16777216.0f;
}

inline void fillBlack(CRGB* out, uint32_t n) { for (uint32_t i = 0; i < n; i++) out[i] = CRGB::Black; }
inline void copy(const CRGB* in, CRGB* out, uint32_t n) { for (uint32_t i = 0; i < n; i++) out[i] = in[i]; }

} // namespace OpUtil
