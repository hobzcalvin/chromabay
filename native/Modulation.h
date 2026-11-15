#pragma once
// Parameter automation (LFO / noise / random), evaluated in ONE place and compiled to both the
// WASM preview and the ESP32 firmware, so browser and device produce the same value at the same
// (synced) timestamp. Operators are untouched — the harness swaps in modulate() before render.
#include <cstdint>
#include <cmath>
#include "AudioReactive.h"

namespace Modulation {

// 0-5 are clock-driven LFOs. 6+ follow the audio input (Audio::g_features): for those,
// `period` is a RELEASE time in seconds (rises instantly, falls back over `period`; 0 = raw),
// except the beat-locked BEAT_WAVE/BEAT_RAMP where it is the length of one cycle in BEATS.
enum Shape {
    SINE = 0, TRIANGLE = 1, SAWTOOTH = 2, SQUARE = 3, RANDOM = 4, PERLIN = 5,
    AUDIO_VOLUME = 6, AUDIO_BASS = 7, AUDIO_MID = 8, AUDIO_TREBLE = 9,
    AUDIO_BEAT = 10,  // pulse: 1 on each beat, decays
    BEAT_WAVE = 11,   // smooth sine locked to the tempo, peaking on the beat
    BEAT_RAMP = 12,   // 0->1 sawtooth locked to the tempo, resetting on the beat
};
inline bool isAudioShape(int shape) { return shape >= AUDIO_VOLUME && shape <= BEAT_RAMP; }
inline bool isBeatLocked(int shape) { return shape == BEAT_WAVE || shape == BEAT_RAMP; }

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

// Current 0..1 value of an audio shape. For the beat-locked ones `beatsPerCycle` stretches
// one cycle over several beats (the phase is taken from the beat counter so it stays locked).
inline float audio01(int shape, float beatsPerCycle) {
    const Audio::Features& f = Audio::get();
    switch (shape) {
        case AUDIO_VOLUME: return f.volume;
        case AUDIO_BASS:   return f.bass;
        case AUDIO_MID:    return f.mid;
        case AUDIO_TREBLE: return f.treble;
        case AUDIO_BEAT:   return f.beat;
        case BEAT_WAVE: case BEAT_RAMP: {
            int n = beatsPerCycle >= 1.0f ? (int)lroundf(beatsPerCycle) : 1;
            float ph = ((float)(f.beats % (uint32_t)n) + f.beatPhase) / (float)n;
            ph -= floorf(ph);
            return shape == BEAT_RAMP ? ph : 0.5f + 0.5f * cosf(6.28318531f * ph);
        }
        default: return 0.0f;
    }
}

// Map to [mn, mx] (mn>mx is allowed and simply inverts the sweep). period = seconds per cycle
// (for RANDOM, seconds between jumps). tMs = milliseconds on the shared clock.
inline float modulate(int shape, float mn, float mx, float period, uint32_t tMs, uint32_t seed) {
    if (isAudioShape(shape)) return mn + (mx - mn) * audio01(shape, period);
    float phase = (period > 0.0001f) ? ((float)tMs * 0.001f / period) : 0.0f;
    return mn + (mx - mn) * shaped01(shape, phase, seed);
}

// Per-parameter state so the phase can stay continuous when `period` is changed LIVE (e.g. an
// interactive speed knob). Persists across frames per (operator, parameter).
struct ModState {
    float offset = 0.0f;     // phase offset that absorbs live period changes
    float lastPeriod = 0.0f;
    bool  init = false;
    float level = 0.0f;      // audio shapes: the released (peak-hold) value
    uint32_t lastMs = 0;     // audio shapes: time of the previous evaluation
    bool  audioInit = false;
};

// Stateful modulate: phase is still anchored to the shared clock (so a STEADY automation stays
// in sync across devices + preview), but when `period` changes we shift `offset` to keep the
// phase continuous instead of snapping — which is what caused the "crazy spin" when dragging the
// speed. Same fix the operators use with advancePhase, but done here without losing clock-sync.
inline float modulate(ModState& st, int shape, float mn, float mx, float period, uint32_t tMs, uint32_t seed) {
    if (isAudioShape(shape)) {
        float v = audio01(shape, period);
        if (!isBeatLocked(shape) && period > 0.0001f) {
            // Instant attack, exponential release over `period` seconds.
            float dt = st.audioInit ? (float)(uint32_t)(tMs - st.lastMs) * 0.001f : 0.0f;
            if (dt < 0.0f || dt > 1.0f) dt = 0.0f;
            st.level = v >= st.level ? v : st.level + (v - st.level) * (1.0f - expf(-dt / period));
            v = st.level;
        }
        st.audioInit = true; st.lastMs = tMs;
        return mn + (mx - mn) * v;
    }
    float tSec = (float)tMs * 0.001f;
    float per = period > 0.0001f ? period : 0.0001f;
    if (!st.init) { st.lastPeriod = per; st.offset = 0.0f; st.init = true; }
    else if (per != st.lastPeriod) {
        float oldPhase = tSec / st.lastPeriod + st.offset;
        st.offset = oldPhase - tSec / per;   // keep phase continuous across the change
        st.lastPeriod = per;
    }
    float phase = tSec / per + st.offset;
    return mn + (mx - mn) * shaped01(shape, phase, seed);
}

} // namespace Modulation
