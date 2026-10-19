#pragma once
// A short memory of what the device just did, for "something weird happened" reports.
//
// The app's feedback form reads it (the DIAGNOSTICS endpoint) at the moment someone reports a
// problem and attaches it next to the app's own breadcrumbs and session replay, so whoever
// triages can see both sides: did the brightness write arrive? was it applied? did a pattern
// load land in between? Before this the device side of such a report was the serial console,
// which nobody has in the field.
//
// Fixed size, no allocation, safe from the BLE task and the loop task alike: each note is
// formatted on the caller's stack and copied in under a spinlock. 40 entries x 36 bytes is
// ~1.5 KB of RAM, which a classic ESP32 can spare; older entries are overwritten. The text is
// terse on purpose (it is read by a person or a triage agent next to the code).
#include <Arduino.h>
#include <stdarg.h>

namespace DiagLog {

constexpr size_t ENTRIES = 40;
constexpr size_t TEXT = 32;

struct Entry { uint32_t ms; char text[TEXT]; };

namespace detail {
inline Entry ring[ENTRIES];
inline size_t next = 0;      // slot the next note goes into
inline uint32_t total = 0;   // notes ever written (so a reader can tell how many were lost)
inline portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
}

/** Record one event, printf-style, timestamped with millis(). Truncated to TEXT - 1 chars. */
inline void note(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
inline void note(const char* fmt, ...) {
    Entry e;
    e.ms = millis();
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(e.text, sizeof(e.text), fmt, ap);
    va_end(ap);
    portENTER_CRITICAL(&detail::mux);
    detail::ring[detail::next] = e;
    detail::next = (detail::next + 1) % ENTRIES;
    detail::total++;
    portEXIT_CRITICAL(&detail::mux);
}

/** The ring as a JSON array of [ms, "text"], oldest first, plus how many notes were ever made. */
inline String json(uint32_t* totalOut = nullptr) {
    Entry copy[ENTRIES];
    size_t next; uint32_t total;
    portENTER_CRITICAL(&detail::mux);
    memcpy(copy, detail::ring, sizeof(copy));
    next = detail::next; total = detail::total;
    portEXIT_CRITICAL(&detail::mux);
    if (totalOut) *totalOut = total;
    const size_t n = total < ENTRIES ? total : ENTRIES;
    String j = "[";
    j.reserve(n * 24 + 2);
    for (size_t i = 0; i < n; i++) {
        const Entry& e = copy[(next + ENTRIES - n + i) % ENTRIES];
        if (i) j += ',';
        j += '['; j += String(e.ms); j += ",\"";
        for (const char* c = e.text; *c; c++) {
            if (*c == '"' || *c == '\\') j += '\\';
            j += (*c >= 0x20) ? *c : '?';
        }
        j += "\"]";
    }
    j += ']';
    return j;
}

} // namespace DiagLog
