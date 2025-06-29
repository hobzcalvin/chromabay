#pragma once

#include <vector>
#include <cstdint>
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
    uint8_t pin = 0;
    uint16_t numLeds = 0;
    ColorOrderValue colorOrder = ColorOrderValue::CO_GRB; // Default to GRB
    uint8_t rmtChannel = 0; // ESP32 RMT channel (0-7 for NeoPixelBus default RMT method)
    
    // Matrix/2D Layout Configuration
    uint16_t width = 0;      // Width in pixels (0 = linear strip)
    uint16_t height = 0;     // Height in pixels (0 = linear strip)
    uint8_t orientation = 0; // Bit 0-1: rotation (0°/90°/180°/270°), Bit 2: flip H, Bit 3: serpentine
    
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
        _internalType = mapChipsetToInternalType(_config.chipset);
        if (_internalType != ITYPE_NONE && _config.numLeds > 0) {
            // Note: RMT channel is passed to LedWrapper::create
            _busPtr = LedWrapper::create(_internalType, _config.pin, _config.numLeds, _config.rmtChannel);
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
        if (_busPtr && _internalType != ITYPE_NONE) {
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

private:
    LedStripConfig _config;
    void* _busPtr;
    InternalLedType _internalType;
    uint8_t _brightness;

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
            // Add mappings for other chipsets as they are defined in LedTypes and LedWrapper
            // case LedChipset::APA102_SPI: return ITYPE_ESP32_HSPI_APA102_RGB; // Example
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

    // Update
    void show() {
        for (auto& strip_ptr : _strips) {
            if (strip_ptr) strip_ptr->show(false);
        }
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
        // Convert CRGB to WRGB (assuming W=0 for CRGB)
        uint32_t wrgbColor = (static_cast<uint32_t>(color.r) << 16) |
                             (static_cast<uint32_t>(color.g) << 8)  |
                             static_cast<uint32_t>(color.b);
        LedWrapper::setPixelColor(_busPtr, _internalType, pixelIndex, wrgbColor, _config.colorOrder);
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

