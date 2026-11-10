#pragma once
#include <cstdint>

// Shared wall-clock source for time-aware operators (e.g. the Clock node). Holds the current
// Unix time in seconds (0 = unknown/unsynced). Set each frame from the host:
//   - WASM preview: the app calls setWallClock(Math.floor(Date.now()/1000)).
//   - Firmware: main.cpp sets it from the app-synced timestamp (TIMESTAMP_SYNC).
// Operators read WallClock::get(), and WallClock::getTzOffsetMin() for local time.
namespace WallClock {
    inline uint32_t g_epochSec = 0;
    inline void set(uint32_t epochSec) { g_epochSec = epochSec; }
    inline uint32_t get() { return g_epochSec; }
    // The local time zone as a UTC offset in minutes (local = UTC + this), daylight saving
    // included: the phone's current offset. The app sends it with every timestamp sync (and
    // the preview sets it each frame), so a DST change is picked up on the next connect.
    inline int16_t g_tzOffsetMin = 0;
    inline void setTzOffsetMin(int16_t m) { g_tzOffsetMin = m; }
    inline int16_t getTzOffsetMin() { return g_tzOffsetMin; }
}
