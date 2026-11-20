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
        memset(_bandPeak, 0, sizeof(_bandPeak));
        memset(_bandFloor, 0, sizeof(_bandFloor));
        _onsetPos = 0; _onsetCount = 0;
        _fluxMean = 0.0f; _fluxVar = 0.0f;
        _dc = 0.0f; _agcMul = 1.0f; _agcEnv = 0.0f;
        _vol = 0.0f; _beatEnv = 0.0f; _sinceBeat = 1000.0f; _sinceOnset = 1000.0f; _sinceAligned = 1000.0f;
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
    float _bandPeak[kBands];
    float _bandFloor[kBands];
    float _onset[ONSET_LEN];
    int _onsetPos = 0, _onsetCount = 0;
    float _fluxMean = 0.0f, _fluxVar = 0.0f;
    float _dc = 0.0f;
    float _agcMul = 1.0f, _agcEnv = 0.0f;
    float _vol = 0.0f;
    float _level = 0.0f;
    float _beatEnv = 0.0f, _sinceBeat = 1000.0f; // seconds since last beat
    float _sinceOnset = 1000.0f;                  // seconds since the last raw onset
    float _sinceAligned = 1000.0f;                // seconds since an onset landed on the beat clock
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
        float raw[kBands], allPeak = 0.0f;
        const float peakDecay = expf(-dt / 3.0f); // band ceilings relax over ~3 s
        for (int b = 0; b < kBands; b++) {
            float pw = 0.0f;
            for (int k = _edge[b]; k < _edge[b + 1]; k++) pw += _mag[k] * _mag[k];
            float amp = sqrtf(pw);
            // Music falls off ~3 dB/octave and the high bands are wider, but each high bin also
            // carries less: a gentle tilt keeps treble visible without a hiss floor.
            float tilt = 1.0f + 0.12f * (float)b;
            raw[b] = gated ? 0.0f : amp * gainMul * tilt * 6.0f;
            _bandPeak[b] = fmaxf(raw[b], _bandPeak[b] * peakDecay);
            // The band's floor: drops to a quiet moment at once, creeps up over ~2 s.
            _bandFloor[b] = raw[b] < _bandFloor[b] ? raw[b] : _bandFloor[b] + (raw[b] - _bandFloor[b]) * (dt / 2.0f);
            allPeak = fmaxf(allPeak, _bandPeak[b]);
        }
        for (int b = 0; b < kBands; b++) {
            float v;
            if (cfg.agc != AGC_OFF) {
                // With auto level, each band is stretched between its own recent floor and peak
                // (the peak blended with the loudest band's, so a near-silent band isn't blown
                // up). One shared gain pinned the busy mid bands at the top, where they couldn't
                // move; this way quiet moments dip and hits stand out, in every band.
                float ceil = fmaxf(0.6f * _bandPeak[b] + 0.4f * allPeak, 0.02f);
                float floor = fminf(_bandFloor[b], ceil * 0.7f);
                v = clamp01((raw[b] - floor) / (ceil - floor) * 0.9f);
            } else {
                v = clamp01(raw[b]);
            }
            v = clamp01(scaleBand(v));
            // Fast attack; release on the same fall time as volume, capped at ~0.12 s: music
            // re-hits most bands every sixteenth note (~0.12 s), and a slower release just
            // holds every bar at its peak.
            float rel = fminf(fallS, 0.12f);
            _bandSm[b] = v > _bandSm[b] ? v : _bandSm[b] + (v - _bandSm[b]) * (1.0f - expf(-dt / rel));
            bands[b] = _bandSm[b];
        }

        // --- Onsets: spectral flux of log magnitude, led by the low end ---
        // A beat is mostly a kick (< ~250 Hz) or a snare (its body plus a burst of noise).
        // Weighting by band, rather than summing every bin equally, keeps the many mid and
        // high bins (arpeggios, hats, vocals) from turning every sixteenth note into a "beat".
        float fluxLow = 0.0f, fluxMid = 0.0f, fluxHigh = 0.0f;
        const int lowTop = (int)(250.0f * (float)N / _sr);
        const int midTop = (int)(2000.0f * (float)N / _sr);
        for (int k = 1; k < N / 2; k++) {
            float lm = logf(1.0f + 100.0f * _mag[k] * mul);
            float d = lm - _prevLog[k];
            if (d > 0.0f) {
                if (k <= lowTop) fluxLow += d;
                else if (k <= midTop) fluxMid += d;
                else fluxHigh += d;
            }
            _prevLog[k] = lm;
        }
        float flux = 3.0f * fluxLow + 0.25f * fluxMid + 0.08f * fluxHigh;
        if (gated) flux = 0.0f;
        // Adaptive threshold: running mean + 1.6 sigma (~1 s memory).
        float a = dt / 1.0f;
        float dev = flux - _fluxMean;
        _fluxMean += dev * a;
        _fluxVar += (dev * dev - _fluxVar) * a;
        float thresh = _fluxMean + 1.6f * sqrtf(_fluxVar) + 0.5f;
        _sinceBeat += dt;
        _sinceOnset += dt;
        bool onset = !gated && flux > thresh && _sinceOnset > 0.15f;
        float onsetStrength = flux > _fluxMean ? (flux - _fluxMean) : 0.0f;
        _onset[_onsetPos] = onsetStrength;
        _onsetPos = (_onsetPos + 1) % ONSET_LEN;
        if (_onsetCount < ONSET_LEN) _onsetCount++;

        // --- Tempo: autocorrelate the onset history every ~0.5 s ---
        if (++_framesSinceTempo >= (int)(_frameHz * 0.5f) && _onsetCount >= ONSET_LEN / 2) {
            _framesSinceTempo = 0;
            trackTempo();
        }

        // --- Beats ---
        // Raw onsets fire on every kick, snare, bass note and loud hat, which in most music is
        // several per beat. Once a tempo is known, beats come from the beat clock instead, and
        // onsets only keep that clock aligned (an onset close to a predicted beat pulls the
        // phase toward it) and keep it alive (no onsets for two beats, e.g. a breakdown, and
        // the beats stop until the rhythm returns). Before a tempo is found, onsets are beats.
        const float period = _bpm > 0.0f ? 60.0f / _bpm : 0.5f;
        bool snapped = false;
        if (onset) {
            _sinceOnset = 0.0f;
            if (_bpm > 0.0f) {
                float e = _phase > 0.5f ? _phase - 1.0f : _phase; // -0.5..0.5, 0 = on the beat
                if (fabsf(e) < 0.2f) { _phase -= 0.3f * e; _sinceAligned = 0.0f; }
                else if (_sinceAligned > 2.0f * period) {
                    // Lost (or never had) the beat: this onset starts the clock afresh.
                    _phase = 0.0f; _sinceAligned = 0.0f; snapped = true;
                }
            }
        }
        _sinceAligned += dt;
        const float before = _phase;
        _phase += dt / period;
        _phase -= floorf(_phase);
        bool beat;
        if (_bpm > 0.0f) beat = (snapped || _phase < before) && _sinceAligned < 2.0f * period && !gated && _sinceBeat > 0.5f * period;
        else beat = onset && _sinceBeat > 0.22f;
        if (beat) {
            _sinceBeat = 0.0f;
            _beatEnv = 1.0f;
            _beats++;
        } else {
            _beatEnv *= expf(-dt / 0.15f);
        }

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
// Simulated source: a small synthesized track, played through the same Analyzer a mic uses,
// so the preview (and the device's "Simulated" mic) behaves like real music rather than like
// hand-drawn curves: drum hits with real transients, a bassline and chords moving across the
// bands, hats that sometimes trip the beat detector, AGC and smoothing doing their thing.
//
// 122 bpm, A minor (Am F C G), 16 bars that loop: 8 bars full, 4 bars of breakdown (pads and
// arp, no kick) ending in a snare build, 4 bars full again with a fill at the end. Everything
// is deterministic from the sample index, and costs a handful of table lookups per sample.
// ---------------------------------------------------------------------------------------
inline float simHash(uint32_t n) {
    uint32_t h = n * 0x9E3779B1u + 0x7F4A7C15u;
    h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
    return (float)(h & 0xFFFFFFu) / (float)0x1000000u;
}

class Groove {
public:
    static constexpr float SR = 22050.0f;
    static constexpr float BPM = 122.0f;

    Groove() {
        for (int i = 0; i <= TABLE; i++) _sin[i] = sinf(6.28318531f * (float)i / (float)TABLE);
        seek(0);
    }

    /** Jump to a sample position (all voices silent; they start on their next trigger). */
    void seek(uint64_t sample) {
        _n = sample;
        _kick = _snare = _hat = _bass = _arp = Voice{};
        _kickPitch = 0.0f; _bassBright = 0.0f; _bassGate = 0;
        for (Voice& v : _pad) v = Voice{};
        _padLevel = 0.0f;
        _noisePrev = _hp1 = 0.0f;
        _lastStep = UINT64_MAX;
    }
    uint64_t position() const { return _n; }

    float next() {
        const uint64_t step = _n / SPS;
        if (step != _lastStep) { _lastStep = step; trigger(step); }
        const uint32_t bar = (uint32_t)((step / 16) % 16);
        const bool breakdown = bar >= 8 && bar < 12;

        // Noise, and a crude two-stage high-pass of it for the hats.
        float noise = simHash((uint32_t)_n ^ 0x51ED270Bu) * 2.0f - 1.0f;
        float hp = noise - _noisePrev; _noisePrev = noise;
        float hp2 = hp - _hp1; _hp1 = hp;

        float out = 0.0f;
        // Kick: a sine swept from ~160 Hz down to ~48 Hz, with a click.
        if (_kick.env > 1e-4f) {
            float f = 48.0f + 110.0f * _kickPitch;
            _kick.phase = wrap(_kick.phase + f / SR);
            out += 0.75f * _kick.env * sinAt(_kick.phase) + 0.15f * noise * _kick.env * _kickPitch * _kickPitch;
            _kick.env *= 0.99975f;           // ~180 ms
            _kickPitch *= 0.9985f;           // ~30 ms
        }
        // Snare: a 190 Hz body plus noise.
        if (_snare.env > 1e-4f) {
            _snare.phase = wrap(_snare.phase + 190.0f / SR);
            out += _snare.amp * _snare.env * (0.35f * sinAt(_snare.phase) + 0.6f * (0.6f * noise + 0.4f * hp));
            _snare.env *= 0.99963f;          // ~120 ms
        }
        // Hats: high-passed noise, closed (short) or open (long).
        if (_hat.env > 1e-4f) {
            out += _hat.amp * _hat.env * hp2 * 0.5f;
            _hat.env *= _hat.decay;
        }
        // Bass: a plucked saw (5 harmonics) whose brightness falls after each note.
        if (_bass.env > 1e-4f) {
            _bass.phase = wrap(_bass.phase + _bass.freq / SR);
            float w = 0.0f;
            for (int k = 1; k <= 5; k++) w += sinAt(_bass.phase * (float)k) * (k == 1 ? 1.0f : _bassBright / (float)k);
            out += 0.32f * _bass.env * w;
            _bass.env *= (_bassGate > 0 ? 0.99990f : 0.9990f);
            if (_bassGate > 0) _bassGate--;
            _bassBright *= 0.99955f;
        }
        // Pad: the chord, held, swelling up in the breakdown.
        float padTarget = breakdown ? 0.16f : 0.07f;
        _padLevel += (padTarget - _padLevel) * 0.00004f;
        for (Voice& v : _pad) {
            v.phase = wrap(v.phase + v.freq / SR);
            out += _padLevel * (sinAt(v.phase) + 0.3f * sinAt(v.phase * 2.0f) + 0.12f * sinAt(v.phase * 3.0f));
        }
        // Arp: plucked chord tones two octaves up, sixteenth notes.
        if (_arp.env > 1e-4f) {
            _arp.phase = wrap(_arp.phase + _arp.freq / SR);
            out += _arp.amp * _arp.env * (sinAt(_arp.phase) + 0.25f * sinAt(_arp.phase * 2.0f));
            _arp.env *= 0.99955f;            // ~100 ms
        }
        _n++;
        // Soft clip.
        out *= 0.55f;
        return out / (1.0f + fabsf(out));
    }

private:
    static constexpr int TABLE = 1024;
    static constexpr uint64_t SPS = (uint64_t)(SR * 60.0f / BPM / 4.0f + 0.5f); // samples per 16th
    float _sin[TABLE + 1];
    struct Voice { float phase = 0.0f, freq = 0.0f, env = 0.0f, amp = 0.0f, decay = 0.0f; };
    Voice _kick, _snare, _hat, _bass, _arp, _pad[3];
    float _kickPitch = 0.0f, _bassBright = 0.0f, _padLevel = 0.0f;
    uint32_t _bassGate = 0;
    float _noisePrev = 0.0f, _hp1 = 0.0f;
    uint64_t _n = 0, _lastStep = UINT64_MAX;

    static float wrap(float p) { return p >= 1.0f ? p - floorf(p) : p; }
    float sinAt(float phase) const {
        float x = (phase - floorf(phase)) * (float)TABLE;
        int i = (int)x;
        float t = x - (float)i;
        return _sin[i] + (_sin[i + 1] - _sin[i]) * t;
    }

    // Chords per bar (Am F C G): bass root, then pad/arp tones.
    static const float* chord(uint32_t bar) {
        static const float CH[4][4] = {
            { 55.00f, 220.00f, 261.63f, 329.63f },  // Am
            { 43.65f, 174.61f, 220.00f, 261.63f },  // F
            { 65.41f, 261.63f, 329.63f, 392.00f },  // C
            { 49.00f, 196.00f, 246.94f, 293.66f },  // G
        };
        return CH[bar % 4];
    }

    void trigger(uint64_t step) {
        const uint32_t s = (uint32_t)(step % 16);
        const uint32_t bar = (uint32_t)((step / 16) % 16);
        const bool breakdown = bar >= 8 && bar < 12;
        const bool build = bar == 11;
        const bool fill = bar == 15 && s >= 12;
        const float* c = chord(bar);
        auto rnd = [&](uint32_t salt) { return simHash((uint32_t)step * 31u + salt); };

        // Pad follows the chord (retuned on each bar; the level fades rather than retriggers).
        if (s == 0) for (int i = 0; i < 3; i++) _pad[i].freq = c[1 + i] * (1.0f + 0.002f * (float)(i - 1));

        // Kick: four on the floor, a pickup on bar 7, silent in the breakdown and the fill.
        bool kick = !breakdown && !fill && (s % 4 == 0 || (bar % 8 == 7 && s == 11) || (bar % 4 == 3 && s == 14 && rnd(1) < 0.5f));
        if (kick) { _kick.env = 1.0f; _kickPitch = 1.0f; _kick.phase = 0.0f; }

        // Snare on 2 and 4; a rising sixteenth roll in the build; a fill at the end.
        bool snare = (!breakdown && (s == 4 || s == 12)) || (build && (s % 2 == 0 || s >= 8)) || fill;
        if (snare) {
            _snare.env = 1.0f; _snare.phase = 0.0f;
            _snare.amp = build ? 0.15f + 0.35f * (float)s / 15.0f : (fill ? 0.35f + 0.1f * rnd(2) : 0.45f);
        }

        // Hats: off-beats loud, other sixteenths ghosted, an open hat now and then.
        bool openHat = !breakdown && s == 14 && rnd(3) < 0.6f;
        if (openHat) { _hat.env = 1.0f; _hat.amp = 0.35f; _hat.decay = 0.99975f; }
        else if (s % 4 == 2) { _hat.env = 1.0f; _hat.amp = breakdown ? 0.12f : 0.28f; _hat.decay = 0.9985f; }
        else if (!breakdown && rnd(4) < 0.7f) { _hat.env = 1.0f; _hat.amp = 0.06f + 0.08f * rnd(5); _hat.decay = 0.9980f; }

        // Bass: a syncopated root/octave line, held a step and a half.
        static const int8_t BASS[16] = { 1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 3, 1, 0, 0, 2, 0 };
        if (!breakdown && BASS[s]) {
            float f = c[0] * (BASS[s] == 2 ? 2.0f : (BASS[s] == 3 ? 1.5f : 1.0f));
            if (_bass.env < 0.05f || fabsf(f - _bass.freq) > 0.1f) _bass.phase = 0.0f;
            _bass.freq = f; _bass.env = 1.0f; _bassBright = 1.0f;
            _bassGate = (uint32_t)(SPS * 3 / 2);
        }

        // Arp: chord tones two octaves up; sparse in the breakdown.
        static const uint8_t ARP[8] = { 0, 1, 2, 1, 0, 2, 1, 2 };
        if (!breakdown || s % 2 == 0) {
            _arp.freq = c[1 + ARP[s % 8]] * 2.0f;
            _arp.env = 1.0f;
            _arp.amp = (breakdown ? 0.18f : 0.10f) * (0.7f + 0.3f * rnd(6));
        }
    }
};

// Where the host's features come from. The preview defaults to SIMULATED; the firmware to
// whatever input is configured (NONE leaves everything at 0).
enum Source : uint8_t { SOURCE_NONE = 0, SOURCE_LIVE = 1, SOURCE_SIMULATED = 2 };
inline uint8_t g_source = SOURCE_NONE;

/** The Groove played into an Analyzer, kept in step with a render clock. */
class Simulator {
public:
    Simulator() : _an(Groove::SR) { _an.cfg.agc = AGC_NORMAL; }

    // Bring the analysis up to `tMs`. A step back of up to 250 ms (several previews in one
    // frame, each reading the clock a few ms apart) is ignored; a bigger jump either way
    // restarts at that spot in the song with a short pre-roll, so the analyzer has settled by
    // the time anyone looks, and a given timestamp reached by a jump always reads the same.
    void advanceTo(uint32_t tMs) {
        const uint64_t target = (uint64_t)tMs * (uint64_t)Groove::SR / 1000u;
        const uint64_t at = _g.position();
        if (!_started || target + (uint64_t)Groove::SR / 4 < at || target > at + (uint64_t)Groove::SR * 3) {
            // Long enough for the tempo tracker (~3 s of onsets) to lock before anyone looks.
            const uint64_t preroll = (uint64_t)Groove::SR * 4;
            _an.reset();
            _g.seek(target > preroll ? target - preroll : 0);
            _started = true;
        }
        float buf[256];
        while (_g.position() < target) {
            int n = 0;
            while (n < 256 && _g.position() < target) buf[n++] = _g.next();
            _an.push(buf, n);
        }
        _out = _an.features();
    }
    const Features& features() const { return _out; }

private:
    Groove _g;
    Analyzer _an;
    Features _out;
    bool _started = false;
};

inline Simulator* g_sim = nullptr;

// For hosts that render on a timestamp: refresh g_features from the simulation when that is
// the source. A no-op for other sources. The simulator (~20 KB) is made on first use.
inline void tick(uint32_t tMs) {
    if (g_source != SOURCE_SIMULATED) return;
    if (!g_sim) g_sim = new Simulator();
    g_sim->advanceTo(tMs);
    g_features = g_sim->features();
}

/** Free the simulator (the firmware calls this when the input is switched away from it). */
inline void releaseSimulator() { delete g_sim; g_sim = nullptr; }

} // namespace Audio
