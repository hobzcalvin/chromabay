#pragma once

#include <cstdint>

// SK9822 "HD" output: use the chip's 5-bit global current control per pixel.
//
// An SK9822 pixel frame carries a 5-bit level (1..31) that sets the LED drive CURRENT, plus an
// 8-bit PWM value per channel. (APA102 also has the 5-bit field, but implements it as a slow
// second PWM on top of the first, which flickers; that is why this is SK9822-only.)
//
// Dimming in the 8-bit PWM alone throws resolution away: at 1/16 brightness a channel only
// has ~16 steps left, so dim colors band and lose hue. Lowering the current instead keeps the
// full 0..255 PWM range at every brightness. Here each pixel gets the LOWEST level whose full
// scale still covers its brightest channel, and the channels are rescaled to that level, so
// the light out is the same while the PWM keeps as many bits as possible.
//
// Inputs are per-channel linear targets T = c16 * brightness, where c16 is the 16-bit
// gamma/white-point-corrected channel (0..65535) and brightness is 0..255, so T spans
// 0..kFull. Outputs are PWM values in fixed point with `fracBits` fraction bits (the temporal
// dither depth; 0 when not dithering), i.e. 0..(255 << fracBits).
//
// Assumes drive current is proportional to level/31, which is how the SK9822 datasheet
// describes it ("current gain: 5 bit, 32 levels").
namespace Sk9822Hd {

constexpr uint32_t kFull = 65535u * 255u;   // c16 max * brightness max
constexpr uint8_t kMaxLevel = 31;

// Smallest level g in 1..31 whose full scale (g/31 of max current) covers maxT.
inline uint8_t chooseLevel(uint32_t maxT) {
    if (maxT == 0) return 1;
    uint64_t g = ((uint64_t)maxT * kMaxLevel + kFull - 1) / kFull;   // ceil(maxT * 31 / kFull)
    if (g < 1) g = 1;
    if (g > kMaxLevel) g = kMaxLevel;
    return (uint8_t)g;
}

// One channel's PWM value at level g, with fracBits fraction bits:
//   round( T/kFull * 255 * 31/g * 2^fracBits ) = round( T * 31 * 2^fracBits / (g * 65535) ),
// clamped to full scale (255 << fracBits).
inline uint16_t scaleChannel(uint32_t T, uint8_t g, uint8_t fracBits) {
    if (g == 0) g = 1;
    const uint64_t num = (uint64_t)T * kMaxLevel * ((uint64_t)1 << fracBits);
    const uint64_t den = (uint64_t)g * 65535u;
    const uint64_t v = (num + den / 2) / den;
    const uint64_t cap = (uint64_t)255u << fracBits;
    return (uint16_t)(v > cap ? cap : v);
}

}  // namespace Sk9822Hd
