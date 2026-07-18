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

struct Settings {
    uint8_t  commMode     = COMM_BLE;
    String   wifiSsid     = "";
    String   wifiPass     = "";
    uint8_t  wifiFallback = FB_BLE;
    uint16_t sleepMinutes = 0;      // 0 = never sleep
    bool     rgbTest      = true;   // power-on R/G/B strip test
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
    p.end();
    Serial.printf("[Settings] saved: mode=%u ssid='%s' fb=%u sleep=%u rgbtest=%u\n",
                  s.commMode, s.wifiSsid.c_str(), s.wifiFallback, s.sleepMinutes, s.rgbTest);
}

} // namespace DeviceSettings
