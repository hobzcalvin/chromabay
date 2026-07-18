#pragma once
#include <cstdint>

// Shared wall-clock source for time-aware operators (e.g. the Clock node). Holds the current
// Unix time in seconds (0 = unknown/unsynced). Set each frame from the host:
//   - WASM preview: the app calls setWallClock(Math.floor(Date.now()/1000)).
//   - Firmware: main.cpp sets it from the app-synced timestamp (TIMESTAMP_SYNC).
// Operators read WallClock::get(); they add their own timezone offset.
namespace WallClock {
    inline uint32_t g_epochSec = 0;
    inline void set(uint32_t epochSec) { g_epochSec = epochSec; }
    inline uint32_t get() { return g_epochSec; }
}
