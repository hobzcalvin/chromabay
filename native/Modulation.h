#pragma once
// Parameter automation (LFO / noise / random), evaluated in ONE place and compiled to both the
// WASM preview and the ESP32 firmware, so browser and device produce the same value at the same
// (synced) timestamp. Operators are untouched — the harness swaps in modulate() before render.
#include <cstdint>
#include <cmath>

namespace Modulation {

enum Shape { SINE = 0, TRIANGLE = 1, SAWTOOTH = 2, SQUARE = 3, RANDOM = 4, PERLIN = 5 };

// Integer hash → [0,1). Pure integer ops, so it's bit-identical across toolchains (the RANDOM
// shape and PERLIN's lattice points never drift between preview and device).
inline float hash01(uint32_t n, uint32_t seed) {
    uint32_t h = n * 0x9E3779B1u + seed * 0x85EBCA77u + 0x165667B1u;
    h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
    return (float)(h & 0x00FFFFFFu) / (float)0x01000000u; // 24 bits → [0,1)
}

// Smoothstep-interpolated 1D value noise (a cheap Perlin-ish wander).
inline float valueNoise(float phase, uint32_t seed) {
    float fp = floorf(phase);
    uint32_t i = (uint32_t)(int32_t)fp;
    float t = phase - fp;
    float a = hash01(i, seed), b = hash01(i + 1u, seed);
    float s = t * t * (3.0f - 2.0f * t);
    return a + (b - a) * s;
}

// Shape → [0,1] from the running phase (in cycles). seed decorrelates RANDOM/PERLIN per parameter.
inline float shaped01(int shape, float phase, uint32_t seed) {
    float frac = phase - floorf(phase); // 0..1 within the current cycle
    switch (shape) {
        case SINE:     return 0.5f - 0.5f * cosf(6.28318531f * frac);
        case TRIANGLE: return 1.0f - fabsf(2.0f * frac - 1.0f);
        case SAWTOOTH: return frac;
        case SQUARE:   return frac < 0.5f ? 0.0f : 1.0f;
        case RANDOM:   return hash01((uint32_t)(int32_t)floorf(phase), seed); // one value/cycle, held
        case PERLIN:   return valueNoise(phase, seed);
        default:       return 0.0f;
    }
}

// Map to [mn, mx] (mn>mx is allowed and simply inverts the sweep). period = seconds per cycle
// (for RANDOM, seconds between jumps). tMs = milliseconds on the shared clock.
inline float modulate(int shape, float mn, float mx, float period, uint32_t tMs, uint32_t seed) {
    float phase = (period > 0.0001f) ? ((float)tMs * 0.001f / period) : 0.0f;
    return mn + (mx - mn) * shaped01(shape, phase, seed);
}

} // namespace Modulation
