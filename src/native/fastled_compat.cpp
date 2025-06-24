#include "fastled_patterns.h"

#ifdef __EMSCRIPTEN__

// HSV to RGB conversion (FastLED-compatible)
CRGB hsv_to_rgb(uint8_t h, uint8_t s, uint8_t v) {
    uint8_t region, remainder, p, q, t;
    
    if (s == 0) {
        return CRGB(v, v, v);
    }
    
    region = h / 43;
    remainder = (h - (region * 43)) * 6;
    
    p = (v * (255 - s)) >> 8;
    q = (v * (255 - ((s * remainder) >> 8))) >> 8;
    t = (v * (255 - ((s * (255 - remainder)) >> 8))) >> 8;
    
    switch (region) {
        case 0:
            return CRGB(v, t, p);
        case 1:
            return CRGB(q, v, p);
        case 2:
            return CRGB(p, v, t);
        case 3:
            return CRGB(p, q, v);
        case 4:
            return CRGB(t, p, v);
        default:
            return CRGB(v, p, q);
    }
}

// CHSV to CRGB conversion
CHSV::operator CRGB() const {
    return hsv_to_rgb(h, s, v);
}

// CRGB assignment from CHSV
CRGB& CRGB::operator=(const CHSV& hsv) {
    CRGB result = hsv_to_rgb(hsv.h, hsv.s, hsv.v);
    r = result.r;
    g = result.g;
    b = result.b;
    return *this;
}

// FastLED-compatible timing functions
uint8_t beat8(uint16_t beats_per_minute, uint32_t timebase) {
    // Convert beats per minute to milliseconds per beat
    uint32_t ms_per_beat = 60000 / beats_per_minute;
    
    // Calculate current beat position
    uint32_t beat_pos = (timebase % ms_per_beat);
    
    // Return as 8-bit value (0-255)
    return (uint8_t)((beat_pos * 256) / ms_per_beat);
}

uint16_t beat16(uint16_t beats_per_minute, uint32_t timebase) {
    // Convert beats per minute to milliseconds per beat
    uint32_t ms_per_beat = 60000 / beats_per_minute;
    
    // Calculate current beat position
    uint32_t beat_pos = (timebase % ms_per_beat);
    
    // Return as 16-bit value (0-65535)
    return (uint16_t)((beat_pos * 65536UL) / ms_per_beat);
}

#endif // __EMSCRIPTEN__ 