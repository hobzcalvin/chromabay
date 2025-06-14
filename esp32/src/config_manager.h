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
        if (!LittleFS.begin(false)) {
             Serial.println(F("[ConfigManager] Failed to mount LittleFS for saving."));
             return false;
        }

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
                // Each strip is a map: chipset, pin, num_leds, color_order, rmt_channel (5 key-value pairs)
                mpack_start_map(&writer, 5);
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

        if (!LittleFS.begin(false)) {
             Serial.println(F("[ConfigManager] Failed to mount LittleFS for loading."));
             return loadedConfig;
        }

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
            // Use mpack_expect_str_buf and ensure null termination for safety,
            // though mpack_expect_str_buf should handle it if bufsize is correct.
            mpack_expect_str_buf(&reader, key_buffer, sizeof(key_buffer));
            if (mpack_reader_error(&reader) != mpack_ok) {
                 Serial.println(F("[ConfigManager] Error reading map key string."));
                 mpack_reader_destroy(&reader); delete[] fileBuffer; return loadedConfig;
            }
            // key_buffer is now null-terminated by mpack_expect_str_buf if successful and fits.

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
                        mpack_expect_str_buf(&reader, key_buffer, sizeof(key_buffer));
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

        bool allStripsAdded = true;
        for (const auto& stripConfig : config.strips) {
            if (!_ledManager.addStrip(stripConfig)) {
                Serial.print(F("[ConfigManager] Failed to add strip to LedManager: Pin "));
                Serial.println(stripConfig.pin);
                allStripsAdded = false;
            }
        }

        if (!config.strips.empty() || _ledManager.getNumStrips() > 0) { 
            _ledManager.begin(); 
        }
        
        Serial.println(F("[ConfigManager] Configuration applied to LedManager."));
        return allStripsAdded;
    }

    bool loadAndApplyConfiguration(const char* filePath = DEFAULT_CONFIG_FILENAME) {
        bool loadSuccess = false;
        FullLedConfiguration loadedConfig = loadConfigurationFromFile(filePath, &loadSuccess);

        if (loadSuccess) {
            return applyConfiguration(loadedConfig);
        }
        Serial.println(F("[ConfigManager] Failed to load configuration file. Applying default or keeping existing."));
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

    bool createDefaultConfigFileIfMissing(const LedStripConfig& defaultStrip, const char* filePath = DEFAULT_CONFIG_FILENAME) {
        if (!LittleFS.begin(false)) {
             Serial.println(F("[ConfigManager] Failed to mount LittleFS for default config check."));
             return false;
        }
        if (LittleFS.exists(filePath)) {
            Serial.println(F("[ConfigManager] Config file exists, not creating default."));
            return true; 
        }

        Serial.print(F("[ConfigManager] No config file found. Creating default at: "));
        Serial.println(filePath);

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
            mpack_start_map(&writer, 5); // chipset, pin, num_leds, color_order, rmt_channel
            mpack_write_cstr(&writer, ConfigKeys::CHIPSET);     mpack_write_u8(&writer, static_cast<uint8_t>(stripCfg.chipset));
            mpack_write_cstr(&writer, ConfigKeys::PIN);         mpack_write_u8(&writer, stripCfg.pin);
            mpack_write_cstr(&writer, ConfigKeys::NUM_LEDS);    mpack_write_u16(&writer, stripCfg.numLeds);
            mpack_write_cstr(&writer, ConfigKeys::COLOR_ORDER); mpack_write_u8(&writer, static_cast<uint8_t>(stripCfg.colorOrder));
            mpack_write_cstr(&writer, ConfigKeys::RMT_CHANNEL); mpack_write_u8(&writer, stripCfg.rmtChannel);
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

private:
    LedManager& _ledManager; // Reference to the main LedManager
};

} // namespace LedConfig
