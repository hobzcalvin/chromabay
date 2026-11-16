#pragma once
// Content generations: one counter each for the LED config, the custom layouts and the pattern
// library, bumped whenever that content changes and reported in device info ("gcfg", "glay",
// "glib", feat >= 9). The app keeps what it last read from a device, tagged with these; on a
// reconnect it reads device info (~300 B), sees nothing changed, and skips re-reading the
// config, every strip's layout and the whole library — which over BLE is many KB and seconds.
//
// Persisted in NVS so a reboot (a sculpture on a timer, a power cut) doesn't throw the app's
// copy away. A fresh namespace (new board, erased flash) starts each counter at a RANDOM value:
// starting at 0 could count back up to a number the app has cached for different content.
// Bumped BEFORE nothing else can observe the change being reported, i.e. right after the
// content is written — if power is lost in between, the counter is merely one behind, which
// the next change fixes; it never reports new content under an old number unless the write
// to NVS itself is lost, and then the app is at worst showing the previous content.
#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>

namespace ContentGen {

enum Kind : uint8_t { CFG = 0, LAY = 1, LIB = 2 };
static const char *NS = "cbaygen";
static const char *const KEYS[3] = {"cfg", "lay", "lib"};
inline uint32_t gGen[3] = {0, 0, 0};

inline void begin() {
    Preferences p;
    bool have = p.begin(NS, /*readOnly=*/true);
    bool missing = !have;
    if (have) {
        for (int k = 0; k < 3; k++) {
            if (p.isKey(KEYS[k])) gGen[k] = p.getUInt(KEYS[k], 0);
            else missing = true;
        }
        p.end();
    }
    if (!missing) return;
    if (p.begin(NS, /*readOnly=*/false)) {
        for (int k = 0; k < 3; k++) {
            if (!p.isKey(KEYS[k])) { gGen[k] = esp_random(); p.putUInt(KEYS[k], gGen[k]); }
        }
        p.end();
    }
}

/** Record that `k`'s content changed. Loop task (NVS write, a few ms). */
inline void bump(Kind k) {
    gGen[k]++;
    Preferences p;
    if (p.begin(NS, /*readOnly=*/false)) { p.putUInt(KEYS[k], gGen[k]); p.end(); }
}

inline uint32_t get(Kind k) { return gGen[k]; }

} // namespace ContentGen
