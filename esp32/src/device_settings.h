#pragma once
// Device-level settings that aren't LED config or patterns: which transport to use
// (BLE vs WiFi), WiFi credentials, the sleep timer, and the boot RGB-test toggle.
// Stored in NVS via Preferences (namespace "cbay") — separate from LittleFS, so it
// survives a filesystem reformat and is cheap to read/write.
#include <Arduino.h>
#include <Preferences.h>

namespace DeviceSettings {

enum CommMode : uint8_t { COMM_BLE = 0, COMM_WIFI = 1 };
// What to do if WiFi-mode STA connect fails at boot.
enum WifiFallback : uint8_t { FB_BLE = 0, FB_AP = 1 };

// Realtime pixel streaming (Art-Net / sACN) over WiFi. When enabled and packets arrive,
// the device shows the streamed pixels and auto-reverts to its pattern/cycle after rtTimeout
// seconds of silence. Only active in WiFi mode.
enum RtProto : uint8_t { RT_OFF = 0, RT_ARTNET = 1, RT_SACN = 2, RT_BOTH = 3 };

struct Settings {
    uint8_t  commMode     = COMM_BLE;
    String   wifiSsid     = "";
    String   wifiPass     = "";
    uint8_t  wifiFallback = FB_BLE;
    uint16_t sleepMinutes = 0;      // 0 = never sleep
    bool     rgbTest      = true;   // power-on R/G/B strip test
    // Realtime streaming (opt-in; inert unless rtProto != RT_OFF and on WiFi):
    uint8_t  rtProto      = RT_OFF; // Art-Net / sACN / both / off
    uint16_t rtUniverse   = 0;      // first universe this device consumes (0-based Art-Net / 1-based sACN handled in parse)
    uint16_t rtTimeoutSec = 10;     // revert to pattern after this much silence
    bool     rtLayout     = false;  // true = stream into the custom layout (reorder/skip); false = physical order
    // Daily on/off schedule (local wall-clock). Needs a synced clock (app TIMESTAMP_SYNC or,
    // on WiFi, NTP); inert until the device knows the time, and after power loss until it
    // re-syncs. Times are minutes past local midnight (0..1439); a wrap (on>off) spans midnight.
    bool     schedEnable  = false;
    uint16_t schedOnMin   = 0;      // turn output ON at this local minute-of-day
    uint16_t schedOffMin  = 0;      // turn output OFF at this local minute-of-day
    int16_t  tzOffsetMin  = 0;      // local = UTC + this many minutes (app sends its current offset)
};

static const char* NS = "cbay";

inline Settings load() {
    Settings s;
    Preferences p;
    if (!p.begin(NS, /*readOnly=*/true)) return s; // namespace not created yet → defaults
    s.commMode     = p.getUChar("mode", s.commMode);
    s.wifiSsid     = p.getString("ssid", s.wifiSsid);
    s.wifiPass     = p.getString("pass", s.wifiPass);
    s.wifiFallback = p.getUChar("fb", s.wifiFallback);
    s.sleepMinutes = p.getUShort("sleep", s.sleepMinutes);
    s.rgbTest      = p.getBool("rgbtest", s.rgbTest);
    s.rtProto      = p.getUChar("rtproto", s.rtProto);
    s.rtUniverse   = p.getUShort("rtuni", s.rtUniverse);
    s.rtTimeoutSec = p.getUShort("rtto", s.rtTimeoutSec);
    s.rtLayout     = p.getBool("rtlayout", s.rtLayout);
    s.schedEnable  = p.getBool("sen", s.schedEnable);
    s.schedOnMin   = p.getUShort("son", s.schedOnMin);
    s.schedOffMin  = p.getUShort("sof", s.schedOffMin);
    s.tzOffsetMin  = p.getShort("tz", s.tzOffsetMin);
    p.end();
    return s;
}

inline void save(const Settings& s) {
    Preferences p;
    if (!p.begin(NS, /*readOnly=*/false)) { Serial.println("[Settings] NVS open failed"); return; }
    p.putUChar("mode", s.commMode);
    p.putString("ssid", s.wifiSsid);
    p.putString("pass", s.wifiPass);
    p.putUChar("fb", s.wifiFallback);
    p.putUShort("sleep", s.sleepMinutes);
    p.putBool("rgbtest", s.rgbTest);
    p.putUChar("rtproto", s.rtProto);
    p.putUShort("rtuni", s.rtUniverse);
    p.putUShort("rtto", s.rtTimeoutSec);
    p.putBool("rtlayout", s.rtLayout);
    p.putBool("sen", s.schedEnable);
    p.putUShort("son", s.schedOnMin);
    p.putUShort("sof", s.schedOffMin);
    p.putShort("tz", s.tzOffsetMin);
    p.end();
    Serial.printf("[Settings] saved: mode=%u ssid='%s' fb=%u sleep=%u rgbtest=%u\n",
                  s.commMode, s.wifiSsid.c_str(), s.wifiFallback, s.sleepMinutes, s.rgbTest);
}

} // namespace DeviceSettings
