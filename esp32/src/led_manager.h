#pragma once

#include <vector>
#include <cstdint>
#include <cmath> // sqrtf/lroundf for layout sizing
#include <memory> // Required for std::unique_ptr
#include "led_types.h"
#include "led_wrapper.h" // For LedWrapper and NeoPixelBus types if needed directly

// Forward declaration for FastLED types if used for color math
class CRGB;
struct CHSV;

namespace LedConfig {

// Configuration for a single LED strip
struct LedStripConfig {
    LedChipset chipset = LedChipset::NONE;
    uint8_t pin = 0;         // data pin (all chipsets)
    uint8_t clockPin = 0;    // clock pin — only used by 4-wire SPI chipsets (APA102/SK9822)
    uint16_t numLeds = 0;
    ColorOrderValue colorOrder = ColorOrderValue::CO_GRB; // Default to GRB
    uint8_t rmtChannel = 0; // ESP32 RMT channel (0-7 for NeoPixelBus default RMT method)
    
    // Matrix/2D Layout Configuration
    uint16_t width = 0;      // Width in pixels (0 = linear strip)
    uint16_t height = 0;     // Height in pixels (0 = linear strip)
    uint8_t orientation = 0; // Bit 0-1: rotation (0°/90°/180°/270°), Bit 2: flip H, Bit 3: serpentine
    // Per-strip gamma correction applied to each channel on output. 1.0 = none (default).
    float gamma = 1.0f;
    // Per-strip white-point correction: the colour the strip should render for "white".
    // Each channel is scaled by wp/255 on output, so e.g. lowering blue cancels a
    // cold/blue strip. Default 255/255/255 = neutral (no correction).
    uint8_t wpR = 255;
    uint8_t wpG = 255;
    uint8_t wpB = 255;
    // --- Auto-white (RGBW strips only) ---------------------------------------------------
    // How to drive the dedicated white LED from the rendered RGB. Ignored on non-RGBW
    // chipsets. Default Accurate: pull the common white component out of RGB and let the
    // (efficient, single-die) white LED render it, subtracting it from RGB so the colour is
    // unchanged. See AutoWhiteMode. The app doesn't set this yet — RGBW just works.
    uint8_t autoWhiteMode = static_cast<uint8_t>(AutoWhiteMode::Accurate);
    // Colour the white die actually emits at full drive, as an RGB triple (brightest channel
    // ~255). Lets extraction stay colour-neutral on non-neutral whites. 255/255/255 = neutral
    // (classic W = min(R,G,B)); a natural-white die is ~255/246/224, warm-white ~255/210/168.
    uint8_t wLedR = 255;
    uint8_t wLedG = 255;
    uint8_t wLedB = 255;
    // Temporal dithering opt-in for this strip. Even when true it only activates if the
    // strip is small/fast enough (see LedBus::chooseDitherBits); default on.
    bool ditherEnable = true;
    
    // Add other strip-specific settings if needed:
    // bool reversed = false;
    // uint16_t anouncementLedsToSkip = 0; // like WLED's skip
    
    // Helper functions for 2D coordinate mapping
    bool isMatrix() const { return width > 0 && height > 0; }
    uint8_t getRotation() const { return orientation & 0x03; }
    bool getFlipH() const { return (orientation & 0x04) != 0; }
    bool getSerpentine() const { return (orientation & 0x08) != 0; }
    
    // Convert 2D coordinates to linear index
    uint16_t xyToIndex(uint16_t x, uint16_t y) const {
        if (!isMatrix() || x >= width || y >= height) return numLeds; // Invalid
        
        // Apply rotation first
        uint16_t rx = x, ry = y;
        uint8_t rot = getRotation();
        if (rot == 1) { // 90° clockwise
            rx = y;
            ry = width - 1 - x;
        } else if (rot == 2) { // 180°
            rx = width - 1 - x;
            ry = height - 1 - y;
        } else if (rot == 3) { // 270° clockwise (90° counter-clockwise)
            rx = height - 1 - y;
            ry = x;
        }
        
        // Apply horizontal flip
        if (getFlipH()) {
            rx = width - 1 - rx;
        }
        
        // Apply serpentine layout
        uint16_t index;
        if (getSerpentine() && (ry % 2 == 1)) {
            // Odd rows go right-to-left
            index = ry * width + (width - 1 - rx);
        } else {
            // Even rows go left-to-right
            index = ry * width + rx;
        }
        
        return index < numLeds ? index : numLeds; // Bounds check
    }
};

// Internal class to manage a single physical LED bus/strip
class LedBus {
public:
    LedBus(const LedStripConfig& config) : _config(config), _busPtr(nullptr), _internalType(ITYPE_NONE), _brightness(255) {
        buildLut();
        _internalType = mapChipsetToInternalType(_config.chipset);
        if (_internalType != ITYPE_NONE && _config.numLeds > 0) {
            // Note: RMT channel is passed to LedWrapper::create; clockPin is used only by
            // 4-wire SPI buses (APA102/SK9822) and ignored by the RMT ones.
            _busPtr = LedWrapper::create(_internalType, _config.pin, _config.numLeds, _config.rmtChannel, _config.clockPin);
        }
    }

    ~LedBus() {
        if (_busPtr) {
            LedWrapper::cleanup(_busPtr, _internalType);
            _busPtr = nullptr;
        }
    }

    // Prevent copying and assignment as _busPtr ownership is unique
    LedBus(const LedBus&) = delete;
    LedBus& operator=(const LedBus&) = delete;

    // Allow moving (though unique_ptr in vector handles this mostly)
    LedBus(LedBus&& other) noexcept
        : _config(other._config),
          _busPtr(other._busPtr),
          _internalType(other._internalType),
          _brightness(other._brightness) {
        buildLut(); // rebuild from copied _config
        other._busPtr = nullptr; // Invalidate other
    }

    LedBus& operator=(LedBus&& other) noexcept {
        if (this != &other) {
            if (_busPtr) {
                LedWrapper::cleanup(_busPtr, _internalType);
            }
            _config = other._config;
            _busPtr = other._busPtr;
            _internalType = other._internalType;
            _brightness = other._brightness;
            buildLut(); // rebuild from copied _config
            other._busPtr = nullptr;
        }
        return *this;
    }

    void begin() {
        if (_busPtr && _internalType != ITYPE_NONE) {
            LedWrapper::begin(_busPtr, _internalType);
            // Apply initial brightness
            LedWrapper::setBrightness(_busPtr, _internalType, _brightness);
        }
    }

    void show(bool consistent = false) {
        if (_busPtr && _internalType != ITYPE_NONE) {
            LedWrapper::show(_busPtr, _internalType, consistent);
        }
    }

    bool canShow() const {
        if (_busPtr && _internalType != ITYPE_NONE) {
            return LedWrapper::canShow(_busPtr, _internalType);
        }
        return true; // If no bus, it can "show" (do nothing)
    }

    // color is in WRGB format (W in MSB)
    void setPixelColor(uint16_t pixelIndex, uint32_t color) {
        if (_busPtr && _internalType != ITYPE_NONE && pixelIndex < _config.numLeds) {
            // Brightness is handled by NeoPixelBus SetLuminance, so pass raw color.
            // Color order is applied by LedWrapper.
            LedWrapper::setPixelColor(_busPtr, _internalType, pixelIndex, color, _config.colorOrder);
        }
    }

    // FastLED CRGB compatible setPixelColor
    void setPixelColor(uint16_t pixelIndex, const CRGB& color);

    // 2D Matrix coordinate setPixelColor
    void setPixelColorXY(uint16_t x, uint16_t y, uint32_t color) {
        if (_config.isMatrix()) {
            uint16_t index = _config.xyToIndex(x, y);
            if (index < _config.numLeds) {
                setPixelColor(index, color);
            }
        }
    }

    // 2D Matrix coordinate setPixelColor with CRGB
    void setPixelColorXY(uint16_t x, uint16_t y, const CRGB& color) {
        if (_config.isMatrix()) {
            uint16_t index = _config.xyToIndex(x, y);
            if (index < _config.numLeds) {
                setPixelColor(index, color);
            }
        }
    }

    uint32_t getPixelColor(uint16_t pixelIndex) const {
        if (_busPtr && _internalType != ITYPE_NONE && pixelIndex < _config.numLeds) {
            return LedWrapper::getPixelColor(_busPtr, _internalType, pixelIndex, _config.colorOrder);
        }
        return 0;
    }

    void setBrightness(uint8_t brightness) {
        _brightness = brightness;
        // While dithering we own brightness (baked into the target at full precision), so
        // leave NeoPixelBus luminance at 255 — otherwise its 8-bit dim re-quantizes the gain.
        if (_busPtr && _internalType != ITYPE_NONE && !_ditherOn) {
            LedWrapper::setBrightness(_busPtr, _internalType, _brightness);
        }
    }

    uint8_t getBrightness() const {
        return _brightness;
    }

    uint16_t getLength() const {
        return _config.numLeds;
    }

    uint8_t getPin() const {
        return _config.pin;
    }

    InternalLedType getInternalLedType() const {
        return _internalType;
    }

    const LedStripConfig& getConfig() const {
        return _config;
    }

    bool isValid() const {
        return _busPtr != nullptr && _internalType != ITYPE_NONE;
    }

    // Per-channel output LUT folding gamma + white-point gain, built from _config.
    // lut[ch][in] = round( (in/255)^gamma * (whitePoint[ch]/255) * 255 ). Applied in
    // setPixelColor. Public so callers can rebuild after changing the config.
    void buildLut() {
        float g = (_config.gamma > 0.01f) ? _config.gamma : 1.0f;
        const uint8_t wp[3] = { _config.wpR, _config.wpG, _config.wpB };
        for (int ch = 0; ch < 3; ch++) {
            float gain = (float)wp[ch] / 255.0f;
            for (int i = 0; i < 256; i++) {
                float corrected = powf((float)i / 255.0f, g) * gain; // 0..1
                int o8 = (int)(corrected * 255.0f + 0.5f);
                _lut[ch][i] = (uint8_t)(o8 < 0 ? 0 : (o8 > 255 ? 255 : o8));
                // 16-bit version of the SAME correction, so dithering can carry gamma +
                // white-point at full precision down to the sigma-delta instead of through
                // a lossy 8-bit step (where the gamma curve crushes many low inputs to 0/1).
                int o16 = (int)(corrected * 65535.0f + 0.5f);
                _lut16[ch][i] = (uint16_t)(o16 < 0 ? 0 : (o16 > 65535 ? 65535 : o16));
            }
        }
        // White channel: gamma only (white-point is an RGB-primary correction, N/A to W).
        for (int i = 0; i < 256; i++) {
            int o8 = (int)(powf((float)i / 255.0f, g) * 255.0f + 0.5f);
            _lutW[i] = (uint8_t)(o8 < 0 ? 0 : (o8 > 255 ? 255 : o8));
        }
        _hasWhite = hasWhiteChannel(_config.chipset);
    }
    uint8_t lutR(uint8_t c) const { return _lut[0][c]; }
    uint8_t lutG(uint8_t c) const { return _lut[1][c]; }
    uint8_t lutB(uint8_t c) const { return _lut[2][c]; }
    uint8_t lutW(uint8_t c) const { return _lutW[c]; }

    // Derive the white channel + (for Accurate mode) the reduced RGB for an RGBW pixel.
    // Colour-aware: the white die emits (wLedR,wLedG,wLedB) at full, so we pull the largest
    // white level whose emission stays under the target on every channel, then subtract that
    // emission. With a neutral die (255,255,255) this is exactly W=min(R,G,B) then R,G,B-=W.
    // Operates in the pattern's colour space (pre-gamma), matching WLED; gamma is applied to
    // the results by the per-channel LUTs afterwards.
    void computeAutoWhite(uint8_t r, uint8_t g, uint8_t b,
                          uint8_t& oR, uint8_t& oG, uint8_t& oB, uint8_t& oW) const {
        const AutoWhiteMode mode = static_cast<AutoWhiteMode>(_config.autoWhiteMode);
        if (mode == AutoWhiteMode::Max) {
            oR = r; oG = g; oB = b;
            oW = r > g ? (r > b ? r : b) : (g > b ? g : b); // additive, no subtract
            return;
        }
        const uint32_t wr = _config.wLedR ? _config.wLedR : 1;
        const uint32_t wg = _config.wLedG ? _config.wLedG : 1;
        const uint32_t wb = _config.wLedB ? _config.wLedB : 1;
        uint32_t lvl = 255u;                              // cap at full white
        uint32_t c;
        c = (uint32_t)r * 255u / wr; if (c < lvl) lvl = c;
        c = (uint32_t)g * 255u / wg; if (c < lvl) lvl = c;
        c = (uint32_t)b * 255u / wb; if (c < lvl) lvl = c;
        oW = (uint8_t)lvl;
        if (mode == AutoWhiteMode::Brighter) {            // keep RGB, add white on top
            oR = r; oG = g; oB = b;
            return;
        }
        // Accurate: subtract the white die's actual emission (>= 0 by construction).
        uint32_t sr = lvl * wr / 255u, sg = lvl * wg / 255u, sb = lvl * wb / 255u;
        oR = (uint8_t)(r > sr ? r - sr : 0);
        oG = (uint8_t)(g > sg ? g - sg : 0);
        oB = (uint8_t)(b > sb ? b - sb : 0);
    }

    // ---- Arbitrary pixel layout (WLED ledmap model) ------------------------------------
    // A layout is a W×H grid plus a `map`: map[cell] = the physical LED index that displays
    // that grid cell (or <0 for a gap). Same format as WLED's ledmap.json, so existing maps
    // work. The operator graph renders at W×H and render() walks the cells, lighting each
    // mapped LED. Multi-strip installs that want a shared coordinate space just give each
    // strip the same W×H and place their own LEDs in the appropriate cells.
    static constexpr int kLayoutMaxDim = 256; // cap on either dimension (W*H bounded by buffers)

    void setLayout(const int16_t* map, uint16_t count, uint16_t W, uint16_t H) {
        if (!map || W == 0 || H == 0 || count == 0 || W > kLayoutMaxDim || H > kLayoutMaxDim) {
            clearLayout(); return;
        }
        uint32_t cells = (uint32_t)W * H;
        if (count > cells) count = (uint16_t)cells; // trust W*H; ignore extras
        _layoutW = W; _layoutH = H;
        _layoutMap.assign(cells, -1);
        for (uint16_t c = 0; c < count; c++) {
            int16_t led = map[c];
            _layoutMap[c] = (led >= 0 && led < (int)_config.numLeds) ? led : -1;
        }
        _hasLayout = true;
    }
    void clearLayout() { _hasLayout = false; _layoutW = _layoutH = 0; _layoutMap.clear(); _layoutMap.shrink_to_fit(); }
    bool hasLayout() const { return _hasLayout; }
    uint16_t layoutWidth() const { return _layoutW; }
    uint16_t layoutHeight() const { return _layoutH; }
    // LED index displaying grid cell, or -1 for a gap / out of range.
    int32_t layoutLedAt(uint32_t cell) const { return cell < _layoutMap.size() ? _layoutMap[cell] : -1; }

    // Canvas dimensions to render this strip at: the layout's virtual matrix if present,
    // else the configured matrix (or 1 x numLeds for a linear strip).
    uint16_t effectiveWidth() const { return _hasLayout ? _layoutW : (_config.width > 0 ? _config.width : _config.numLeds); }
    uint16_t effectiveHeight() const { return _hasLayout ? _layoutH : (_config.height > 0 ? _config.height : 1); }

    // ---- Temporal dithering (Fadecandy-style, opportunistic) -----------------------
    // Recovers sub-LSB precision (smooth low brightness, no banding) by emitting many
    // fast sub-frames per animation frame and time-averaging via per-channel sigma-delta.
    // Only enabled when the strip is small/fast enough that the sub-frame (Show) rate keeps
    // the slowest dither component above the flicker-fusion threshold; the bit depth N
    // scales with available headroom. When off, output is byte-for-byte the old path.
    bool ditherEnabled() const { return _ditherOn; }
    uint8_t ditherBits() const { return _ditherBits; }

    // Decide N (0=off, else 1..3) from chipset speed + pixel count, (re)alloc buffers, and
    // route brightness: dithering owns brightness (NeoPixelBus luminance forced to 255 so
    // its 8-bit dim can't re-quantize away the gain); non-dithering keeps SetLuminance.
    void configureDither() {
        uint8_t bits = chooseDitherBits();
        _ditherBits = bits;
        _ditherOn = (bits > 0);
        if (_ditherOn) {
            size_t n = (size_t)_config.numLeds * 3;
            _ditherTarget.assign(n, 0);
            _ditherResid.assign(n, 0);
            if (_busPtr && _internalType != ITYPE_NONE)
                LedWrapper::setBrightness(_busPtr, _internalType, 255); // own brightness ourselves
        } else {
            _ditherTarget.clear(); _ditherTarget.shrink_to_fit();
            _ditherResid.clear(); _ditherResid.shrink_to_fit();
            if (_busPtr && _internalType != ITYPE_NONE)
                LedWrapper::setBrightness(_busPtr, _internalType, _brightness);
        }
    }

    // Emit ONE dither sub-frame: per channel, sigma-delta the fixed-point target down to
    // 8 bits (carry biases the LSB so the time-average equals the high-precision target),
    // write it raw (luminance=255 + null gamma => identity passthrough), and Show.
    void ditherShow() {
        if (!_ditherOn || !_busPtr || _internalType == ITYPE_NONE) return;
        const uint16_t L = (uint16_t)1 << _ditherBits;
        const uint16_t mask = L - 1;
        const uint16_t n = _config.numLeds;
        for (uint16_t i = 0; i < n; i++) {
            uint8_t out[3];
            for (int ch = 0; ch < 3; ch++) {
                size_t k = (size_t)i * 3 + ch;
                uint16_t t = _ditherTarget[k];
                uint16_t base = t >> _ditherBits;
                uint16_t acc = (uint16_t)_ditherResid[k] + (t & mask);
                uint16_t carry = 0;
                if (acc >= L) { acc -= L; carry = 1; }
                _ditherResid[k] = (uint8_t)acc;
                uint16_t v = base + carry;
                out[ch] = (uint8_t)(v > 255 ? 255 : v);
            }
            uint32_t wrgb = ((uint32_t)out[0] << 16) | ((uint32_t)out[1] << 8) | out[2];
            LedWrapper::setPixelColor(_busPtr, _internalType, i, wrgb, _config.colorOrder);
        }
        LedWrapper::show(_busPtr, _internalType, false);
    }

    // Force the strip fully dark and TRANSMIT it now, regardless of dithering. A plain
    // black-write + show() does NOT blank a dithered strip: show()/ditherShow() re-emit the
    // last dither TARGET (the frozen lit frame), clobbering the black. So zero the dither
    // buffers too, then write black and push it out. Used for sleep / scheduled-off.
    void blank() {
        if (_busPtr == nullptr || _internalType == ITYPE_NONE) return;
        if (_ditherOn) {
            for (auto& v : _ditherTarget) v = 0;
            for (auto& v : _ditherResid) v = 0;
        }
        for (uint16_t i = 0; i < _config.numLeds; i++)
            LedWrapper::setPixelColor(_busPtr, _internalType, i, 0u, _config.colorOrder);
        LedWrapper::show(_busPtr, _internalType, false);
    }

    // Store a render's pixel as a high-precision dither target (defined below, after the
    // FastLED.h include, since it reads CRGB channels). Called by setPixelColor.
    void setDitherTarget(uint16_t pixelIndex, const CRGB& color);

private:
    LedStripConfig _config;
    void* _busPtr;
    InternalLedType _internalType;
    uint8_t _brightness;
    uint8_t _lut[3][256];
    uint8_t _lutW[256];        // gamma-only LUT for the white channel (RGBW strips)
    bool _hasWhite = false;    // true for RGBW chipsets (auto-white applies)
    bool _hasLayout = false;
    uint16_t _layoutW = 0, _layoutH = 0;
    std::vector<int16_t> _layoutMap; // per-cell physical LED index (-1 = gap), length W*H
    uint16_t _lut16[3][256]; // 16-bit gamma+white-point LUT, used by the dither path
    bool _ditherOn = false;
    uint8_t _ditherBits = 0;
    std::vector<uint16_t> _ditherTarget; // per channel, fixed-point (ditherBits frac bits)
    std::vector<uint8_t> _ditherResid;   // per channel sigma-delta residual (0..2^bits-1)

    // Estimate how fast we can re-Show this strip (Hz): data bits / bitrate + reset, then
    // cap by the main-loop sub-frame rate (it drives sub-frames once per ~1ms iteration).
    uint32_t estShowRateHz() const {
        if (_config.numLeds == 0) return 0;
        int bpp = 24; int kbps = 800;
        switch (_config.chipset) {
            case LedChipset::WS2811_400KHZ: kbps = 400; bpp = 24; break;
            case LedChipset::SK6812_RGBW:
            case LedChipset::TM1814_RGBW:
            case LedChipset::UCS8904_RGBW:  bpp = 32; break;
            case LedChipset::FW1906_RGBCW:
            case LedChipset::WS2805_RGBCW:
            case LedChipset::SM16825_RGBCW: bpp = 40; break;
            default: bpp = 24; break;
        }
        float tShowUs = (float)_config.numLeds * bpp * 1000.0f / (float)kbps + 300.0f; // +reset
        if (tShowUs < 1.0f) tShowUs = 1.0f;
        uint32_t hw = (uint32_t)(1000000.0f / tShowUs);
        const uint32_t loopCap = 900; // in-loop sub-frame cadence (delay(1)-limited)
        return hw < loopCap ? hw : loopCap;
    }

    // Largest N in 1..3 keeping the slowest dither component (rate/2^N) above ~70 Hz.
    uint8_t chooseDitherBits() const {
        if (!_config.ditherEnable || _internalType == ITYPE_NONE || _config.numLeds == 0) return 0;
        // The dither pipeline carries only 3 (RGB) channels; auto-white sets a 4th. Rather
        // than clobber W, don't dither RGBW strips (they're slower anyway, so headroom is low).
        if (_hasWhite && _config.autoWhiteMode != static_cast<uint8_t>(AutoWhiteMode::Off)) return 0;
        uint32_t rate = estShowRateHz();
        for (int n = 3; n >= 1; n--) {
            if ((rate >> n) > 70u) return (uint8_t)n;
        }
        return 0;
    }

    InternalLedType mapChipsetToInternalType(LedChipset chipset) {
        switch (chipset) {
            case LedChipset::WS2812_RGB:     return ITYPE_ESP32_RMT_WS2812_RGB;
            case LedChipset::SK6812_RGBW:    return ITYPE_ESP32_RMT_SK6812_RGBW;
            case LedChipset::TM1814_RGBW:    return ITYPE_ESP32_RMT_TM1814_RGBW;
            case LedChipset::WS2811_400KHZ:  return ITYPE_ESP32_RMT_WS2811_400_RGB;
            case LedChipset::TM1829_RGB:     return ITYPE_ESP32_RMT_TM1829_RGB;
            case LedChipset::UCS8903_RGB:    return ITYPE_ESP32_RMT_UCS8903_RGB;
            case LedChipset::UCS8904_RGBW:   return ITYPE_ESP32_RMT_UCS8904_RGBW;
            case LedChipset::APA106_RGB:     return ITYPE_ESP32_RMT_APA106_RGB;
            case LedChipset::FW1906_RGBCW:   return ITYPE_ESP32_RMT_FW1906_RGBCW;
            case LedChipset::WS2805_RGBCW:   return ITYPE_ESP32_RMT_WS2805_RGBCW;
            case LedChipset::TM1914_RGB:     return ITYPE_ESP32_RMT_TM1914_RGB;
            case LedChipset::SM16825_RGBCW:  return ITYPE_ESP32_RMT_SM16825_RGBCW;
            case LedChipset::APA102_SPI:     return ITYPE_ESP32_APA102_BGR;
            case LedChipset::SK9822_SPI:     return ITYPE_ESP32_APA102_BGR; // APA102-compatible
            case LedChipset::NONE:
            default:                    return ITYPE_NONE;
        }
    }
};


class LedManager {
public:
    LedManager() : _globalBrightness(255) {}

    ~LedManager() {
        clearStrips(); // Ensures all LedBus destructors are called via unique_ptr
    }

    // Configuration
    // Returns true on success, false if config is invalid or max strips reached
    bool addStrip(const LedStripConfig& config) {
        if (config.chipset == LedChipset::NONE || config.numLeds == 0) {
            return false; 
        }
        if (config.rmtChannel >= RMT_CHANNEL_MAX) { 
            return false;
        }

        // ESP-IDF toolchain is C++11, so use explicit std::unique_ptr construction
        auto newStrip = std::unique_ptr<LedBus>(new LedBus(config));
        if (!newStrip->isValid()) {
            return false; // Failed to initialize the bus (e.g., bad pin, no mem for NeoPixelBus)
        }
        _strips.push_back(std::move(newStrip));
        return true;
    }

    void clearStrips() {
        _strips.clear(); // Calls destructors for all LedBus objects via unique_ptr
    }

    // Initialization
    void begin() {
        for (auto& strip_ptr : _strips) {
            strip_ptr->begin();
            strip_ptr->setBrightness(_globalBrightness); // Apply global brightness at init
        }
        configureDithering(); // decide per-strip dithering once strips exist + brightness set
    }

    // (Re)evaluate temporal dithering on every strip — call after strips/brightness change.
    // Each strip opportunistically picks its own bit depth from its config opt-in (or off).
    void configureDithering() {
        for (auto& strip_ptr : _strips) {
            if (strip_ptr) strip_ptr->configureDither();
        }
    }

    // Drive temporal-dither sub-frames: each dithering strip that's ready re-Shows the next
    // sigma-delta sub-frame. Call frequently from the main loop between animation frames.
    void ditherTick() {
        for (auto& strip_ptr : _strips) {
            if (strip_ptr && strip_ptr->ditherEnabled() && strip_ptr->canShow()) {
                strip_ptr->ditherShow();
            }
        }
    }

    // Pixel Operations
    // color is in WRGB format (W in MSB)
    void setPixelColor(uint8_t stripIndex, uint16_t pixelIndex, uint32_t color) {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            _strips[stripIndex]->setPixelColor(pixelIndex, color);
        }
    }

    // FastLED CRGB compatible setPixelColor
    void setPixelColor(uint8_t stripIndex, uint16_t pixelIndex, const CRGB& color);

    // 2D Matrix coordinate setPixelColor
    void setPixelColorXY(uint8_t stripIndex, uint16_t x, uint16_t y, uint32_t color) {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            _strips[stripIndex]->setPixelColorXY(x, y, color);
        }
    }

    // 2D Matrix coordinate setPixelColor with CRGB
    void setPixelColorXY(uint8_t stripIndex, uint16_t x, uint16_t y, const CRGB& color) {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            _strips[stripIndex]->setPixelColorXY(x, y, color);
        }
    }

    uint32_t getPixelColor(uint8_t stripIndex, uint16_t pixelIndex) const {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            return _strips[stripIndex]->getPixelColor(pixelIndex);
        }
        return 0;
    }

    // Update. Dithering strips emit their first sub-frame here (the rest come from
    // ditherTick between animation frames); others Show normally.
    void show() {
        for (auto& strip_ptr : _strips) {
            if (!strip_ptr) continue;
            // Dithering re-Shows at a high sub-frame rate; only emit this frame's first sub-frame
            // once the previous transmission has finished latching. Showing mid-transmission tears
            // the serial frame, which on a matrix looks like the image briefly jumping along the
            // strip. (ditherTick() already guards this way; show() must too.) The updated target is
            // not lost — ditherTick picks it up on the next loop iteration.
            if (strip_ptr->ditherEnabled()) { if (strip_ptr->canShow()) strip_ptr->ditherShow(); }
            else strip_ptr->show(false);
        }
    }

    // Turn every strip fully dark and transmit it (dither-safe — see LedBus::blank).
    void blank() {
        for (auto& strip_ptr : _strips) if (strip_ptr) strip_ptr->blank();
    }

    bool canShow() const {
        for (const auto& strip_ptr : _strips) {
            if (strip_ptr && !strip_ptr->canShow()) {
                return false;
            }
        }
        return true;
    }

    // Brightness
    void setStripBrightness(uint8_t stripIndex, uint8_t brightness) {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            _strips[stripIndex]->setBrightness(brightness);
        }
    }

    uint8_t getStripBrightness(uint8_t stripIndex) const {
        if (stripIndex < _strips.size() && _strips[stripIndex]) {
            return _strips[stripIndex]->getBrightness();
        }
        return 0;
    }

    void setGlobalBrightness(uint8_t brightness) {
        _globalBrightness = brightness;
        for (auto& strip_ptr : _strips) {
            if (strip_ptr) strip_ptr->setBrightness(_globalBrightness);
        }
    }

    uint8_t getGlobalBrightness() const {
        return _globalBrightness;
    }

    // Accessors
    size_t getNumStrips() const {
        return _strips.size();
    }

    LedBus* getStrip(uint8_t stripIndex) {
        if (stripIndex < _strips.size()) {
            return _strips[stripIndex].get(); // Return raw pointer from unique_ptr
        }
        return nullptr;
    }

    const LedBus* getStrip(uint8_t stripIndex) const {
        if (stripIndex < _strips.size()) {
            return _strips[stripIndex].get(); // Return raw pointer from unique_ptr
        }
        return nullptr;
    }

private:
    std::vector<std::unique_ptr<LedBus>> _strips;
    uint8_t _globalBrightness;
};

} // namespace LedConfig

// Make sure FastLED.h is included before this if using CRGB directly in main.cpp
// or provide forward declarations if CRGB methods are implemented in a .cpp file.
#include <FastLED.h> // For CRGB definition

inline void LedConfig::LedBus::setPixelColor(uint16_t pixelIndex, const CRGB& color) {
    if (_busPtr && _internalType != ITYPE_NONE && pixelIndex < _config.numLeds) {
        if (_ditherOn) {
            // Dithering: stash a high-precision target; ditherShow() emits the sub-frames.
            setDitherTarget(pixelIndex, color);
            return;
        }
        // RGBW: split off the white channel first (in the pattern's colour space), then
        // gamma-correct the reduced RGB + W on output. Non-RGBW strips keep w=0 (no-op).
        uint8_t r = color.r, g = color.g, b = color.b, w = 0;
        if (_hasWhite && _config.autoWhiteMode != static_cast<uint8_t>(AutoWhiteMode::Off))
            computeAutoWhite(color.r, color.g, color.b, r, g, b, w);
        // Gamma-correct each channel on output (per-strip LUT).
        uint32_t wrgbColor = (static_cast<uint32_t>(lutW(w)) << 24) |
                             (static_cast<uint32_t>(lutR(r)) << 16) |
                             (static_cast<uint32_t>(lutG(g)) << 8)  |
                             static_cast<uint32_t>(lutB(b));
        LedWrapper::setPixelColor(_busPtr, _internalType, pixelIndex, wrgbColor, _config.colorOrder);
    }
}

inline void LedConfig::LedBus::setDitherTarget(uint16_t pixelIndex, const CRGB& color) {
    if (pixelIndex >= _config.numLeds) return;
    // Full-precision pipeline: 16-bit gamma+white-point correction × brightness, kept with
    // N fractional bits below 8-bit. Dithering then time-averages to that target, so gamma
    // and white point survive at far better than 8-bit before the final quantization.
    const uint16_t lc16[3] = { _lut16[0][color.r], _lut16[1][color.g], _lut16[2][color.b] };
    const uint16_t L = (uint16_t)1 << _ditherBits;
    size_t base = (size_t)pixelIndex * 3;
    for (int ch = 0; ch < 3; ch++) {
        // target_fixed = (lc16/65535) * (brightness/255) * 255 * L = lc16 * brightness * L / 65535
        uint32_t t = ((uint32_t)lc16[ch] * _brightness * L + 32767) / 65535;
        _ditherTarget[base + ch] = (uint16_t)t;
    }
}

inline void LedConfig::LedManager::setPixelColor(uint8_t stripIndex, uint16_t pixelIndex, const CRGB& color) {
    if (stripIndex < _strips.size() && _strips[stripIndex]) {
        // Convert CRGB to WRGB (assuming W=0 for CRGB)
        uint32_t wrgbColor = (static_cast<uint32_t>(color.r) << 16) |
                             (static_cast<uint32_t>(color.g) << 8)  |
                             static_cast<uint32_t>(color.b);
        _strips[stripIndex]->setPixelColor(pixelIndex, wrgbColor); // Use -> operator
    }
}

