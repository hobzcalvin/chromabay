#pragma once

#include "led_types.h"
#include <NeoPixelBusLg.h> // Needs to be in library path

// ESP32 RMT uses 1 channel per strip by default with NeoPixelBusLg
// For more advanced RMT channel management, refer to NeoPixelBus examples.

// --- NeoPixelBusLg Template Instantiations for ESP32 RMT ---
// These map LedConfig::InternalLedType to concrete NeoPixelBusLg types.

// 3-Channel RGB Types (WS2812-like, 800Kbps, GRB feature default)
using Esp32RmtWs2812RgbBus = NeoPixelBusLg<NeoGrbFeature, NeoEsp32RmtNWs2812xMethod, NeoGammaNullMethod>;

// 4-Channel RGBW Types (SK6812-like, GRBW feature default)
using Esp32RmtSk6812RgbwBus = NeoPixelBusLg<NeoGrbwFeature, NeoEsp32RmtNSk6812Method, NeoGammaNullMethod>;

// 4-Channel RGBW Types (TM1814, WRGB feature default)
using Esp32RmtTm1814RgbwBus = NeoPixelBusLg<NeoWrgbTm1814Feature, NeoEsp32RmtNTm1814Method, NeoGammaNullMethod>;

// 3-Channel RGB Types (WS2811-like, 400Kbps, GRB feature default)
using Esp32RmtWs2811_400RgbBus = NeoPixelBusLg<NeoGrbFeature, NeoEsp32RmtN400KbpsMethod, NeoGammaNullMethod>;

// 3-Channel RGB Types (TM1829, BRG feature default)
using Esp32RmtTm1829RgbBus = NeoPixelBusLg<NeoBrgFeature, NeoEsp32RmtNTm1829Method, NeoGammaNullMethod>;

// 3-Channel RGB Types (UCS8903, 16-bit, RGB feature default)
using Esp32RmtUcs8903RgbBus = NeoPixelBusLg<NeoRgbUcs8903Feature, NeoEsp32RmtNWs2812xMethod, NeoGammaNullMethod>;

// 4-Channel RGBW Types (UCS8904, 16-bit, RGBW feature default)
using Esp32RmtUcs8904RgbwBus = NeoPixelBusLg<NeoRgbwUcs8904Feature, NeoEsp32RmtNWs2812xMethod, NeoGammaNullMethod>;

// 3-Channel RGB Types (APA106, GRB feature often used)
// NeoPixelBus NApa106Method is for GRB. For RBG use NeoEsp32RmtNApa106RbgMethod
using Esp32RmtApa106RgbBus = NeoPixelBusLg<NeoGrbFeature, NeoEsp32RmtNApa106Method, NeoGammaNullMethod>;

// 5-Channel RGBCW Types (FW1906, GRBCW feature)
// NeoGrbcwxFeature expects RgbwwColor(R,G,B,Cw,Ww) and outputs G,R,B,Cw,Ww
using Esp32RmtFw1906RgbcwBus = NeoPixelBusLg<NeoGrbcwxFeature, NeoEsp32RmtNWs2812xMethod, NeoGammaNullMethod>;

// 5-Channel RGBCW Types (WS2805, GRBWW feature)
// NeoGrbwwFeature expects RgbwwColor(R,G,B,Ww,Cw) and outputs G,R,B,Ww,Cw
using Esp32RmtWs2805RgbcwBus = NeoPixelBusLg<NeoGrbwwFeature, NeoEsp32RmtNWs2805Method, NeoGammaNullMethod>;

// 3-Channel RGB Types (TM1914, RGB feature often used)
using Esp32RmtTm1914RgbBus = NeoPixelBusLg<NeoRgbTm1914Feature, NeoEsp32RmtNTm1914Method, NeoGammaNullMethod>;

// 5-Channel RGBCW Types (SM16825, 16-bit, RGBWC feature)
// NeoRgbwcSm16825eFeature expects Rgbww80Color(R,G,B,Ww,Cw) and outputs R,G,B,Ww,Cw
using Esp32RmtSm16825RgbcwBus = NeoPixelBusLg<NeoRgbwcSm16825eFeature, NeoEsp32RmtNWs2812xMethod, NeoGammaNullMethod>;


// Helper for 16-bit color conversion
inline uint16_t scale8to16(uint8_t val8) {
    return static_cast<uint16_t>(val8 * 257); // 0xFF * 257 = 0xFFFF
}

namespace LedConfig {

class LedWrapper {
public:
    static void* create(InternalLedType busType, uint8_t pin, uint16_t len, uint8_t rmtChannel) {
        void* busPtr = nullptr;
        NeoBusChannel busChannel = static_cast<NeoBusChannel>(rmtChannel);

        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    busPtr = new Esp32RmtWs2812RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   busPtr = new Esp32RmtSk6812RgbwBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:   busPtr = new Esp32RmtTm1814RgbwBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:busPtr = new Esp32RmtWs2811_400RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    busPtr = new Esp32RmtTm1829RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:   busPtr = new Esp32RmtUcs8903RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  busPtr = new Esp32RmtUcs8904RgbwBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_APA106_RGB:    busPtr = new Esp32RmtApa106RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  busPtr = new Esp32RmtFw1906RgbcwBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  busPtr = new Esp32RmtWs2805RgbcwBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_TM1914_RGB:    busPtr = new Esp32RmtTm1914RgbBus(len, pin, busChannel); break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: busPtr = new Esp32RmtSm16825RgbcwBus(len, pin, busChannel); break;
            case ITYPE_NONE:
            default:
                break;
        }
        return busPtr;
    }

    static void begin(void* busPtr, InternalLedType busType) {
        if (!busPtr) return;
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:
                static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->Begin();
                // Default TM1814 settings (max current per channel 22.5mA)
                static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->SetPixelSettings(NeoTm1814Settings(225,225,225,225));
                break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:   static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_APA106_RGB:    static_cast<Esp32RmtApa106RgbBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->Begin(); break;
            case ITYPE_ESP32_RMT_TM1914_RGB:
                static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->Begin();
                // Default TM1914 settings (e.g., NeoTm1914_Mode_DinFdinAutoSwitch)
                static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->SetPixelSettings(NeoTm1914Settings());
                break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->Begin(); break;
            case ITYPE_NONE:
            default:
                break;
        }
    }

    static void show(void* busPtr, InternalLedType busType, bool consistent = false) { // WLED uses consistent=false for speed
        if (!busPtr) return;
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:   static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:   static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_APA106_RGB:    static_cast<Esp32RmtApa106RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_TM1914_RGB:    static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->Show(consistent); break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->Show(consistent); break;
            case ITYPE_NONE:
            default:
                break;
        }
    }

    static bool canShow(void* busPtr, InternalLedType busType) {
        if (!busPtr) return true; // No bus, so it "can show" (do nothing)
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    return static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_SK6812_RGBW:   return static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_TM1814_RGBW:   return static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_WS2811_400_RGB:return static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_TM1829_RGB:    return static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_UCS8903_RGB:   return static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  return static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_APA106_RGB:    return static_cast<Esp32RmtApa106RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  return static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  return static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_TM1914_RGB:    return static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->CanShow();
            case ITYPE_ESP32_RMT_SM16825_RGBCW: return static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->CanShow();
            case ITYPE_NONE:
            default:
                return true;
        }
    }

    static void setBrightness(void* busPtr, InternalLedType busType, uint8_t b) {
        if (!busPtr) return;
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:   static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:   static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_APA106_RGB:    static_cast<Esp32RmtApa106RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_TM1914_RGB:    static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->SetLuminance(b); break;
            case ITYPE_NONE:
            default:
                break;
        }
    }

    // color (c): WRGB format (W in MSB, B in LSB)
    // co (colorOrder): From LedConfig::ColorOrderValue, defines how to map input c to LED channels
    // wwcw (warmWhiteColdWhite): For 5-channel CCT strips, ww = wwcw & 0xFF, cw = (wwcw >> 8) & 0xFF
    static void setPixelColor(void* busPtr, InternalLedType busType, uint16_t pix, uint32_t c, ColorOrderValue co, uint16_t wwcw = 0) {
        if (!busPtr) return;

        uint8_t r_in = (c >> 16) & 0xFF;
        uint8_t g_in = (c >> 8) & 0xFF;
        uint8_t b_in = c & 0xFF;
        uint8_t w_in = (c >> 24) & 0xFF;

        uint8_t ordered_r = r_in, ordered_g = g_in, ordered_b = b_in, ordered_w = w_in;
        uint8_t cct_ww = wwcw & 0xFF;
        uint8_t cct_cw = (wwcw >> 8) & 0xFF;

        uint8_t co_rgb_part = static_cast<uint8_t>(co) & 0x0F;
        switch (static_cast<ColorOrderValue>(co_rgb_part)) {
            case ColorOrderValue::RGB: break;
            case ColorOrderValue::RBG: ordered_g = b_in; ordered_b = g_in; break;
            case ColorOrderValue::GRB: ordered_r = g_in; ordered_g = r_in; break;
            case ColorOrderValue::GBR: ordered_r = g_in; ordered_g = b_in; ordered_b = r_in; break;
            case ColorOrderValue::BRG: ordered_r = b_in; ordered_g = r_in; ordered_b = g_in; break;
            case ColorOrderValue::BGR: ordered_r = b_in; ordered_g = g_in; ordered_b = r_in; break;
            default: break; 
        }

        uint8_t co_w_part = (static_cast<uint8_t>(co) >> 4) & 0x0F;
        uint8_t temp_w_swap;
        switch (co_w_part) {
            case 0: break;
            case (static_cast<uint8_t>(ColorOrderValue::W_SWAP_W_R) >> 4): temp_w_swap = ordered_w; ordered_w = ordered_r; ordered_r = temp_w_swap; break;
            case (static_cast<uint8_t>(ColorOrderValue::W_SWAP_W_G) >> 4): temp_w_swap = ordered_w; ordered_w = ordered_g; ordered_g = temp_w_swap; break;
            case (static_cast<uint8_t>(ColorOrderValue::W_SWAP_W_B) >> 4): temp_w_swap = ordered_w; ordered_w = ordered_b; ordered_b = temp_w_swap; break;
            case (static_cast<uint8_t>(ColorOrderValue::WW_CW_SWAP) >> 4): temp_w_swap = cct_ww; cct_ww = cct_cw; cct_cw = temp_w_swap; break;
            default: break;
        }

        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:
                static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->SetPixelColor(pix, RgbColor(ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:
                static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->SetPixelColor(pix, RgbColor(ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_TM1829_RGB:
                static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->SetPixelColor(pix, RgbColor(ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_APA106_RGB:
                static_cast<Esp32RmtApa106RgbBus*>(busPtr)->SetPixelColor(pix, RgbColor(ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_TM1914_RGB:
                static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->SetPixelColor(pix, RgbColor(ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:
                static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->SetPixelColor(pix, RgbwColor(ordered_r, ordered_g, ordered_b, ordered_w));
                break;
            case ITYPE_ESP32_RMT_TM1814_RGBW: 
                static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->SetPixelColor(pix, RgbwColor(ordered_w, ordered_r, ordered_g, ordered_b));
                break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:
                static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->SetPixelColor(pix, Rgb48Color(scale8to16(ordered_r), scale8to16(ordered_g), scale8to16(ordered_b)));
                break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:
                static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->SetPixelColor(pix, Rgbw64Color(scale8to16(ordered_r), scale8to16(ordered_g), scale8to16(ordered_b), scale8to16(ordered_w)));
                break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW: 
                static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->SetPixelColor(pix, RgbwwColor(ordered_r, ordered_g, ordered_b, cct_cw, cct_ww));
                break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW: 
                static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->SetPixelColor(pix, RgbwwColor(ordered_r, ordered_g, ordered_b, cct_ww, cct_cw));
                break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: 
                static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->SetPixelColor(pix, Rgbww80Color(scale8to16(ordered_r), scale8to16(ordered_g), scale8to16(ordered_b), scale8to16(cct_ww), scale8to16(cct_cw)));
                break;
            case ITYPE_NONE:
            default:
                break;
        }
    }

    static uint32_t getPixelColor(void* busPtr, InternalLedType busType, uint16_t pix, ColorOrderValue co) {
        if (!busPtr) return 0;
        RgbwColor rawColor(0); 

        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    rawColor = static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   rawColor = static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:   rawColor = static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->GetPixelColor(pix); break; 
            case ITYPE_ESP32_RMT_WS2811_400_RGB:rawColor = static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    rawColor = static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB: {
                Rgb48Color c48 = static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->GetPixelColor(pix);
                rawColor = RgbwColor(c48.R >> 8, c48.G >> 8, c48.B >> 8, 0);
                break;
            }
            case ITYPE_ESP32_RMT_UCS8904_RGBW: {
                Rgbw64Color c64 = static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->GetPixelColor(pix);
                rawColor = RgbwColor(c64.R >> 8, c64.G >> 8, c64.B >> 8, c64.W >> 8);
                break;
            }
            case ITYPE_ESP32_RMT_APA106_RGB:    rawColor = static_cast<Esp32RmtApa106RgbBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW: { 
                RgbwwColor c5 = static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->GetPixelColor(pix); 
                rawColor = RgbwColor(c5.R, c5.G, c5.B, ((c5.WW) > (c5.CW) ? (c5.WW) : (c5.CW))); 
                break;
            }
            case ITYPE_ESP32_RMT_WS2805_RGBCW: {
                 RgbwwColor c5 = static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->GetPixelColor(pix); 
                 rawColor = RgbwColor(c5.R, c5.G, c5.B, ((c5.WW) > (c5.CW) ? (c5.WW) : (c5.CW))); 
                 break;
            }
            case ITYPE_ESP32_RMT_TM1914_RGB:    rawColor = static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->GetPixelColor(pix); break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: {
                Rgbww80Color c80 = static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->GetPixelColor(pix); 
                rawColor = RgbwColor(c80.R >> 8, c80.G >> 8, c80.B >> 8, (((c80.WW) > (c80.CW) ? (c80.WW) : (c80.CW))) >> 8);
                break;
            }
            case ITYPE_NONE:
            default:
                return 0;
        }
        // TODO: Inverse transform 'rawColor' based on 'co' to return true WRGB.
        return (static_cast<uint32_t>(rawColor.W) << 24) |
               (static_cast<uint32_t>(rawColor.R) << 16) |
               (static_cast<uint32_t>(rawColor.G) << 8)  |
               rawColor.B;
    }


    static void cleanup(void* busPtr, InternalLedType busType) {
        if (!busPtr) return;
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    delete static_cast<Esp32RmtWs2812RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_SK6812_RGBW:   delete static_cast<Esp32RmtSk6812RgbwBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_TM1814_RGBW:   delete static_cast<Esp32RmtTm1814RgbwBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_WS2811_400_RGB:delete static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_TM1829_RGB:    delete static_cast<Esp32RmtTm1829RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_UCS8903_RGB:   delete static_cast<Esp32RmtUcs8903RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  delete static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_APA106_RGB:    delete static_cast<Esp32RmtApa106RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  delete static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  delete static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_TM1914_RGB:    delete static_cast<Esp32RmtTm1914RgbBus*>(busPtr); break;
            case ITYPE_ESP32_RMT_SM16825_RGBCW: delete static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr); break;
            case ITYPE_NONE:
            default:
                break;
        }
    }

    static size_t getDataSize(void* busPtr, InternalLedType busType) {
        if (!busPtr) return 0;
        switch (busType) {
            case ITYPE_ESP32_RMT_WS2812_RGB:    return static_cast<Esp32RmtWs2812RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_SK6812_RGBW:   return static_cast<Esp32RmtSk6812RgbwBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_TM1814_RGBW:   return static_cast<Esp32RmtTm1814RgbwBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_WS2811_400_RGB:return static_cast<Esp32RmtWs2811_400RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_TM1829_RGB:    return static_cast<Esp32RmtTm1829RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_UCS8903_RGB:   return static_cast<Esp32RmtUcs8903RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_UCS8904_RGBW:  return static_cast<Esp32RmtUcs8904RgbwBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_APA106_RGB:    return static_cast<Esp32RmtApa106RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_FW1906_RGBCW:  return static_cast<Esp32RmtFw1906RgbcwBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_WS2805_RGBCW:  return static_cast<Esp32RmtWs2805RgbcwBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_TM1914_RGB:    return static_cast<Esp32RmtTm1914RgbBus*>(busPtr)->PixelsSize();
            case ITYPE_ESP32_RMT_SM16825_RGBCW: return static_cast<Esp32RmtSm16825RgbcwBus*>(busPtr)->PixelsSize();
            case ITYPE_NONE:
            default:
                return 0;
        }
    }
};

} // namespace LedConfig
