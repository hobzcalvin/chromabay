// Minimal FastLED compatibility layer
// Provides essential functions for operators without complex FastLED dependencies

#include "fastled_operators.h"
#include <cmath>
#include <chrono>
#include <thread>
#include <cstdlib>

// Arduino compatibility functions
extern "C" {

unsigned long millis() {
    static auto start_time = std::chrono::steady_clock::now();
    auto now = std::chrono::steady_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(now - start_time);
    return static_cast<unsigned long>(duration.count());
}

unsigned long micros() {
    static auto start_time = std::chrono::steady_clock::now();
    auto now = std::chrono::steady_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::microseconds>(now - start_time);
    return static_cast<unsigned long>(duration.count());
}

void delay(unsigned long ms) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

void yield() {
    // No-op for WASM/native builds
}

}

// Essential FastLED functions that operators commonly use

// HSV to RGB conversion (simplified version)
CRGB hsv2rgb_rainbow(const CHSV& hsv) {
    uint8_t hue = hsv.h;
    uint8_t sat = hsv.s;
    uint8_t val = hsv.v;
    
    // Simplified HSV to RGB conversion
    uint8_t region = hue / 43;
    uint8_t remainder = (hue - (region * 43)) * 6;
    
    uint8_t p = (val * (255 - sat)) >> 8;
    uint8_t q = (val * (255 - ((sat * remainder) >> 8))) >> 8;
    uint8_t t = (val * (255 - ((sat * (255 - remainder)) >> 8))) >> 8;
    
    switch (region) {
        case 0: return CRGB(val, t, p);
        case 1: return CRGB(q, val, p);
        case 2: return CRGB(p, val, t);
        case 3: return CRGB(p, q, val);
        case 4: return CRGB(t, p, val);
        default: return CRGB(val, p, q);
    }
}

// CHSV to CRGB conversion operator
CHSV::operator CRGB() const {
    return hsv2rgb_rainbow(*this);
}

// CRGB assignment from CHSV
CRGB& CRGB::operator=(const CHSV& hsv) {
    *this = hsv2rgb_rainbow(hsv);
    return *this;
}

// Beat functions for timing-based effects
uint8_t beat8(uint16_t beats_per_minute, uint32_t timebase) {
    if (beats_per_minute == 0) return 0;
    
    uint32_t ms = timebase > 0 ? timebase : millis();
    uint32_t beat_ms = (60000UL * 256UL) / beats_per_minute;
    return (ms * 256UL) / beat_ms;
}

uint16_t beat16(uint16_t beats_per_minute, uint32_t timebase) {
    if (beats_per_minute == 0) return 0;
    
    uint32_t ms = timebase > 0 ? timebase : millis();
    uint32_t beat_ms = (60000UL * 65536UL) / beats_per_minute;
    return (ms * 65536UL) / beat_ms;
}

// Improved noise function (simplified Perlin-like noise)
static float fade(float t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

static float lerp(float a, float b, float t) {
    return a + t * (b - a);
}

static float grad(uint32_t hash, float x, float y, float z) {
    uint32_t h = hash & 15;
    float u = h < 8 ? x : y;
    float v = h < 4 ? y : h == 12 || h == 14 ? x : z;
    return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
}

uint8_t inoise8(uint16_t x, uint16_t y, uint16_t z) {
    // Scale down coordinates
    float fx = (float)x / 256.0f;
    float fy = (float)y / 256.0f;
    float fz = (float)z / 256.0f;
    
    // Find unit cube that contains point
    int X = (int)floor(fx) & 255;
    int Y = (int)floor(fy) & 255;
    int Z = (int)floor(fz) & 255;
    
    // Find relative x,y,z of point in cube
    fx -= floor(fx);
    fy -= floor(fy);
    fz -= floor(fz);
    
    // Compute fade curves for each of x,y,z
    float u = fade(fx);
    float v = fade(fy);
    float w = fade(fz);
    
    // Hash coordinates of the 8 cube corners
    uint32_t A = (X * 2654435761U) & 0xFFFFFF;
    uint32_t AA = (A + Y * 2246822519U) & 0xFFFFFF;
    uint32_t AB = (A + (Y + 1) * 2246822519U) & 0xFFFFFF;
    uint32_t B = ((X + 1) * 2654435761U) & 0xFFFFFF;
    uint32_t BA = (B + Y * 2246822519U) & 0xFFFFFF;
    uint32_t BB = (B + (Y + 1) * 2246822519U) & 0xFFFFFF;
    
    uint32_t AAA = (AA + Z * 3266489917U) & 0xFFFFFF;
    uint32_t AAB = (AA + (Z + 1) * 3266489917U) & 0xFFFFFF;
    uint32_t ABA = (AB + Z * 3266489917U) & 0xFFFFFF;
    uint32_t ABB = (AB + (Z + 1) * 3266489917U) & 0xFFFFFF;
    uint32_t BAA = (BA + Z * 3266489917U) & 0xFFFFFF;
    uint32_t BAB = (BA + (Z + 1) * 3266489917U) & 0xFFFFFF;
    uint32_t BBA = (BB + Z * 3266489917U) & 0xFFFFFF;
    uint32_t BBB = (BB + (Z + 1) * 3266489917U) & 0xFFFFFF;
    
    // Add blended results from 8 corners of cube
    float res = lerp(lerp(lerp(grad(AAA, fx, fy, fz),
                              grad(BAA, fx-1, fy, fz), u),
                         lerp(grad(ABA, fx, fy-1, fz),
                              grad(BBA, fx-1, fy-1, fz), u), v),
                    lerp(lerp(grad(AAB, fx, fy, fz-1),
                              grad(BAB, fx-1, fy, fz-1), u),
                         lerp(grad(ABB, fx, fy-1, fz-1),
                              grad(BBB, fx-1, fy-1, fz-1), u), v), w);
    
    // Convert to 0-255 range
    return (uint8_t)((res + 1.0f) * 127.5f);
}

uint16_t inoise16(uint16_t x, uint16_t y, uint16_t z) {
    // Use the 8-bit version and expand to 16-bit
    uint8_t noise8 = inoise8(x, y, z);
    return (uint16_t)noise8 << 8 | noise8;
}

// Scale functions
uint8_t scale8(uint8_t i, uint8_t scale) {
    return ((uint16_t)i * scale) >> 8;
}

uint16_t scale16(uint16_t i, uint16_t scale) {
    return ((uint32_t)i * scale) >> 16;
}

// Blend functions
CRGB blend(const CRGB& a, const CRGB& b, uint8_t amount) {
    uint8_t inv_amount = 255 - amount;
    return CRGB(
        (a.r * inv_amount + b.r * amount) >> 8,
        (a.g * inv_amount + b.g * amount) >> 8,
        (a.b * inv_amount + b.b * amount) >> 8
    );
}

// Basic trigonometry (8-bit)
uint8_t sin8(uint8_t theta) {
    return (uint8_t)(127.5 * (1.0 + sin(theta * 2.0 * M_PI / 256.0)));
}

uint8_t cos8(uint8_t theta) {
    return sin8(theta + 64); // cos(x) = sin(x + π/2)
}

// Random functions
uint8_t random8() {
    return rand() & 0xFF;
}

uint8_t random8(uint8_t max) {
    if (max == 0) return 0;
    return rand() % max;
}

uint16_t random16() {
    return rand() & 0xFFFF;
}

uint16_t random16(uint16_t max) {
    if (max == 0) return 0;
    return rand() % max;
}

// Utility functions
uint8_t qadd8(uint8_t a, uint8_t b) {
    uint16_t sum = a + b;
    return sum > 255 ? 255 : sum;
}

uint8_t qsub8(uint8_t a, uint8_t b) {
    return a > b ? a - b : 0;
}

uint8_t dim8_raw(uint8_t x) {
    return scale8(x, x);
}

uint8_t brighten8_raw(uint8_t x) {
    uint8_t ix = 255 - x;
    return 255 - scale8(ix, ix);
} 