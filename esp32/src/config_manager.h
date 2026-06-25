#pragma once

#include "led_manager.h" // For LedStripConfig, LedChipset, ColorOrderValue, and LedManager
#include <LittleFS.h>
#include "mpack.h"      // Amalgamated MPack header (added to src/)
#include <vector>
#include <Arduino.h>    // For String (debug), and basic types

namespace LedConfig {

// --- Constants for Configuration ---
const char* const DEFAULT_CONFIG_FILENAME = "/led_config.mpack";
const uint8_t CONFIG_FILE_VERSION = 1;

// MessagePack Keys
namespace ConfigKeys {
    const char* const VERSION = "v";
    const char* const GLOBAL_BRIGHTNESS = "gb";
    const char* const STRIPS = "strips";
    // Strip Keys
    const char* const CHIPSET = "cs";
    const char* const PIN = "pin";
    const char* const NUM_LEDS = "num";
    const char* const COLOR_ORDER = "co";
    const char* const RMT_CHANNEL = "rmt";
    const char* const WIDTH = "w";
    const char* const HEIGHT = "h";
    const char* const ORIENTATION = "ort";
    const char* const GAMMA = "gm"; // per-strip gamma*100 (u16), optional
    const char* const WHITE_POINT = "wp"; // per-strip white point packed 0xRRGGBB (u32), optional
} // namespace ConfigKeys

// Structure to hold the complete configuration for serialization/deserialization
struct FullLedConfiguration {
    uint8_t globalBrightness = 255; // Default global brightness
    std::vector<LedStripConfig> strips;
    uint8_t fileVersion = 0; // Version of the loaded file, 0 if not loaded or default

    bool isDefault() const {
        return globalBrightness == 255 && strips.empty() && fileVersion == 0;
    }
};


class ConfigManager {
public:
    ConfigManager(LedManager& ledManager) : _ledManager(ledManager) {
    }

    bool saveConfiguration(const char* filePath = DEFAULT_CONFIG_FILENAME) const {
        mpack_writer_t writer;
        char* mpack_buffer = nullptr;
        size_t mpack_size = 0;
        mpack_writer_init_growable(&writer, &mpack_buffer, &mpack_size);

        // Root map: version, global_brightness, strips (3 key-value pairs)
        mpack_start_map(&writer, 3);

        // Version
        mpack_write_cstr(&writer, ConfigKeys::VERSION);
        mpack_write_u8(&writer, CONFIG_FILE_VERSION);

        // Global Brightness
        mpack_write_cstr(&writer, ConfigKeys::GLOBAL_BRIGHTNESS);
        mpack_write_u8(&writer, _ledManager.getGlobalBrightness());

        // Strips Array
        mpack_write_cstr(&writer, ConfigKeys::STRIPS);
        size_t numStrips = _ledManager.getNumStrips();
        mpack_start_array(&writer, numStrips);

        for (size_t i = 0; i < numStrips; ++i) {
            const LedBus* bus = _ledManager.getStrip(i);
            if (bus) {
                const LedStripConfig& stripConfig = bus->getConfig();
                // Each strip is a map (10 key-value pairs incl. gamma + white point)
                mpack_start_map(&writer, 10);
                mpack_write_cstr(&writer, ConfigKeys::CHIPSET);
                mpack_write_u8(&writer, static_cast<uint8_t>(stripConfig.chipset));
                mpack_write_cstr(&writer, ConfigKeys::PIN);
                mpack_write_u8(&writer, stripConfig.pin);
                mpack_write_cstr(&writer, ConfigKeys::NUM_LEDS);
                mpack_write_u16(&writer, stripConfig.numLeds);
                mpack_write_cstr(&writer, ConfigKeys::COLOR_ORDER);
                mpack_write_u8(&writer, static_cast<uint8_t>(stripConfig.colorOrder));
                mpack_write_cstr(&writer, ConfigKeys::RMT_CHANNEL);
                mpack_write_u8(&writer, stripConfig.rmtChannel);
                mpack_write_cstr(&writer, ConfigKeys::WIDTH);
                mpack_write_u16(&writer, stripConfig.width);
                mpack_write_cstr(&writer, ConfigKeys::HEIGHT);
                mpack_write_u16(&writer, stripConfig.height);
                mpack_write_cstr(&writer, ConfigKeys::ORIENTATION);
                mpack_write_u8(&writer, stripConfig.orientation);
                mpack_write_cstr(&writer, ConfigKeys::GAMMA);
                mpack_write_u16(&writer, (uint16_t)(stripConfig.gamma * 100.0f + 0.5f));
                mpack_write_cstr(&writer, ConfigKeys::WHITE_POINT);
                mpack_write_u32(&writer, ((uint32_t)stripConfig.wpR << 16) | ((uint32_t)stripConfig.wpG << 8) | (uint32_t)stripConfig.wpB);
                mpack_finish_map(&writer);
            }
        }
        mpack_finish_array(&writer);
        mpack_finish_map(&writer);

        if (mpack_writer_destroy(&writer) != mpack_ok) {
            Serial.print(F("[ConfigManager] Mpack encoding error: "));
            Serial.println(mpack_error_to_string(mpack_writer_error(&writer)));
            if (mpack_buffer) free(mpack_buffer);
            return false;
        }

        File configFile = LittleFS.open(filePath, FILE_WRITE);
        if (!configFile) {
            Serial.print(F("[ConfigManager] Failed to open config file for writing: "));
            Serial.println(filePath);
            if (mpack_buffer) free(mpack_buffer);
            return false;
        }

        size_t bytesWritten = configFile.write(reinterpret_cast<const uint8_t*>(mpack_buffer), mpack_size);
        configFile.close();
        if (mpack_buffer) free(mpack_buffer);

        if (bytesWritten != mpack_size) {
            Serial.println(F("[ConfigManager] Failed to write complete Mpack data to file."));
            LittleFS.remove(filePath); // Remove potentially corrupted file
            return false;
        }

        Serial.print(F("[ConfigManager] Configuration saved to "));
        Serial.println(filePath);
        return true;
    }

    FullLedConfiguration loadConfigurationFromFile(const char* filePath = DEFAULT_CONFIG_FILENAME, bool* successFlag = nullptr) const {
        FullLedConfiguration loadedConfig; 
        if (successFlag) *successFlag = false;

        if (!LittleFS.exists(filePath)) {
            Serial.print(F("[ConfigManager] Config file not found: "));
            Serial.println(filePath);
            return loadedConfig;
        }

        File configFile = LittleFS.open(filePath, FILE_READ);
        if (!configFile) {
            Serial.print(F("[ConfigManager] Failed to open config file for reading: "));
            Serial.println(filePath);
            return loadedConfig;
        }

        size_t fileSize = configFile.size();
        if (fileSize == 0) {
            Serial.println(F("[ConfigManager] Config file is empty."));
            configFile.close();
            return loadedConfig;
        }
        if (fileSize > 4096) { // Sanity check for buffer size
            Serial.println(F("[ConfigManager] Config file too large."));
            configFile.close();
            return loadedConfig;
        }

        char* fileBuffer = new (std::nothrow) char[fileSize];
        if (!fileBuffer) {
            Serial.println(F("[ConfigManager] Failed to allocate buffer for config file."));
            configFile.close();
            return loadedConfig;
        }

        size_t bytesRead = configFile.readBytes(fileBuffer, fileSize);
        configFile.close();

        if (bytesRead != fileSize) {
            Serial.println(F("[ConfigManager] Failed to read complete config file."));
            delete[] fileBuffer;
            return loadedConfig;
        }

        mpack_reader_t reader;
        mpack_reader_init_data(&reader, fileBuffer, fileSize);

        uint32_t root_map_count = mpack_expect_map(&reader);
        if (mpack_reader_error(&reader) != mpack_ok) {
            Serial.println(F("[ConfigManager] Error reading root map."));
            mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;
        }


        for (uint32_t i = 0; i < root_map_count; ++i) {
            char key_buffer[32]; // Max key length + null terminator
            // Use mpack_expect_cstr instead of mpack_expect_str_buf to ensure proper null termination
            mpack_expect_cstr(&reader, key_buffer, sizeof(key_buffer));
            if (mpack_reader_error(&reader) != mpack_ok) {
                 Serial.println(F("[ConfigManager] Error reading map key string."));
                 mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;
            }

            if (strcmp(key_buffer, ConfigKeys::VERSION) == 0) {
                loadedConfig.fileVersion = mpack_expect_u8(&reader);
                if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}
                if (loadedConfig.fileVersion > CONFIG_FILE_VERSION) {
                     Serial.print(F("[ConfigManager] Config file version ("));
                     Serial.print(loadedConfig.fileVersion);
                     Serial.print(F(") is newer than supported ("));
                     Serial.print(CONFIG_FILE_VERSION);
                     Serial.println(F("). Loading aborted."));
                     mpack_reader_destroy(&reader); delete[] fileBuffer; return FullLedConfiguration();
                }
            } else if (strcmp(key_buffer, ConfigKeys::GLOBAL_BRIGHTNESS) == 0) {
                loadedConfig.globalBrightness = mpack_expect_u8(&reader);
                if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}
            } else if (strcmp(key_buffer, ConfigKeys::STRIPS) == 0) {
                uint32_t num_strips = mpack_expect_array(&reader);
                if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}
                loadedConfig.strips.reserve(num_strips);
                for (uint32_t s_idx = 0; s_idx < num_strips; ++s_idx) {
                    LedStripConfig stripConfig;
                    bool stripValid = true;
                    uint32_t strip_map_count = mpack_expect_map(&reader);
                    if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}

                    for (uint32_t k_idx = 0; k_idx < strip_map_count; ++k_idx) {
                        // Fix: Use mpack_expect_cstr for proper null termination
                        mpack_expect_cstr(&reader, key_buffer, sizeof(key_buffer));
                        if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}

                        if (strcmp(key_buffer, ConfigKeys::CHIPSET) == 0) {
                            stripConfig.chipset = static_cast<LedChipset>(mpack_expect_u8(&reader));
                        } else if (strcmp(key_buffer, ConfigKeys::PIN) == 0) {
                            stripConfig.pin = mpack_expect_u8(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::NUM_LEDS) == 0) {
                            stripConfig.numLeds = mpack_expect_u16(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::COLOR_ORDER) == 0) {
                            stripConfig.colorOrder = static_cast<ColorOrderValue>(mpack_expect_u8(&reader));
                        } else if (strcmp(key_buffer, ConfigKeys::RMT_CHANNEL) == 0) {
                            stripConfig.rmtChannel = mpack_expect_u8(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::WIDTH) == 0) {
                            stripConfig.width = mpack_expect_u16(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::HEIGHT) == 0) {
                            stripConfig.height = mpack_expect_u16(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::ORIENTATION) == 0) {
                            stripConfig.orientation = mpack_expect_u8(&reader);
                        } else if (strcmp(key_buffer, ConfigKeys::GAMMA) == 0) {
                            // Stored as gamma*100 (integer) to avoid float msgpack quirks.
                            stripConfig.gamma = mpack_expect_u16(&reader) / 100.0f;
                        } else if (strcmp(key_buffer, ConfigKeys::WHITE_POINT) == 0) {
                            uint32_t wp = mpack_expect_u32(&reader);
                            stripConfig.wpR = (wp >> 16) & 0xFF;
                            stripConfig.wpG = (wp >> 8) & 0xFF;
                            stripConfig.wpB = wp & 0xFF;
                        } else {
                            Serial.print(F("[ConfigManager] Unknown key in strip map: ")); Serial.println(key_buffer);
                            mpack_discard(&reader); 
                            stripValid = false;
                        }
                        if (mpack_reader_error(&reader) != mpack_ok && stripValid) { /* error handling for value read */ stripValid = false; }
                    }
                    mpack_done_map(&reader);
                    if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}

                    if (stripValid && stripConfig.numLeds > 0) {
                        loadedConfig.strips.push_back(stripConfig);
                    } else {
                        Serial.print(F("[ConfigManager] Invalid or incomplete strip data at index "));
                        Serial.print(s_idx); Serial.println(F(". Skipping."));
                    }
                }
                mpack_done_array(&reader);
                 if (mpack_reader_error(&reader) != mpack_ok) { /* error handling */ mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;}
            } else {
                Serial.print(F("[ConfigManager] Unknown key in root map: ")); Serial.println(key_buffer);
                mpack_discard(&reader); 
            }
        }
        mpack_done_map(&reader);

        if (mpack_reader_destroy(&reader) != mpack_ok) {
            Serial.print(F("[ConfigManager] Mpack decoding error at end: "));
            Serial.println(mpack_error_to_string(mpack_reader_error(&reader)));
            delete[] fileBuffer;
            return FullLedConfiguration(); // Return default config
        }
        
        delete[] fileBuffer;
        if (successFlag) *successFlag = true;
        Serial.print(F("[ConfigManager] Configuration successfully loaded from "));
        Serial.println(filePath);
        return loadedConfig;
    }

    bool applyConfiguration(const FullLedConfiguration& config) {
        _ledManager.clearStrips(); 
        _ledManager.setGlobalBrightness(config.globalBrightness);

        // Debug: Print detailed configuration being applied
        Serial.println(F("=== LED CONFIGURATION DEBUG ==="));
        Serial.printf("Global Brightness: %d\n", config.globalBrightness);
        Serial.printf("Number of strips: %d\n", config.strips.size());
        
        bool allStripsAdded = true;
        for (size_t i = 0; i < config.strips.size(); i++) {
            LedStripConfig stripConfig = config.strips[i];
            // RMT channel is an implementation detail, not a user setting: each strip
            // needs its own hardware lane, so just assign sequentially by index. This
            // ignores whatever the app sent (which defaulted every strip to 0 and made
            // them collide).
            stripConfig.rmtChannel = (uint8_t)i;
            Serial.printf("Strip %d:\n", i);
            Serial.printf("  Chipset: %d\n", static_cast<int>(stripConfig.chipset));
            Serial.printf("  Pin: %d\n", stripConfig.pin);
            Serial.printf("  NumLeds: %d\n", stripConfig.numLeds);
            Serial.printf("  ColorOrder: %d\n", static_cast<int>(stripConfig.colorOrder));
            Serial.printf("  RMT Channel (auto): %d\n", stripConfig.rmtChannel);

            if (!_ledManager.addStrip(stripConfig)) {
                Serial.print(F("[ConfigManager] Failed to add strip to LedManager: Pin "));
                Serial.println(stripConfig.pin);
                allStripsAdded = false;
            }
        }

        if (!config.strips.empty() || _ledManager.getNumStrips() > 0) {
            _ledManager.begin();
        }

        // Apply any per-strip arbitrary pixel layouts saved on the device.
        loadStripLayouts();

        // Debug: Print final LED manager state
        Serial.printf("Final LED Manager State:\n");
        Serial.printf("  Total strips: %d\n", _ledManager.getNumStrips());
        for (size_t i = 0; i < _ledManager.getNumStrips(); i++) {
            const LedBus* bus = _ledManager.getStrip(i);
            if (bus) {
                Serial.printf("  Strip %d length: %d\n", i, bus->getLength());
            }
        }
        Serial.println(F("=== END CONFIG DEBUG ==="));
        
        Serial.println(F("[ConfigManager] Configuration applied to LedManager."));
        return allStripsAdded;
    }

    bool loadAndApplyConfiguration(const char* filePath = DEFAULT_CONFIG_FILENAME) {
        bool loadSuccess = false;
        FullLedConfiguration loadedConfig = loadConfigurationFromFile(filePath, &loadSuccess);

        if (loadSuccess) {
            // Validate that the loaded config has at least one strip
            if (loadedConfig.strips.empty()) {
                Serial.println(F("[ConfigManager] Loaded config has no strips defined. Using fallback."));
                return false;
            }
            
            // Validate strip configurations
            bool hasValidStrip = false;
            for (const auto& strip : loadedConfig.strips) {
                if (strip.numLeds > 0 && strip.pin < 40) { // Basic validation
                    hasValidStrip = true;
                    break;
                }
            }
            
            if (!hasValidStrip) {
                Serial.println(F("[ConfigManager] No valid strips in loaded config. Using fallback."));
                return false;
            }
            
            Serial.printf("[ConfigManager] Applying config: %d strips, brightness %d\n", 
                         loadedConfig.strips.size(), loadedConfig.globalBrightness);
            return applyConfiguration(loadedConfig);
        }
        Serial.println(F("[ConfigManager] Failed to load configuration file. Using fallback."));
        return false;
    }
    
    FullLedConfiguration getCurrentConfigurationFromManager() const {
        FullLedConfiguration currentConfig;
        currentConfig.globalBrightness = _ledManager.getGlobalBrightness();
        currentConfig.fileVersion = CONFIG_FILE_VERSION; 

        for (size_t i = 0; i < _ledManager.getNumStrips(); ++i) {
            const LedBus* bus = _ledManager.getStrip(i);
            if (bus) {
                currentConfig.strips.push_back(bus->getConfig());
            }
        }
        return currentConfig;
    }

    bool ensureValidConfigFile(const LedStripConfig& defaultStrip, const char* filePath = DEFAULT_CONFIG_FILENAME) {
        // Check if file exists and has reasonable size
        if (LittleFS.exists(filePath)) {
            File configFile = LittleFS.open(filePath, FILE_READ);
            if (configFile) {
                size_t fileSize = configFile.size();
                configFile.close();
                
                if (fileSize > 0 && fileSize <= 4096) {
                    // File exists and has reasonable size, assume it's valid for now
                    // The actual validation will happen during loadAndApplyConfiguration()
                    Serial.println(F("[ConfigManager] Config file found."));
                    return true;
                } else if (fileSize == 0) {
                    Serial.println(F("[ConfigManager] Config file exists but is empty, writing defaults."));
                } else {
                    Serial.println(F("[ConfigManager] Config file too large, overwriting with defaults."));
                }
            }
        } else {
            Serial.print(F("[ConfigManager] No config file found. Creating default at: "));
            Serial.println(filePath);
        }

        // Create or overwrite with default config
        return createDefaultConfigContent(defaultStrip, filePath);
    }

    bool createDefaultConfigFileIfMissing(const LedStripConfig& defaultStrip, const char* filePath = DEFAULT_CONFIG_FILENAME) {
        if (LittleFS.exists(filePath)) {
            // Check if file is empty
            File configFile = LittleFS.open(filePath, FILE_READ);
            if (configFile) {
                size_t fileSize = configFile.size();
                configFile.close();
                if (fileSize > 0) {
                    Serial.println(F("[ConfigManager] Config file exists and is not empty."));
                    return true;
                }
                Serial.println(F("[ConfigManager] Config file exists but is empty, writing defaults."));
            }
        } else {
            Serial.print(F("[ConfigManager] No config file found. Creating default at: "));
            Serial.println(filePath);
        }

        return createDefaultConfigContent(defaultStrip, filePath);
    }

    // Arbitrary pixel layout per strip (WLED ledmap), stored as /layout_<i>.bin:
    //   [u16 W][u16 H][u16 count][ count × i16 ledIndex ]   (little-endian; count == W*H;
    //   ledIndex = physical LED for that grid cell, or -1 for a gap). Absent file => grid.
    void loadStripLayouts() {
        for (size_t i = 0; i < _ledManager.getNumStrips(); i++) {
            char path[24];
            snprintf(path, sizeof(path), "/layout_%u.bin", (unsigned)i);
            if (!LittleFS.exists(path)) { LedBus* st = _ledManager.getStrip(i); if (st) st->clearLayout(); continue; }
            File f = LittleFS.open(path, FILE_READ);
            if (!f) continue;
            size_t sz = f.size();
            uint8_t hdr[6];
            if (sz < 6 || f.readBytes((char*)hdr, 6) != 6) { f.close(); continue; }
            uint16_t W = (uint16_t)(hdr[0] | (hdr[1] << 8));
            uint16_t H = (uint16_t)(hdr[2] | (hdr[3] << 8));
            uint16_t count = (uint16_t)(hdr[4] | (hdr[5] << 8));
            if (W == 0 || H == 0 || count == 0 || sz < (size_t)(6 + (size_t)count * 2)) { f.close(); continue; }
            std::vector<int16_t> map(count);
            for (uint16_t k = 0; k < count; k++) {
                uint8_t b[2];
                if (f.readBytes((char*)b, 2) != 2) { count = k; break; }
                map[k] = (int16_t)(b[0] | (b[1] << 8));
            }
            f.close();
            LedBus* strip = _ledManager.getStrip(i);
            if (strip && count > 0) {
                strip->setLayout(map.data(), count, W, H);
                Serial.printf("[ConfigManager] Strip %u layout: %ux%u grid (%u cells)\n",
                              (unsigned)i, W, H, (unsigned)count);
            }
        }
    }

private:
    LedManager& _ledManager; // Reference to the main LedManager

    bool createDefaultConfigContent(const LedStripConfig& defaultStrip, const char* filePath) {
        FullLedConfiguration defaultConfigStruct;
        defaultConfigStruct.globalBrightness = 20; // Default brightness
        if (defaultStrip.numLeds > 0) { // Only add if it's a valid strip
            defaultConfigStruct.strips.push_back(defaultStrip);
        }
        defaultConfigStruct.fileVersion = CONFIG_FILE_VERSION;

        mpack_writer_t writer;
        char* mpack_buffer = nullptr;
        size_t mpack_size = 0;
        mpack_writer_init_growable(&writer, &mpack_buffer, &mpack_size);

        mpack_start_map(&writer, 3); // version, globalBrightness, strips
        mpack_write_cstr(&writer, ConfigKeys::VERSION);
        mpack_write_u8(&writer, defaultConfigStruct.fileVersion);
        mpack_write_cstr(&writer, ConfigKeys::GLOBAL_BRIGHTNESS);
        mpack_write_u8(&writer, defaultConfigStruct.globalBrightness);
        mpack_write_cstr(&writer, ConfigKeys::STRIPS);
        mpack_start_array(&writer, defaultConfigStruct.strips.size());
        for (const auto& stripCfg : defaultConfigStruct.strips) {
            mpack_start_map(&writer, 10); // + gamma + white point
            mpack_write_cstr(&writer, ConfigKeys::CHIPSET);     mpack_write_u8(&writer, static_cast<uint8_t>(stripCfg.chipset));
            mpack_write_cstr(&writer, ConfigKeys::PIN);         mpack_write_u8(&writer, stripCfg.pin);
            mpack_write_cstr(&writer, ConfigKeys::NUM_LEDS);    mpack_write_u16(&writer, stripCfg.numLeds);
            mpack_write_cstr(&writer, ConfigKeys::COLOR_ORDER); mpack_write_u8(&writer, static_cast<uint8_t>(stripCfg.colorOrder));
            mpack_write_cstr(&writer, ConfigKeys::RMT_CHANNEL); mpack_write_u8(&writer, stripCfg.rmtChannel);
            mpack_write_cstr(&writer, ConfigKeys::WIDTH);       mpack_write_u16(&writer, stripCfg.width);
            mpack_write_cstr(&writer, ConfigKeys::HEIGHT);     mpack_write_u16(&writer, stripCfg.height);
            mpack_write_cstr(&writer, ConfigKeys::ORIENTATION); mpack_write_u8(&writer, stripCfg.orientation);
            mpack_write_cstr(&writer, ConfigKeys::GAMMA);       mpack_write_u16(&writer, (uint16_t)(stripCfg.gamma * 100.0f + 0.5f));
            mpack_write_cstr(&writer, ConfigKeys::WHITE_POINT); mpack_write_u32(&writer, ((uint32_t)stripCfg.wpR << 16) | ((uint32_t)stripCfg.wpG << 8) | (uint32_t)stripCfg.wpB);
            mpack_finish_map(&writer);
        }
        mpack_finish_array(&writer);
        mpack_finish_map(&writer);

        if (mpack_writer_destroy(&writer) != mpack_ok) {
            Serial.print(F("[ConfigManager] Mpack encoding error for default config: "));
            Serial.println(mpack_error_to_string(mpack_writer_error(&writer)));
            if (mpack_buffer) free(mpack_buffer);
            return false;
        }

        File configFile = LittleFS.open(filePath, FILE_WRITE);
        if (!configFile) {
            Serial.println(F("[ConfigManager] Failed to create default config file for writing."));
            if (mpack_buffer) free(mpack_buffer);
            return false;
        }
        size_t bytesWritten = configFile.write(reinterpret_cast<const uint8_t*>(mpack_buffer), mpack_size);
        configFile.close();
        if (mpack_buffer) free(mpack_buffer);

        if (bytesWritten != mpack_size) {
            Serial.println(F("[ConfigManager] Error writing default config to file."));
            LittleFS.remove(filePath);
            return false;
        }
        Serial.println(F("[ConfigManager] Default config file created successfully."));
        return true;
    }
};

} // namespace LedConfig
