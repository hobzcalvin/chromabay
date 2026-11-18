// Host checks for the SK9822 per-pixel 5-bit current level split. No hardware, no PlatformIO:
//
//   c++ -std=c++17 -O1 -Wall esp32/test/sk9822_hd_test.cpp -o /tmp/sk9822_hd_test && /tmp/sk9822_hd_test
//
// CI runs it as the sk9822-hd scenario of esp32/test/emu/run.mjs (firmware-emu.yml).
//
// What has to hold: the light out (PWM/255 * level/31) equals the requested linear target to
// within half a PWM step at the chosen level; the level is the lowest that fits (so the PWM keeps
// the most resolution); nothing overflows; and at low brightness the split resolves far finer
// than plain 8-bit dimming did.
#include "../src/sk9822_hd.h"
#include <cmath>
#include <cstdio>
#include <random>

static int failures = 0;
static void check(bool ok, const char* what) {
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) failures++;
}

using namespace Sk9822Hd;

// Light out as a fraction of full scale, for PWM value v (with f fraction bits) at level g.
static double emitted(uint16_t v, uint8_t g, uint8_t f) {
    return (double)v / (double)(255u << f) * (double)g / 31.0;
}

int main() {
    // Edges.
    check(chooseLevel(0) == 1, "black picks the lowest level");
    check(chooseLevel(kFull) == 31, "full white needs full current");
    check(chooseLevel(1) == 1, "the faintest light fits level 1");
    for (uint8_t f = 0; f <= 3; f++) {
        check(scaleChannel(kFull, 31, f) == (255u << f), "full white is full PWM at level 31");
        check(scaleChannel(0, 7, f) == 0, "zero stays zero");
    }
    // Exactly at a level boundary: kFull * g / 31 needs level g and full PWM.
    bool boundary = true;
    for (uint8_t g = 1; g <= 31; g++) {
        uint32_t T = (uint32_t)((uint64_t)kFull * g / 31);
        uint8_t lv = chooseLevel(T);
        if (lv != g || scaleChannel(T, lv, 0) < 254) boundary = false;
    }
    check(boundary, "level boundaries map to that level at ~full PWM");

    // Random targets: accuracy, minimal level, no overflow.
    std::mt19937 rng(9822);
    bool accurate = true, minimal = true, inRange = true, monotone = true;
    for (int i = 0; i < 200000; i++) {
        // Bias towards dim values, where it matters: exponent spread over ~5 decades.
        double frac = std::pow(10.0, -5.0 * std::uniform_real_distribution<double>(0, 1)(rng));
        uint32_t maxT = (uint32_t)(frac * kFull);
        uint32_t T[3] = { maxT, (uint32_t)(maxT * std::uniform_real_distribution<double>(0, 1)(rng)),
                          (uint32_t)(maxT * std::uniform_real_distribution<double>(0, 1)(rng)) };
        uint8_t g = chooseLevel(maxT);
        if (g > 1 && (uint64_t)maxT * 31 <= (uint64_t)kFull * (g - 1)) minimal = false;
        for (uint8_t f = 0; f <= 3; f++) {
            for (int ch = 0; ch < 3; ch++) {
                uint16_t v = scaleChannel(T[ch], g, f);
                if (v > (255u << f)) inRange = false;
                double want = (double)T[ch] / kFull;
                double step = 1.0 / (double)(255u << f) * g / 31.0;   // one PWM step at level g
                if (std::fabs(emitted(v, g, f) - want) > 0.5 * step + 1e-12) accurate = false;
            }
            // Same level, larger target -> not smaller output.
            if (scaleChannel(T[0], g, f) < scaleChannel(T[1], g, f) && T[0] >= T[1]) monotone = false;
        }
    }
    check(accurate, "output matches the target within half a PWM step at its level");
    check(minimal, "chosen level is the lowest that fits the brightest channel");
    check(inRange, "PWM never exceeds full scale");
    check(monotone, "larger target never gives a smaller PWM at the same level");

    // The point of it: resolution at low brightness. A pixel at 1/16 brightness used to have
    // 16 PWM steps (8-bit dimming); with the current level it keeps (nearly) the full range.
    uint32_t dim = kFull / 16;
    uint8_t g = chooseLevel(dim);
    uint16_t v = scaleChannel(dim, g, 0);
    check(g == 2 && v >= 240, "1/16 brightness runs at level 2 with ~full 8-bit PWM range");
    // Distinct output values available across 0..1/16 of full scale: plain 8-bit dimming has
    // 16; the split gives ~384 (256 PWM steps at level 1, then about 128 new ones at level 2).
    int distinct = 0; double last = -1;
    for (uint32_t t = 0; t <= dim; t += dim / 4096) {
        uint8_t lv = chooseLevel(t);
        double e = emitted(scaleChannel(t, lv, 0), lv, 0);
        if (e != last) { distinct++; last = e; }
    }
    char msg[120];
    snprintf(msg, sizeof msg, "%d distinct light levels below 1/16 brightness (8-bit dimming: 16)", distinct);
    check(distinct >= 350, msg);

    printf("%s\n", failures ? "FAILED" : "all ok");
    return failures ? 1 : 0;
}
