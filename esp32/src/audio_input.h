#pragma once
// Microphone input for audio reactivity: I2S / PDM capture on a FreeRTOS task, analysed by the
// shared Audio::Analyzer (native/AudioReactive.h), published once per frame into
// Audio::g_features for operators and automation to read.
//
// Settings mirror WLED's AudioReactive usermod ("um" -> "AudioReactive" in cfg.json): the same
// mic type numbers, pin order, squelch/gain/AGC, dynamics limiter and frequency scaling. That
// keeps a converted WLED device's mic working and lets the app's settings read like WLED's.
//
// Cost: a 512-point FFT ~86 times a second on core 0 (a few % of a core on ESP32/S3), and
// ~30 KB of RAM (analyzer ~15 KB, DMA 8 KB, task stack 8 KB), allocated only while a mic is enabled.
#include <Arduino.h>
#include <Preferences.h>
#include <driver/i2s.h>
#include <soc/soc_caps.h>
#if CONFIG_IDF_TARGET_ESP32
#include <soc/i2s_reg.h>
#endif
#include "../../native/AudioReactive.h"

namespace AudioInput {

// WLED's dmType numbering, kept as-is so imported configs map 1:1. Types this firmware can't
// drive (analog, the I2C codecs) are accepted and stored but report "unsupported".
enum MicType : uint8_t {
    MIC_ANALOG     = 0,  // WLED: analog mic on ADC1 (not supported here)
    MIC_I2S        = 1,  // generic I2S (INMP441, ICS-43434, ...)
    MIC_ES7243     = 2,  // WLED: ES7243 codec over I2C (not supported here)
    MIC_SPH0645    = 3,  // I2S with the SPH0645's late-MSB quirk
    MIC_I2S_MCLK   = 4,  // generic I2S with a master clock output
    MIC_PDM        = 5,  // generic PDM (SPM1423, MP34DT01, ...)
    MIC_ES8388     = 6,  // WLED: ES8388 codec (not supported here)
    MIC_SIMULATED  = 250 // ChromaBay: no hardware, a synthetic 120 bpm groove (for testing)
};

struct Settings {
    bool    enabled = false;
    uint8_t type = MIC_I2S;
    int8_t  sd = -1, ws = -1, sck = -1, mclk = -1; // WLED "digitalmic:pin" order
    Audio::Config cfg;                              // squelch, gain, AGC, limiter, scale
};

static const char* NS = "cbay_au";

inline Settings load() {
    Settings s;
    Preferences p;
    if (!p.begin(NS, true)) return s;
    s.enabled = p.getBool("en", s.enabled);
    s.type = p.getUChar("type", s.type);
    s.sd = p.getChar("sd", s.sd); s.ws = p.getChar("ws", s.ws);
    s.sck = p.getChar("sck", s.sck); s.mclk = p.getChar("mclk", s.mclk);
    s.cfg.squelch = p.getUChar("sq", s.cfg.squelch);
    s.cfg.gain = p.getUChar("gain", s.cfg.gain);
    s.cfg.agc = p.getUChar("agc", s.cfg.agc);
    s.cfg.limiter = p.getBool("lim", s.cfg.limiter);
    s.cfg.riseMs = p.getUShort("rise", s.cfg.riseMs);
    s.cfg.fallMs = p.getUShort("fall", s.cfg.fallMs);
    s.cfg.scale = p.getUChar("scale", s.cfg.scale);
    p.end();
    return s;
}

inline void save(const Settings& s) {
    Preferences p;
    if (!p.begin(NS, false)) return;
    p.putBool("en", s.enabled); p.putUChar("type", s.type);
    p.putChar("sd", s.sd); p.putChar("ws", s.ws); p.putChar("sck", s.sck); p.putChar("mclk", s.mclk);
    p.putUChar("sq", s.cfg.squelch); p.putUChar("gain", s.cfg.gain); p.putUChar("agc", s.cfg.agc);
    p.putBool("lim", s.cfg.limiter); p.putUShort("rise", s.cfg.riseMs); p.putUShort("fall", s.cfg.fallMs);
    p.putUChar("scale", s.cfg.scale);
    p.end();
}

inline bool pdmSupported() {
#if SOC_I2S_SUPPORTS_PDM_RX
    return true;
#else
    return false;
#endif
}

inline bool typeSupported(uint8_t t) {
    return t == MIC_I2S || t == MIC_SPH0645 || t == MIC_I2S_MCLK || t == MIC_SIMULATED ||
           (t == MIC_PDM && pdmSupported());
}

// ---- runtime state ------------------------------------------------------------------------

constexpr float SAMPLE_RATE = 22050.0f;
constexpr int   READ_SAMPLES = 256;
constexpr i2s_port_t PORT = I2S_NUM_0; // the only port with PDM RX, and the only one on C3

inline Settings g_settings;
inline Audio::Analyzer* g_analyzer = nullptr;
inline TaskHandle_t g_task = nullptr;
inline volatile bool g_stop = false;
inline volatile bool g_running = false;      // driver installed and task reading
inline bool g_driverInstalled = false;
inline Audio::Features g_latest;              // written by the audio task
inline volatile bool g_fresh = false;
inline portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
inline char g_status[48] = "off";
inline volatile uint32_t g_blocks = 0;        // analysed blocks, for "is the mic delivering?"
inline volatile float g_rawPeak = 0.0f;       // peak |sample| of the last read, before gain
inline volatile int8_t g_slot = -1;           // which I2S slot carries the mic: 0 left, 1 right, -1 not yet known
inline char g_baseStatus[24] = "";            // "listening (I2S)" etc.; the slot is appended once known

inline void setStatus(const char* s) { strncpy(g_status, s, sizeof(g_status) - 1); g_status[sizeof(g_status) - 1] = 0; }

inline void audioTask(void*) {
    const bool pdm = g_settings.type == MIC_PDM;
    // Both slots are captured and the one carrying sound is used. A mono "left only" capture
    // is what the datasheets suggest (L/R pin to GND), but on ESP-IDF 4.4 the classic ESP32
    // reads the WRONG slot for it (espressif/esp-idf#6625, #9635), so the mic delivered pure
    // silence; WLED works around the same bug. Capturing both also forgives a mic wired to
    // the other slot. 32-bit slots for I2S mics (24-bit data, left-justified), 16-bit for PDM.
    // On the task's own stack, so nothing is held while audio is off.
    int32_t raw32[READ_SAMPLES * 2];
    int16_t* raw16 = (int16_t*)raw32;
    float samples[READ_SAMPLES];
    float energy[2] = { 0.0f, 0.0f };   // per-slot running energy
    int slot = -1;
    uint32_t silentReads = 0;           // consecutive reads where both slots were exactly 0
    while (!g_stop) {
        size_t got = 0;
        size_t want = READ_SAMPLES * 2 * (pdm ? sizeof(int16_t) : sizeof(int32_t));
        esp_err_t err = i2s_read(PORT, raw32, want, &got, pdMS_TO_TICKS(100));
        if (err != ESP_OK || got == 0) continue;
        int frames = (int)(got / (2 * (pdm ? sizeof(int16_t) : sizeof(int32_t))));
        auto sampleAt = [&](int i) -> float {
            return pdm ? (float)raw16[i] / 32768.0f : (float)(raw32[i] >> 8) / 8388608.0f;
        };
        // Energy of each slot (after removing its mean, so a floating pin's constant level
        // doesn't count as sound). Interleaved: even = one slot, odd = the other.
        float mean[2] = { 0.0f, 0.0f }, e[2] = { 0.0f, 0.0f };
        bool anyNonZero = false;
        for (int i = 0; i < frames; i++) { mean[0] += sampleAt(2 * i); mean[1] += sampleAt(2 * i + 1); }
        mean[0] /= (float)frames; mean[1] /= (float)frames;
        for (int i = 0; i < frames; i++) {
            float a = sampleAt(2 * i) - mean[0], b = sampleAt(2 * i + 1) - mean[1];
            e[0] += a * a; e[1] += b * b;
            if (sampleAt(2 * i) != 0.0f || sampleAt(2 * i + 1) != 0.0f) anyNonZero = true;
        }
        for (int c = 0; c < 2; c++) energy[c] += (e[c] - energy[c]) * 0.05f;
        // Pick the louder slot; switch only when the other is clearly (4x) louder.
        int louder = energy[1] > energy[0] ? 1 : 0;
        if (slot < 0 ? energy[louder] > 1e-9f : energy[louder] > 4.0f * energy[1 - louder]) slot = louder;
        if (slot != g_slot) {
            g_slot = (int8_t)slot;
            if (slot >= 0) {
                char st[48];
                // Which physical side "even" is depends on the IDF bug above; report it as
                // the slot the data arrived in, which is what matters for debugging.
                snprintf(st, sizeof(st), "%s, slot %c", g_baseStatus, slot == 0 ? 'A' : 'B');
                setStatus(st);
            }
        }
        silentReads = anyNonZero ? 0 : silentReads + 1;
        if (silentReads == 200) { // ~2.3 s of exact zeros on both slots
            char st[48];
            snprintf(st, sizeof(st), "no signal: check SD/data pin, power");
            setStatus(st);
        } else if (silentReads == 0 && strncmp(g_status, "no signal", 9) == 0) {
            setStatus(g_baseStatus);
            g_slot = -1; slot = -1;
        }
        const int use = slot < 0 ? 0 : slot;
        float peak = 0.0f;
        for (int i = 0; i < frames; i++) {
            float s = sampleAt(2 * i + use);
            samples[i] = s;
            float a = fabsf(s); if (a > peak) peak = a;
        }
        const int n = frames;
        g_rawPeak = peak;
        g_analyzer->cfg = g_settings.cfg; // cheap copy; picks up live gain/squelch edits
        if (g_analyzer->push(samples, n) > 0) {
            portENTER_CRITICAL(&g_mux);
            g_latest = g_analyzer->features();
            g_fresh = true;
            portEXIT_CRITICAL(&g_mux);
            g_blocks++;
        }
    }
    g_running = false;
    g_task = nullptr;
    vTaskDelete(nullptr);
}

inline void stop() {
    if (g_task) {
        g_stop = true;
        for (int i = 0; i < 50 && g_task; i++) delay(10); // task exits within one read timeout
    }
    if (g_driverInstalled) { i2s_driver_uninstall(PORT); g_driverInstalled = false; }
    delete g_analyzer; g_analyzer = nullptr;
    g_running = false;
    Audio::g_source = Audio::SOURCE_NONE;
    Audio::set(Audio::Features{});
    setStatus("off");
}

// (Re)start capture from g_settings. Safe to call repeatedly; returns false with a status
// message when the configuration can't run.
inline bool start(const Settings& s) {
    stop();
    g_settings = s;
    if (!s.enabled) return false;
    if (s.type == MIC_SIMULATED) {
        Audio::g_source = Audio::SOURCE_SIMULATED; // the renderer ticks it on the frame clock
        setStatus("simulated");
        return true;
    }
    if (!typeSupported(s.type)) {
        setStatus(s.type == MIC_PDM ? "PDM mics need ESP32 or ESP32-S3" : "mic type not supported yet");
        return false;
    }
    const bool pdm = s.type == MIC_PDM;
    if (s.sd < 0 || s.ws < 0 || (!pdm && s.sck < 0)) { setStatus("set the mic pins"); return false; }

    g_analyzer = new (std::nothrow) Audio::Analyzer(SAMPLE_RATE);
    if (!g_analyzer) { setStatus("not enough memory"); return false; }
    g_analyzer->cfg = s.cfg;

    i2s_config_t ic = {};
    ic.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | (pdm ? I2S_MODE_PDM : 0));
    ic.sample_rate = (uint32_t)SAMPLE_RATE;
    ic.bits_per_sample = pdm ? I2S_BITS_PER_SAMPLE_16BIT : I2S_BITS_PER_SAMPLE_32BIT;
    ic.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT; // both slots; the task picks the live one
    ic.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    ic.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    ic.dma_buf_count = 8;
    ic.dma_buf_len = 128; // frames: 8 x 128 x 2 slots x 4 bytes = 8 KB of DMA
    ic.use_apll = false;
    if (s.type == MIC_I2S_MCLK) { ic.fixed_mclk = 256 * (int)SAMPLE_RATE; ic.mclk_multiple = I2S_MCLK_MULTIPLE_256; }
    if (i2s_driver_install(PORT, &ic, 0, nullptr) != ESP_OK) {
        delete g_analyzer; g_analyzer = nullptr;
        setStatus("I2S driver failed");
        return false;
    }
    g_driverInstalled = true;

    i2s_pin_config_t pc = {};
    pc.mck_io_num = (s.type == MIC_I2S_MCLK && s.mclk >= 0) ? s.mclk : I2S_PIN_NO_CHANGE;
    pc.bck_io_num = pdm ? I2S_PIN_NO_CHANGE : s.sck;
    pc.ws_io_num = s.ws;          // for PDM this is the clock pin
    pc.data_out_num = I2S_PIN_NO_CHANGE;
    pc.data_in_num = s.sd;
    if (i2s_set_pin(PORT, &pc) != ESP_OK) {
        stop();
        setStatus("invalid mic pins");
        return false;
    }
#if CONFIG_IDF_TARGET_ESP32
    if (s.type == MIC_SPH0645) {
        // SPH0645 clocks its MSB one bit late; WLED applies the same register tweak.
        REG_SET_BIT(I2S_TIMING_REG(PORT), BIT(9));
        REG_SET_BIT(I2S_CONF_REG(PORT), I2S_RX_MSB_SHIFT);
    }
#endif
    i2s_zero_dma_buffer(PORT);

    g_stop = false;
    g_running = true;
    // Core 0 next to WiFi/BLE, leaving the render loop's core alone (single-core C3: core 0).
    BaseType_t ok = xTaskCreatePinnedToCore(audioTask, "audio", 8192, nullptr, 1, &g_task, 0);
    if (ok != pdPASS) {
        g_running = false; g_task = nullptr;
        stop();
        setStatus("no room for the audio task");
        return false;
    }
    Audio::g_source = Audio::SOURCE_LIVE;
    g_slot = -1;
    strncpy(g_baseStatus, pdm ? "listening (PDM)" : "listening (I2S)", sizeof(g_baseStatus) - 1);
    setStatus(g_baseStatus);
    return true;
}

// Once per frame on the render task: copy the latest analysis into Audio::g_features.
inline void snapshot() {
    if (Audio::g_source != Audio::SOURCE_LIVE || !g_fresh) return;
    portENTER_CRITICAL(&g_mux);
    Audio::Features f = g_latest;
    g_fresh = false;
    portEXIT_CRITICAL(&g_mux);
    Audio::set(f);
}

// Pins the mic is using (for conflict checks against LED / button pins). -1 = unused.
inline bool usesPin(int pin) {
    if (!g_settings.enabled || g_settings.type == MIC_SIMULATED || pin < 0) return false;
    return pin == g_settings.sd || pin == g_settings.ws ||
           (g_settings.type != MIC_PDM && pin == g_settings.sck) ||
           (g_settings.type == MIC_I2S_MCLK && pin == g_settings.mclk);
}

} // namespace AudioInput
