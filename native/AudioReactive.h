#pragma once
// Audio reactivity, shared by the firmware and the WASM preview (same math in both places,
// like Modulation.h). Three parts:
//
//   Audio::Features   what a frame can react to: volume, 16 frequency bands, bass/mid/treble,
//                     a beat pulse, tempo and a beat-locked phase. All 0..1 except bpm/Hz.
//   Audio::g_features the CURRENT features. The host keeps it fresh (like WallClock): the
//                     firmware copies the mic task's latest result in once per frame; the
//                     preview either feeds browser-mic samples to an Analyzer or simulates.
//                     Operators and parameter automation only ever read it.
//   Audio::Analyzer   turns raw mono samples into Features: FFT, gain/AGC/noise gate shaped
//                     after WLED's AudioReactive usermod (same setting names and ranges, so a
//                     WLED config imports meaningfully), spectral-flux onsets, and an
//                     autocorrelation tempo tracker with a phase-locked beat clock.
//
// No FastLED/Arduino dependency, so it can be unit-tested on a host compiler.
#include <cstdint>
#include <cmath>
#include <cstring>

namespace Audio {

constexpr int kBands = 16;

struct Features {
    float volume = 0.0f;      // smoothed loudness, after gain/AGC/noise gate (0..1)
    float volumeRaw = 0.0f;   // unsmoothed loudness of the latest block (0..1)
    float bands[kBands] = {}; // log-spaced bands, ~43 Hz .. ~9 kHz (0..1)
    float bass = 0.0f;        // bands 0-4   (~40-230 Hz)
    float mid = 0.0f;         // bands 5-10  (~230 Hz-1.7 kHz)
    float treble = 0.0f;      // bands 11-15 (~1.7-9 kHz)
    float beat = 0.0f;        // 1 on a detected beat, decaying to 0 (~150 ms)
    float beatPhase = 0.0f;   // 0..1 ramp, wraps on each beat of the tracked tempo
    float bpm = 0.0f;         // tracked tempo; 0 until one is found
    float peakHz = 0.0f;      // strongest frequency (0 when quiet)
    uint32_t beats = 0;       // beat counter (wraps)
    bool active = false;      // a source is feeding this (mic running, or simulated)
};

inline Features g_features{};
inline const Features& get() { return g_features; }
inline void set(const Features& f) { g_features = f; }

// Value 0..1 of the band curve at position p (0 = lowest band, 1 = highest), linearly
// interpolated between bands. Used by the Audio node to lay the spectrum across pixels.
inline float bandAt(const Features& f, float p) {
    if (p <= 0.0f) return f.bands[0];
    if (p >= 1.0f) return f.bands[kBands - 1];
    float x = p * (float)(kBands - 1);
    int i = (int)x;
    float t = x - (float)i;
    return f.bands[i] + (f.bands[i + 1] - f.bands[i]) * t;
}

inline float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

// ---------------------------------------------------------------------------------------
// Settings. Names, ranges and defaults follow WLED's AudioReactive usermod
// ("um" -> "AudioReactive" in cfg.json), so an imported config behaves the same way.
// ---------------------------------------------------------------------------------------
enum Agc : uint8_t { AGC_OFF = 0, AGC_NORMAL = 1, AGC_VIVID = 2, AGC_LAZY = 3 };
// WLED's FFTScalingMode values (yes, log is 1 and linear 2).
enum Scale : uint8_t { SCALE_NONE = 0, SCALE_LOG = 1, SCALE_LINEAR = 2, SCALE_SQRT = 3 };

struct Config {
    uint8_t  squelch = 10;     // noise gate, in WLED's 0..255 sample units
    uint8_t  gain = 60;        // input gain, 1..255 (40 = unity, WLED's "sampleGain")
    uint8_t  agc = AGC_OFF;    // automatic gain control preset
    bool     limiter = true;   // smooth volume with rise/fall below
    uint16_t riseMs = 80;      // volume attack (WLED "dynamics:rise")
    uint16_t fallMs = 1400;    // volume release (WLED "dynamics:fall")
    uint8_t  scale = SCALE_SQRT; // how band magnitudes are scaled (WLED "frequency:scale")
};

// ---------------------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------------------
class Analyzer {
public:
    static constexpr int N = 512;          // FFT size
    static constexpr int HOP = 256;        // 50% overlap: ~86 analyses/s at 22.05 kHz
    static constexpr int ONSET_LEN = 512;  // onset-strength history (~6 s at 86 Hz)

    explicit Analyzer(float sampleRate = 22050.0f) { setSampleRate(sampleRate); }

    Config cfg;

    void setSampleRate(float sr) {
        _sr = sr > 1000.0f ? sr : 22050.0f;
        for (int i = 0; i < N; i++) _window[i] = 0.5f - 0.5f * cosf(6.28318531f * (float)i / (float)(N - 1));
        for (int i = 0; i < N / 2; i++) {
            _twRe[i] = cosf(-6.28318531f * (float)i / (float)N);
            _twIm[i] = sinf(-6.28318531f * (float)i / (float)N);
        }
        // Band edges: log-spaced from one bin (~43 Hz) to ~9 kHz (or 0.85·Nyquist).
        float lo = _sr / (float)N;
        float hi = fminf(9000.0f, _sr * 0.5f * 0.85f);
        int prevBin = 1;
        for (int b = 0; b <= kBands; b++) {
            float hz = lo * powf(hi / lo, (float)b / (float)kBands);
            int bin = (int)lroundf(hz * (float)N / _sr);
            if (b > 0 && bin <= prevBin) bin = prevBin + 1;  // every band gets >= 1 bin
            if (bin > N / 2) bin = N / 2;
            _edge[b] = bin;
            prevBin = bin;
        }
        _edge[0] = 1; // skip DC
        _frameHz = _sr / (float)HOP;
        reset();
    }

    float sampleRate() const { return _sr; }

    void reset() {
        _fill = 0;
        memset(_ring, 0, sizeof(_ring));
        memset(_prevLog, 0, sizeof(_prevLog));
        memset(_onset, 0, sizeof(_onset));
        memset(_bandSm, 0, sizeof(_bandSm));
        _onsetPos = 0; _onsetCount = 0;
        _fluxMean = 0.0f; _fluxVar = 0.0f;
        _dc = 0.0f; _agcMul = 1.0f; _agcEnv = 0.0f;
        _vol = 0.0f; _beatEnv = 0.0f; _sinceBeat = 1000.0f;
        _phase = 0.0f; _bpm = 0.0f; _framesSinceTempo = 0;
        _beats = 0;
        _out = Features{};
    }

    // Feed mono samples in [-1, 1]. Runs an analysis each time HOP new samples arrive and
    // returns how many ran; the result is in features().
    int push(const float* x, int n) {
        int ran = 0;
        for (int i = 0; i < n; i++) {
            // One-pole DC blocker (~10 Hz): MEMS mics have a large, drifting offset.
            float s = x[i];
            _dc += (s - _dc) * 0.003f;
            _ring[_fill++] = s - _dc;
            if (_fill == N) {
                analyze();
                ran++;
                memmove(_ring, _ring + HOP, sizeof(float) * (N - HOP));
                _fill = N - HOP;
            }
        }
        return ran;
    }

    const Features& features() const { return _out; }

    /** Loudness of the latest block in the units Squelch is compared against (gain applied,
     *  before AGC and the gate), so a UI can show the noise floor next to the input. */
    float level() const { return _level; }

private:
    float _sr = 22050.0f, _frameHz = 86.0f;
    float _ring[N];
    int _fill = 0;
    float _window[N];
    float _twRe[N / 2], _twIm[N / 2];
    float _re[N], _im[N];
    float _mag[N / 2];
    float _prevLog[N / 2];
    int _edge[kBands + 1];
    float _bandSm[kBands];
    float _onset[ONSET_LEN];
    int _onsetPos = 0, _onsetCount = 0;
    float _fluxMean = 0.0f, _fluxVar = 0.0f;
    float _dc = 0.0f;
    float _agcMul = 1.0f, _agcEnv = 0.0f;
    float _vol = 0.0f;
    float _level = 0.0f;
    float _beatEnv = 0.0f, _sinceBeat = 1000.0f; // seconds since last beat
    float _phase = 0.0f, _bpm = 0.0f;
    int _framesSinceTempo = 0;
    uint32_t _beats = 0;
    Features _out;

    // In-place iterative radix-2 complex FFT over _re/_im.
    void fft() {
        for (int i = 1, j = 0; i < N; i++) {
            int bit = N >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { float t = _re[i]; _re[i] = _re[j]; _re[j] = t; t = _im[i]; _im[i] = _im[j]; _im[j] = t; }
        }
        for (int len = 2; len <= N; len <<= 1) {
            int half = len >> 1, step = N / len;
            for (int i = 0; i < N; i += len) {
                for (int k = 0; k < half; k++) {
                    float wr = _twRe[k * step], wi = _twIm[k * step];
                    int a = i + k, b = a + half;
                    float xr = _re[b] * wr - _im[b] * wi;
                    float xi = _re[b] * wi + _im[b] * wr;
                    _re[b] = _re[a] - xr; _im[b] = _im[a] - xi;
                    _re[a] += xr;         _im[a] += xi;
                }
            }
        }
    }

    float scaleBand(float v) const {
        switch (cfg.scale) {
            case SCALE_LOG:    return v <= 0.0f ? 0.0f : clamp01((20.0f * log10f(v) + 36.0f) / 36.0f); // 36 dB of range
            case SCALE_LINEAR: return v;
            case SCALE_SQRT:   return sqrtf(v > 0.0f ? v : 0.0f);
            default:           return v * 0.5f; // "None": raw, unboosted
        }
    }

    void analyze() {
        const float dt = 1.0f / _frameHz;

        // --- Loudness (RMS of the newest hop) in WLED's 0..255 "sample" units ---
        double acc = 0.0;
        for (int i = N - HOP; i < N; i++) acc += (double)_ring[i] * _ring[i];
        float rms = sqrtf((float)(acc / HOP));
        float gainMul = (float)(cfg.gain ? cfg.gain : 1) / 40.0f;
        float level = rms * 2048.0f * gainMul;              // ~-25 dBFS music at unity ≈ 115
        bool gated = level < (float)cfg.squelch;
        _level = level;

        // --- AGC: steer the loudness envelope toward a target. Presets differ in speed. ---
        if (cfg.agc != AGC_OFF && !gated) {
            float up, down; // seconds for the multiplier to move by ~e
            switch (cfg.agc) {
                case AGC_VIVID: up = 1.0f;  down = 0.3f; break;
                case AGC_LAZY:  up = 10.0f; down = 3.0f; break;
                default:        up = 3.0f;  down = 1.0f; break;
            }
            float env = level * _agcMul;
            // Peak-ish envelope: quick to rise, slow to fall, so transients don't pump it.
            _agcEnv = env > _agcEnv ? _agcEnv + (env - _agcEnv) * 0.5f : _agcEnv + (env - _agcEnv) * (dt / 2.0f);
            const float target = 170.0f;
            float err = logf((target + 1.0f) / (_agcEnv + 1.0f));
            float tau = err > 0.0f ? up : down;
            _agcMul *= expf(err * dt / tau);
            if (_agcMul < 1.0f / 16.0f) _agcMul = 1.0f / 16.0f;
            if (_agcMul > 32.0f) _agcMul = 32.0f;
        } else if (cfg.agc == AGC_OFF) {
            _agcMul = 1.0f;
        }
        float mul = gainMul * _agcMul;
        float vRaw = gated ? 0.0f : clamp01(level * _agcMul / 255.0f);

        // Volume smoothing. With the limiter, WLED's rise/fall times; without, a light fixed one.
        float riseS = cfg.limiter ? (float)cfg.riseMs * 0.001f : 0.03f;
        float fallS = cfg.limiter ? (float)cfg.fallMs * 0.001f : 0.15f;
        float tau = vRaw > _vol ? riseS : fallS;
        _vol += (vRaw - _vol) * (tau > 0.0f ? (1.0f - expf(-dt / tau)) : 1.0f);

        // --- Spectrum ---
        for (int i = 0; i < N; i++) { _re[i] = _ring[i] * _window[i]; _im[i] = 0.0f; }
        fft();
        const float norm = 4.0f / (float)N; // a full-scale sine's bin reads ~1.0
        int peakBin = 0; float peakMag = 0.0f;
        for (int k = 0; k < N / 2; k++) {
            _mag[k] = sqrtf(_re[k] * _re[k] + _im[k] * _im[k]) * norm;
            if (k >= 1 && _mag[k] > peakMag) { peakMag = _mag[k]; peakBin = k; }
        }

        float bands[kBands];
        for (int b = 0; b < kBands; b++) {
            float pw = 0.0f;
            for (int k = _edge[b]; k < _edge[b + 1]; k++) pw += _mag[k] * _mag[k];
            float amp = sqrtf(pw);
            // Music falls off ~3 dB/octave and the high bands are wider, but each high bin also
            // carries less: a gentle tilt keeps treble visible without a hiss floor.
            float tilt = 1.0f + 0.12f * (float)b;
            float v = gated ? 0.0f : clamp01(amp * mul * tilt * 6.0f);
            v = clamp01(scaleBand(v));
            // Fast attack, release on the same fall time as volume (capped so bars stay lively).
            float rel = fminf(fallS, 0.35f);
            _bandSm[b] = v > _bandSm[b] ? v : _bandSm[b] + (v - _bandSm[b]) * (1.0f - expf(-dt / rel));
            bands[b] = _bandSm[b];
        }

        // --- Onsets: spectral flux of log magnitude, emphasising < ~2 kHz (kick/snare) ---
        float flux = 0.0f;
        const int fluxTop = (int)(2000.0f * (float)N / _sr);
        for (int k = 1; k < N / 2; k++) {
            float lm = logf(1.0f + 100.0f * _mag[k] * mul);
            float d = lm - _prevLog[k];
            if (d > 0.0f) flux += (k <= fluxTop) ? d : d * 0.25f;
            _prevLog[k] = lm;
        }
        if (gated) flux = 0.0f;
        // Adaptive threshold: running mean + 1.6 sigma (~1 s memory).
        float a = dt / 1.0f;
        float dev = flux - _fluxMean;
        _fluxMean += dev * a;
        _fluxVar += (dev * dev - _fluxVar) * a;
        float thresh = _fluxMean + 1.6f * sqrtf(_fluxVar) + 0.5f;
        _sinceBeat += dt;
        bool onset = !gated && flux > thresh && _sinceBeat > 0.22f; // <= ~270 bpm
        float onsetStrength = flux > _fluxMean ? (flux - _fluxMean) : 0.0f;
        _onset[_onsetPos] = onsetStrength;
        _onsetPos = (_onsetPos + 1) % ONSET_LEN;
        if (_onsetCount < ONSET_LEN) _onsetCount++;

        if (onset) {
            _sinceBeat = 0.0f;
            _beatEnv = 1.0f;
            _beats++;
            // Phase lock: pull the beat clock toward this onset if it is near a predicted beat.
            if (_bpm > 0.0f) {
                float e = _phase > 0.5f ? _phase - 1.0f : _phase; // -0.5..0.5, 0 = on the beat
                if (fabsf(e) < 0.25f) _phase -= 0.35f * e;
            } else {
                _phase = 0.0f;
            }
        } else {
            _beatEnv *= expf(-dt / 0.15f);
        }

        // --- Tempo: autocorrelate the onset history every ~0.5 s ---
        if (++_framesSinceTempo >= (int)(_frameHz * 0.5f) && _onsetCount >= ONSET_LEN / 2) {
            _framesSinceTempo = 0;
            trackTempo();
        }
        float bpmUse = _bpm > 0.0f ? _bpm : 120.0f;
        _phase += dt * bpmUse / 60.0f;
        _phase -= floorf(_phase);

        // --- Publish ---
        _out.volume = _vol;
        _out.volumeRaw = vRaw;
        for (int b = 0; b < kBands; b++) _out.bands[b] = bands[b];
        _out.bass = avg(bands, 0, 5);
        _out.mid = avg(bands, 5, 11);
        _out.treble = avg(bands, 11, 16);
        _out.beat = _beatEnv;
        _out.beatPhase = _phase;
        _out.bpm = _bpm;
        _out.beats = _beats;
        _out.active = true;
        if (!gated && peakBin > 0 && peakBin < N / 2 - 1) {
            // Parabolic interpolation for a sub-bin estimate.
            float l = _mag[peakBin - 1], c = _mag[peakBin], r = _mag[peakBin + 1];
            float den = l - 2.0f * c + r;
            float off = fabsf(den) > 1e-9f ? 0.5f * (l - r) / den : 0.0f;
            _out.peakHz = ((float)peakBin + off) * _sr / (float)N;
        } else {
            _out.peakHz = 0.0f;
        }
    }

    static float avg(const float* v, int a, int b) {
        float s = 0.0f;
        for (int i = a; i < b; i++) s += v[i];
        return s / (float)(b - a);
    }

    void trackTempo() {
        // Lags for 70..180 bpm, weighted toward ~120 so half/double-time ambiguity resolves to
        // the musically usual one.
        const int n = _onsetCount;
        float mean = 0.0f;
        for (int i = 0; i < n; i++) mean += _onset[i];
        mean /= (float)n;
        float r0 = 0.0f;
        for (int i = 0; i < n; i++) { float d = _onset[i] - mean; r0 += d * d; }
        if (r0 <= 1e-6f) return;
        int lagMin = (int)(_frameHz * 60.0f / 180.0f);
        int lagMax = (int)(_frameHz * 60.0f / 70.0f);
        float best = 0.0f; int bestLag = 0;
        for (int lag = lagMin; lag <= lagMax; lag++) {
            float r = 0.0f;
            for (int i = lag; i < n; i++) {
                int p = (_onsetPos - 1 - (i - lag) + 2 * ONSET_LEN) % ONSET_LEN;
                int q = (_onsetPos - 1 - i + 2 * ONSET_LEN) % ONSET_LEN;
                r += (_onset[p] - mean) * (_onset[q] - mean);
            }
            r /= r0;
            float bpm = _frameHz * 60.0f / (float)lag;
            float w = logf(bpm / 120.0f);
            r *= expf(-0.5f * w * w / 0.35f);
            if (r > best) { best = r; bestLag = lag; }
        }
        if (bestLag == 0 || best < 0.08f) return; // no clear periodicity: keep the last tempo
        float bpm = _frameHz * 60.0f / (float)bestLag;
        _bpm = _bpm <= 0.0f || fabsf(bpm - _bpm) > 8.0f ? bpm : _bpm + (bpm - _bpm) * 0.3f;
    }
};

// ---------------------------------------------------------------------------------------
// Simulated source: a deterministic 120 bpm groove (kick on the beat, hats on the offbeats,
// a wandering mid line). Used by the preview with no mic, by node thumbnails and tests, and
// by the device's "Simulated" input, so audio patterns never look dead and always look the
// same at the same timestamp.
// ---------------------------------------------------------------------------------------
inline float simHash(uint32_t n) {
    uint32_t h = n * 0x9E3779B1u + 0x7F4A7C15u;
    h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
    return (float)(h & 0xFFFFFFu) / (float)0x1000000u;
}
inline float simNoise(float t, uint32_t seed) {
    float f = floorf(t);
    uint32_t i = (uint32_t)(int32_t)f;
    float u = t - f; u = u * u * (3.0f - 2.0f * u);
    float a = simHash(i * 7919u + seed), b = simHash((i + 1u) * 7919u + seed);
    return a + (b - a) * u;
}

inline Features simulate(uint32_t tMs) {
    Features f;
    const float bpm = 120.0f;
    float beatsF = (float)tMs * 0.001f * bpm / 60.0f;
    float ph = beatsF - floorf(beatsF);
    float sinceBeat = ph * 60.0f / bpm;              // seconds
    float kick = expf(-sinceBeat / 0.12f);
    float offPh = ph + 0.5f; offPh -= floorf(offPh);
    float hat = expf(-(offPh * 60.0f / bpm) / 0.05f);
    // Every 8 bars, two bars of breakdown (no kick) so tempo-driven looks show variety.
    uint32_t bar = (uint32_t)(beatsF / 4.0f);
    bool breakdown = (bar % 8u) >= 6u;
    if (breakdown) kick *= 0.15f;
    float t = (float)tMs * 0.001f;
    float melody = 0.35f + 0.4f * simNoise(t * 1.3f, 11u);
    for (int b = 0; b < kBands; b++) {
        float p = (float)b / (float)(kBands - 1);
        float k = kick * expf(-p * 9.0f) * 0.95f;                  // low bands
        float m = melody * expf(-(p - 0.45f) * (p - 0.45f) / 0.03f); // mid bump
        float h = hat * 0.7f * expf(-(1.0f - p) * 6.0f);             // top bands
        float tex = 0.08f * simNoise(t * 6.0f + (float)b * 3.1f, 23u);
        f.bands[b] = clamp01(k + m * (0.6f + 0.4f * simNoise(t * 3.0f + (float)b, 5u)) + h + tex);
    }
    float bass = 0.0f; for (int b = 0; b < 5; b++) bass += f.bands[b]; f.bass = bass / 5.0f;
    float mid = 0.0f; for (int b = 5; b < 11; b++) mid += f.bands[b]; f.mid = mid / 6.0f;
    float tr = 0.0f; for (int b = 11; b < 16; b++) tr += f.bands[b]; f.treble = tr / 5.0f;
    f.volumeRaw = clamp01(0.25f + 0.5f * kick + 0.2f * melody + 0.1f * hat);
    f.volume = clamp01(0.3f + 0.3f * expf(-sinceBeat / 0.4f) * (breakdown ? 0.3f : 1.0f) + 0.2f * melody);
    f.beat = breakdown ? 0.0f : expf(-sinceBeat / 0.15f);
    f.beatPhase = ph;
    f.bpm = bpm;
    f.peakHz = breakdown ? 440.0f + 220.0f * simNoise(t, 3u) : 55.0f;
    f.beats = (uint32_t)beatsF;
    f.active = true;
    return f;
}

// Where the host's features come from. The preview defaults to SIMULATED; the firmware to
// whatever input is configured (NONE leaves everything at 0).
enum Source : uint8_t { SOURCE_NONE = 0, SOURCE_LIVE = 1, SOURCE_SIMULATED = 2 };
inline uint8_t g_source = SOURCE_NONE;

// For hosts that render on a timestamp: refresh g_features from the simulation when that is
// the source. Cheap; no-op for other sources.
inline void tick(uint32_t tMs) {
    if (g_source == SOURCE_SIMULATED) g_features = simulate(tMs);
}

} // namespace Audio
