// FastLED compatibility layer for native builds and WASM
// Provides essential FastLED functions without requiring the full library

#include "fastled_operators.h"
#include <cmath>
#include <chrono>

#if defined(__EMSCRIPTEN__) || defined(NATIVE_BUILD)

// HSV to RGB conversion (from FastLED)
CRGB& CRGB::operator=(const CHSV& hsv) {
    uint8_t hue = hsv.h;
    uint8_t sat = hsv.s;
    uint8_t val = hsv.v;
    
    if (sat == 0) {
        // Grayscale
        r = g = b = val;
        return *this;
    }
    
    uint8_t region = hue / 43;
    uint8_t remainder = (hue - (region * 43)) * 6;
    
    uint8_t p = (val * (255 - sat)) >> 8;
    uint8_t q = (val * (255 - ((sat * remainder) >> 8))) >> 8;
    uint8_t t = (val * (255 - ((sat * (255 - remainder)) >> 8))) >> 8;
    
    switch (region) {
        case 0:
            r = val; g = t; b = p;
            break;
        case 1:
            r = q; g = val; b = p;
            break;
        case 2:
            r = p; g = val; b = t;
            break;
        case 3:
            r = p; g = q; b = val;
            break;
        case 4:
            r = t; g = p; b = val;
            break;
        default:
            r = val; g = p; b = q;
            break;
    }
    
    return *this;
}

// CHSV to CRGB conversion
CHSV::operator CRGB() const {
    CRGB rgb;
    rgb = *this;
    return rgb;
}

// Get current time in milliseconds
static uint32_t millis() {
    static auto start_time = std::chrono::high_resolution_clock::now();
    auto current_time = std::chrono::high_resolution_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(current_time - start_time);
    return static_cast<uint32_t>(elapsed.count());
}

// FastLED beat8 function - returns 0-255 sawtooth wave
uint8_t beat8(uint16_t beats_per_minute, uint32_t timebase) {
    if (timebase == 0) {
        timebase = millis();
    }
    
    // Calculate period in milliseconds
    uint32_t period_ms = (60000UL) / beats_per_minute;
    
    // Get position in current beat cycle
    uint32_t position = timebase % period_ms;
    
    // Convert to 0-255 range
    return (uint8_t)((position * 255UL) / period_ms);
}

// FastLED beat16 function - returns 0-65535 sawtooth wave
uint16_t beat16(uint16_t beats_per_minute, uint32_t timebase) {
    if (timebase == 0) {
        timebase = millis();
    }
    
    // Calculate period in milliseconds
    uint32_t period_ms = (60000UL) / beats_per_minute;
    
    // Get position in current beat cycle
    uint32_t position = timebase % period_ms;
    
    // Convert to 0-65535 range
    return (uint16_t)((position * 65535UL) / period_ms);
}

#endif // defined(__EMSCRIPTEN__) || defined(NATIVE_BUILD) 