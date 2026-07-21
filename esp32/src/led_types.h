#pragma once

#include <cstdint>

// Namespace to avoid polluting global scope
namespace LedConfig {

// Supported LED Chipsets (maps roughly to NeoPixelBus features)
// These values are for configuration and UI, not direct NeoPixelBus types.
// Values are chosen to align with WLED where possible for familiarity.
enum class LedChipset : uint8_t {
    NONE = 0,
    WS2812_RGB = 22,    // For WS2812, WS2813, WS2815, SK6812-RGB, TM1804, GS1903 etc. (NeoGrbFeature, 800Kbps)
    SK6812_RGBW = 27,   // For SK6812 (RGBW), WS2814 (RGBW) (NeoGrbwFeature)
    TM1814_RGBW = 32,   // For TM1814 (RGBW) (NeoWrgbTm1814Feature)
    WS2811_400KHZ = 24, // For WS2811 (400kHz) (NeoGrbFeature with 400Kbps method)
    TM1829_RGB = 20,    // For TM1829 (RGB) (NeoBrgTm1829Feature) - WLED uses 22 for TM1829 under WS2812, distinct value here
    UCS8903_RGB = 52,   // For UCS8903 (16-bit RGB) (NeoRgbUcs8903Feature)
    UCS8904_RGBW = 53,  // For UCS8904 (16-bit RGBW) (NeoRgbwUcs8904Feature)
    APA106_RGB = 47,    // For APA106, PL9823 (RGB) (Neo[Color]Apa106Feature)
    FW1906_RGBCW = 62,  // For FW1906 (GRBCW) (NeoGrbcwxFeature) - 5 channels
    WS2805_RGBCW = 63,  // For WS2805 (RGBCW) (NeoGrbwwFeature) - 5 channels
    TM1914_RGB = 64,    // For TM1914 (RGB) (NeoRgbTm1914Feature)
    SM16825_RGBCW = 65, // For SM16825 (16-bit RGBCW) (NeoRgbwcSm16825eFeature) - 5 channels

    // 4-wire SPI (clock + data). These need a SECOND pin (clockPin) alongside the data pin.
    APA102_SPI = 25,    // For APA102 / DotStar (DotStarBgrFeature, two-wire bit-bang)
    SK9822_SPI = 26,    // For SK9822 (APA102-compatible protocol; same DotStar driver)
    // WS2801_SPI = 23, // (future) WS2801 (NeoRbgFeature with Ws2801 SPI method)
};

// True for chipsets that need a clock pin in addition to the data pin (4-wire SPI LEDs).
inline bool isFourWire(LedChipset cs) {
    return cs == LedChipset::APA102_SPI || cs == LedChipset::SK9822_SPI;
}

// True for 4-channel RGBW chipsets (a single dedicated white LED per pixel). Auto-white
// applies to these. NOTE: 5-channel RGBCW (warm+cold white) chipsets are NOT included — they
// need a CCT split, which auto-white doesn't do yet, so they run RGB-only for now.
inline bool hasWhiteChannel(LedChipset cs) {
    return cs == LedChipset::SK6812_RGBW || cs == LedChipset::TM1814_RGBW ||
           cs == LedChipset::UCS8904_RGBW;
}

// How the white channel of an RGBW strip is derived from the rendered RGB colour.
// (Values are firmware-internal; the app doesn't set these yet — RGBW strips just default
// to Accurate. Room is left to expose mode + white-die colour later.)
enum class AutoWhiteMode : uint8_t {
    Off      = 0, // leave W at 0 (RGB only) — the old behaviour
    Accurate = 1, // W = common white component; SUBTRACT it from RGB (colour-accurate, cooler)
    Brighter = 2, // W = common white component; keep RGB (adds white on top, more output)
    Max      = 3, // W = max(R,G,B), keep RGB (legacy/simple)
};

// Color Orders
// Lower 4 bits: RGB sequence (defines the order of Red, Green, Blue components)
// Upper 4 bits: White channel handling (defines swapping behavior for RGBW/RGBCW strips)
enum class ColorOrderValue : uint8_t {
    // RGB Orders (actual wire order for the first three LEDs)
    // These define how R, G, B bytes from a color value are sent to the LED.
    // Example: For RGB=0, if color is (R=10,G=20,B=30), bytes sent are 10,20,30.
    // For GRB=2, if color is (R=10,G=20,B=30), bytes sent are 20,10,30.
    RGB = 0, // Red, Green, Blue
    RBG = 1, // Red, Blue, Green
    GRB = 2, // Green, Red, Blue (Common for WS2812)
    GBR = 3, // Green, Blue, Red
    BRG = 4, // Blue, Red, Green
    BGR = 5, // Blue, Green, Red
    MAX_RGB_ORDER_VALUE = 5,

    // White channel swap information (upper nibble)
    // These are masks to be OR'd with the RGB order from above.
    // This applies to how the W channel of an RGBW color is handled relative to RGB.
    W_SWAP_NONE = (0 << 4), // No swap, W is W (e.g., R,G,B,W)
    W_SWAP_W_R  = (1 << 4), // White channel is swapped with Red (e.g., W,G,B,R)
    W_SWAP_W_G  = (2 << 4), // White channel is swapped with Green (e.g., R,W,B,G)
    W_SWAP_W_B  = (3 << 4), // White channel is swapped with Blue (e.g., R,G,W,B)
    WW_CW_SWAP  = (4 << 4), // For CCT strips with two white channels (Warm White, Cold White), swaps their positions.

    // Common combined values for convenience
    CO_RGB = RGB,
    CO_RBG = RBG,
    CO_GRB = GRB,
    CO_GBR = GBR,
    CO_BRG = BRG,
    CO_BGR = BGR,

    CO_GRB_WNONE = GRB | W_SWAP_NONE, // Default for SK6812 RGBW
    CO_RGB_WNONE = RGB | W_SWAP_NONE,
};

// Internal Implementation Type IDs
// These map to specific NeoPixelBusLg template instantiations.
// For ESP32, we'll primarily use RMT methods for 1-wire addressable LEDs.
// Naming: ITYPE_ESP32_RMT_<NEOPIXELBUS_FEATURE_PROFILE>
// The NeoPixelBus Feature (e.g., NeoGrbFeature, NeoGrbwFeature) dictates color handling and sometimes protocol details.
// The Method (e.g., NeoEsp32RmtNWs2812xMethod) dictates hardware communication.
// Each ITYPE here must correspond to a unique NeoPixelBusLg<Feature, Method> combination.
enum InternalLedType : uint8_t {
    ITYPE_NONE = 0,

    // ESP32 RMT Methods for 1-wire LEDs
    ITYPE_ESP32_RMT_WS2812_RGB = 1,    // NeoGrbFeature + NeoEsp32RmtNWs2812xMethod (3ch: RGB)
    ITYPE_ESP32_RMT_SK6812_RGBW = 2,   // NeoGrbwFeature + NeoEsp32RmtNSk6812Method (4ch: RGBW)
    ITYPE_ESP32_RMT_TM1814_RGBW = 3,   // NeoWrgbTm1814Feature + NeoEsp32RmtNTm1814Method (4ch: RGBW, W is first in feature)
    ITYPE_ESP32_RMT_WS2811_400_RGB = 4,// NeoGrbFeature + NeoEsp32RmtN400KbpsMethod (3ch: RGB)
    ITYPE_ESP32_RMT_TM1829_RGB = 5,    // NeoBrgFeature + NeoEsp32RmtNTm1829Method (3ch: RGB)
    ITYPE_ESP32_RMT_UCS8903_RGB = 6,   // NeoRgbUcs8903Feature + NeoEsp32RmtNWs2812xMethod (3ch: RGB, 16-bit)
    ITYPE_ESP32_RMT_UCS8904_RGBW = 7,  // NeoRgbwUcs8904Feature + NeoEsp32RmtNWs2812xMethod (4ch: RGBW, 16-bit)
    ITYPE_ESP32_RMT_APA106_RGB = 8,    // Neo[Color]Apa106Feature + NeoEsp32RmtNApa106Method (3ch: RGB)
    ITYPE_ESP32_RMT_FW1906_RGBCW = 9,  // NeoGrbcwxFeature + NeoEsp32RmtNWs2812xMethod (5ch: RGBCW)
    ITYPE_ESP32_RMT_WS2805_RGBCW = 10, // NeoGrbwwFeature + NeoEsp32RmtNWs2805Method (5ch: RGBCW)
    ITYPE_ESP32_RMT_TM1914_RGB = 11,   // NeoRgbTm1914Feature + NeoEsp32RmtNTm1914Method (3ch: RGB)
    ITYPE_ESP32_RMT_SM16825_RGBCW = 12,// NeoRgbwcSm16825eFeature + NeoEsp32RmtNWs2812xMethod (5ch: RGBCW, 16-bit)

    // 4-wire SPI (clock + data). Bit-bang two-wire so it runs on ANY two GPIOs across
    // esp32 / s3 / c3 (hardware SPI would pin us to specific pads).
    ITYPE_ESP32_APA102_BGR = 100,      // DotStarBgrFeature + DotStarMethod (APA102 / SK9822)
};

} // namespace LedConfig
