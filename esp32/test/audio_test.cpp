// Host checks for the audio analyzer (native/AudioReactive.h) and the audio automation shapes.
// No hardware, no FastLED:
//
//   g++ -std=c++17 -O1 -Wall esp32/test/audio_test.cpp -o /tmp/audio_test && /tmp/audio_test
//
// CI runs it as the audio scenario of esp32/test/emu/run.mjs (firmware-emu.yml).
//
// Signals are synthetic (sines, noise, a kick drum at a known tempo), so each check states a
// property a real mic should also show: a tone lights the band it belongs to, silence below
// the gate reads zero, AGC lifts a quiet input, a 128 bpm kick is detected and tracked.
#include "../../native/AudioReactive.h"
#include "../../native/Modulation.h"
#include <cstdio>
#include <vector>
#include <random>

static int failures = 0;
static void check(bool ok, const char* what) {
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) failures++;
}

static const float SR = 22050.0f;

static std::vector<float> sine(float hz, float amp, float seconds) {
    std::vector<float> v((size_t)(SR * seconds));
    for (size_t i = 0; i < v.size(); i++) v[i] = amp * sinf(6.28318531f * hz * (float)i / SR);
    return v;
}

static int loudestBand(const Audio::Features& f) {
    int best = 0;
    for (int b = 1; b < Audio::kBands; b++) if (f.bands[b] > f.bands[best]) best = b;
    return best;
}

// A synthetic kick: a decaying 55 Hz thump every beat, plus quiet noise between beats.
static std::vector<float> kicks(float bpm, float seconds, unsigned seed = 1) {
    std::mt19937 rng(seed);
    std::normal_distribution<float> n(0.0f, 0.004f);
    std::vector<float> v((size_t)(SR * seconds));
    const float period = 60.0f / bpm;
    for (size_t i = 0; i < v.size(); i++) {
        float t = (float)i / SR;
        float since = fmodf(t, period);
        float env = expf(-since / 0.06f);
        v[i] = 0.5f * env * sinf(6.28318531f * (55.0f + 60.0f * expf(-since / 0.02f)) * since) + n(rng);
    }
    return v;
}

int main() {
    // --- Tones land in the right band, low to high ---
    {
        int prevBand = -1; bool ordered = true;
        for (float hz : { 60.0f, 250.0f, 1000.0f, 4000.0f }) {
            Audio::Analyzer a(SR);
            auto s = sine(hz, 0.1f, 0.5f);
            a.push(s.data(), (int)s.size());
            int b = loudestBand(a.features());
            printf("      %5.0f Hz -> band %d (peak %.0f Hz, vol %.2f)\n", hz, b, a.features().peakHz, a.features().volume);
            if (b <= prevBand) ordered = false;
            prevBand = b;
        }
        check(ordered, "higher tones light higher bands");
        Audio::Analyzer a(SR);
        auto s = sine(1000.0f, 0.1f, 0.5f);
        a.push(s.data(), (int)s.size());
        check(fabsf(a.features().peakHz - 1000.0f) < 25.0f, "peak frequency of a 1 kHz tone reads ~1 kHz");
        check(a.features().volume > 0.2f && a.features().volume < 1.0f, "a -20 dBFS tone gives a mid-range volume");
    }

    // --- Noise gate (squelch) ---
    {
        Audio::Analyzer a(SR);
        auto s = sine(300.0f, 0.001f, 0.5f); // ~-60 dBFS: room hiss
        a.push(s.data(), (int)s.size());
        check(a.features().volume == 0.0f && a.features().bass == 0.0f && a.features().mid == 0.0f,
              "input under the squelch reads as silence");
        a.cfg.squelch = 0;
        a.push(s.data(), (int)s.size());
        check(a.features().volume > 0.0f, "...and is heard with squelch 0");
    }

    // --- Gain and AGC ---
    {
        Audio::Analyzer lo(SR), hi(SR);
        hi.cfg.gain = 160;
        auto s = sine(500.0f, 0.02f, 0.5f);
        lo.push(s.data(), (int)s.size());
        hi.push(s.data(), (int)s.size());
        check(hi.features().volume > lo.features().volume * 1.5f, "more gain reads louder");

        Audio::Analyzer agc(SR);
        agc.cfg.agc = Audio::AGC_NORMAL;
        auto q = sine(500.0f, 0.01f, 12.0f);
        agc.push(q.data(), (int)q.size());
        Audio::Analyzer off(SR);
        off.push(q.data(), (int)q.size());
        printf("      quiet tone: AGC %.2f vs off %.2f\n", agc.features().volume, off.features().volume);
        check(agc.features().volume > off.features().volume * 2.0f && agc.features().volume > 0.4f,
              "AGC lifts a quiet input toward its target");
    }

    // --- Beats and tempo ---
    {
        Audio::Analyzer a(SR);
        auto s = kicks(128.0f, 12.0f);
        uint32_t beatsAt4 = 0;
        const int chunk = 256;
        for (size_t i = 0; i + chunk <= s.size(); i += chunk) {
            a.push(s.data() + i, chunk);
            if (i < (size_t)(SR * 4.0f)) beatsAt4 = a.features().beats;
        }
        uint32_t counted = a.features().beats - beatsAt4; // 8 s of a 128 bpm kick ≈ 17 beats
        printf("      beats in 8 s: %u, bpm %.1f\n", counted, a.features().bpm);
        check(counted >= 14 && counted <= 20, "a 128 bpm kick is detected beat by beat");
        check(fabsf(a.features().bpm - 128.0f) < 4.0f, "tempo of a 128 bpm kick is tracked");
    }

    // --- Modulation: audio shapes read the features, release smooths the fall ---
    {
        Audio::Features f; f.volume = 1.0f; f.bass = 0.5f;
        Audio::set(f);
        check(fabsf(Modulation::modulate(Modulation::AUDIO_VOLUME, 10.0f, 20.0f, 0.0f, 0, 0) - 20.0f) < 1e-4f,
              "volume 1.0 maps to the top of the range");
        check(fabsf(Modulation::modulate(Modulation::AUDIO_BASS, 0.0f, 2.0f, 0.0f, 0, 0) - 1.0f) < 1e-4f,
              "bass 0.5 maps to the middle");
        Modulation::ModState st;
        Modulation::modulate(st, Modulation::AUDIO_VOLUME, 0.0f, 1.0f, 0.5f, 1000, 0);
        f.volume = 0.0f; Audio::set(f);
        float after = Modulation::modulate(st, Modulation::AUDIO_VOLUME, 0.0f, 1.0f, 0.5f, 1500, 0);
        check(after > 0.3f && after < 0.45f, "release of 0.5 s falls to ~37% after 0.5 s");
        f.beats = 3; f.beatPhase = 0.0f; Audio::set(f);
        check(fabsf(Modulation::modulate(Modulation::BEAT_WAVE, 0.0f, 1.0f, 1.0f, 0, 0) - 1.0f) < 1e-4f,
              "beat wave peaks on the beat");
        float ramp4 = Modulation::modulate(Modulation::BEAT_RAMP, 0.0f, 1.0f, 4.0f, 0, 0);
        check(fabsf(ramp4 - 0.75f) < 1e-4f, "a 4-beat ramp is 3/4 through on beat 3");
    }

    // --- Simulation: the synthesized groove through the analyzer behaves like music ---
    {
        Audio::Groove g;
        std::vector<float> track(SR * 16);
        float peak = 0.0f;
        for (auto& x : track) { x = g.next(); peak = fmaxf(peak, fabsf(x)); }
        check(peak > 0.2f && peak < 1.0f, "the groove is loud but unclipped");

        Audio::Analyzer a(SR);
        a.cfg.agc = Audio::AGC_NORMAL;
        uint32_t beatsAt4 = 0;
        float lowMax = 0, highMax = 0, volMin = 1, volMax = 0;
        for (size_t i = 0; i + 256 <= track.size(); i += 256) {
            a.push(track.data() + i, 256);
            const auto& f = a.features();
            if (i < (size_t)(SR * 4)) { beatsAt4 = f.beats; continue; }
            if (i > (size_t)(SR * 15.7)) break;           // bars 0-7 are the full groove
            lowMax = fmaxf(lowMax, f.bass); highMax = fmaxf(highMax, f.treble);
            volMin = fminf(volMin, f.volume); volMax = fmaxf(volMax, f.volume);
        }
        uint32_t beats = a.features().beats - beatsAt4; // ~11.7 s of 122 bpm ≈ 24 beats
        printf("      groove: %u beats in 11.7 s, bpm %.1f, bass max %.2f, treble max %.2f, volume %.2f..%.2f\n",
               beats, a.features().bpm, lowMax, highMax, volMin, volMax);
        check(beats >= 18 && beats <= 34, "the groove's kick and snare are detected as beats");
        check(fabsf(a.features().bpm - 122.0f) < 5.0f || fabsf(a.features().bpm - 61.0f) < 3.0f, "its tempo is tracked (122 bpm)");
        check(lowMax > 0.3f && highMax > 0.1f, "it lights both the low and the high bands");
        check(volMax - volMin > 0.1f, "its volume moves");

        // Beats land on the kick (the grid is every 60/122 s from the start), and thin out in the
        // breakdown (bars 8-11, no kick) compared with the groove around it.
        {
            Audio::Groove g2;
            Audio::Analyzer b(SR);
            b.cfg.agc = Audio::AGC_NORMAL;
            const float period = 60.0f / Audio::Groove::BPM, bar = 4.0f * period;
            uint32_t prev = 0;
            int onGrid = 0, total = 0, inDrop = 0, inBreak = 0;
            std::vector<float> buf(256);
            for (size_t i = 0; i < (size_t)(SR * bar * 12); i += 256) {
                for (auto& x : buf) x = g2.next();
                b.push(buf.data(), 256);
                if (b.features().beats == prev) continue;
                prev = b.features().beats;
                float t = (float)(i + 256) / SR;
                if (t < 6.0f) continue; // tempo lock-in
                float barPos = t / bar;
                if (barPos >= 4.0f && barPos < 8.0f) inDrop++;
                if (barPos >= 8.0f && barPos < 12.0f) inBreak++;
                if (barPos < 8.0f) {
                    float e = fmodf(t, period); if (e > period / 2) e -= period;
                    total++; if (fabsf(e) < 0.06f) onGrid++;
                }
            }
            printf("      beats on the kick grid: %d/%d; bars 4-7: %d beats, breakdown bars 8-11: %d\n", onGrid, total, inDrop, inBreak);
            check(total > 0 && onGrid >= total * 8 / 10, "beats land on the kick (within 60 ms)");
            check(inBreak < inDrop * 3 / 4, "beats thin out when the kick drops out");
        }

        // Deterministic: the same clock gives the same features.
        Audio::Simulator s1, s2;
        s1.advanceTo(5000); s2.advanceTo(2000); s2.advanceTo(5000);
        Audio::Simulator s3; s3.advanceTo(5000);
        const auto &f1 = s1.features(), &f3 = s3.features();
        check(memcmp(f1.bands, f3.bands, sizeof(f1.bands)) == 0 && f1.volume == f3.volume && f1.beats == f3.beats,
              "the simulator is deterministic");
        check(s2.features().active, "the simulator follows a clock that moves forward");
    }

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "all passed", failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
