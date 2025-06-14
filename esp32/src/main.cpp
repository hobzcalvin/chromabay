#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math (fill_rainbow)
#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
#include "esp_ota_ops.h" // For OTA updates
#include "esp_app_format.h" // For esp_app_desc_t and image state checks

#include "led_manager.h" // Include the new LED Manager
#include "config_manager.h"   // Restore MessagePack config handling
#include "firmware_version.h" // Include firmware version header

// LED Configuration (some of these are now defaults for LedManager config)
#define LED_PIN     13
#define NUM_LEDS    131 // This defines the size of the `leds` CRGB buffer
#define BRIGHTNESS  20      // Applied to LedManager

// LED Array (still used by FastLED's fill_rainbow and as a buffer)
CRGB leds[NUM_LEDS];

// LedManager instance
LedConfig::LedManager ledMgr;
// ConfigManager instance (depends on ledMgr)
LedConfig::ConfigManager configMgr(ledMgr);

// NimBLE LED Service (Blumon custom LED service UUID - restored)
#define SERVICE_UUID           "a0be83e4-8dc9-47f0-ab40-b19721d20ed1"
// Original RX/TX Characteristics
#define CHARACTERISTIC_UUID_RX "a0be83e5-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_TX "a0be83e6-8dc9-47f0-ab40-b19721d20ed1"

// New OTA Characteristics
#define CHARACTERISTIC_UUID_DEVICE_INFO "a0be83e7-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_OTA_CONTROL "a0be83e8-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_OTA_DATA    "a0be83e9-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_OTA_STATUS  "a0be83ea-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_OTA_SIGNATURE "a0be83eb-8dc9-47f0-ab40-b19721d20ed1"


// OTA Constants
#define MAX_BLE_CHUNK_SIZE 500 

NimBLEServer* pServer = nullptr;
// Original RX/TX Characteristics
NimBLECharacteristic* pTxCharacteristic = nullptr;
// OTA Characteristics
NimBLECharacteristic* pDeviceInfoCharacteristic = nullptr;
NimBLECharacteristic* pOTAControlCharacteristic = nullptr;
NimBLECharacteristic* pOTADataCharacteristic = nullptr;
NimBLECharacteristic* pOTAStatusCharacteristic = nullptr;
NimBLECharacteristic* pOTASignatureCharacteristic = nullptr;


bool deviceConnected = false;
bool oldDeviceConnected = false;
String receivedData = "";

// Rainbow variables
uint8_t hue = 0;
unsigned long lastUpdate = 0;
const unsigned long updateInterval = 20; // Update every 20ms for smooth animation

// OTA State Variables
esp_ota_handle_t ota_handle = 0;
const esp_partition_t *update_partition = nullptr;
bool ota_in_progress = false;
int ota_received_size = 0;
uint8_t received_signature[FIRMWARE_SIGNATURE_LENGTH];
bool signature_received = false;


// NimBLE Server Callbacks
class ServerCallbacks: public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) {
        deviceConnected = true;
        Serial.println("BLE Client Connected");
    };

    void onDisconnect(NimBLEServer* pServer) {
        deviceConnected = false;
        Serial.println("BLE Client Disconnected");
        if (ota_in_progress) {
            Serial.println("Client disconnected during OTA. Aborting OTA.");
            if (ota_handle != 0) { 
                 esp_ota_abort(ota_handle); 
            }
            ota_in_progress = false;
            ota_handle = 0;
            signature_received = false;
            if (pOTAStatusCharacteristic) {
                pOTAStatusCharacteristic->setValue("OTA_ERR_DISCONNECTED");
                pOTAStatusCharacteristic->notify();
            }
        }
    }
};

// NimBLE Characteristic Callbacks (for original RX characteristic)
class CharacteristicCallbacks: public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string rxValue = pCharacteristic->getValue();
        
        if (rxValue.length() > 0) {
            receivedData = "";
            for (int i = 0; i < rxValue.length(); i++) {
                receivedData += rxValue[i];
            }
            Serial.println("BLE Received (RX): " + receivedData);
            
            if (receivedData == "status") {
                String response = "LEDs: " + String(ledMgr.getNumStrips() > 0 ? ledMgr.getStrip(0)->getLength() : 0) + 
                                ", Brightness: " + String(ledMgr.getGlobalBrightness()) + 
                                ", Free Heap: " + String(ESP.getFreeHeap());
                if (pTxCharacteristic) {
                    pTxCharacteristic->setValue(response.c_str());
                    pTxCharacteristic->notify();
                }
            } else if (receivedData == "info") {
                String response = "Blumon ESP32 - LedManager Rainbow Demo (NimBLE)";
                 if (pTxCharacteristic) {
                    pTxCharacteristic->setValue(response.c_str());
                    pTxCharacteristic->notify();
                }
            }
        }
    }
};

// Callback for Device Info Characteristic (Read-Only)
class DeviceInfoCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic) {
        Serial.println("Device Info Characteristic Read Request");
        String deviceInfoJson = "{";
        deviceInfoJson += "\"fw_ver\":\"" + String(FIRMWARE_VERSION) + "\",";
        deviceInfoJson += "\"hw_ver\":\"" + String(HARDWARE_VERSION) + "\",";
        deviceInfoJson += "\"heap\":" + String(ESP.getFreeHeap());
        deviceInfoJson += "}";
        
        pCharacteristic->setValue(deviceInfoJson.c_str());
        Serial.println("Sent Device Info: " + deviceInfoJson);
    }
};

// Callback for OTA Signature Characteristic (Write)
class OTASignatureCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        Serial.print("OTA Signature Received: ");
        if (value.length() == FIRMWARE_SIGNATURE_LENGTH) {
            memcpy(received_signature, value.data(), FIRMWARE_SIGNATURE_LENGTH);
            signature_received = true;
            Serial.printf("%d bytes stored.\n", value.length());
            if (pOTAStatusCharacteristic) {
                pOTAStatusCharacteristic->setValue("OTA_SIG_RECEIVED");
                pOTAStatusCharacteristic->notify();
            }
        } else {
            Serial.printf("Invalid length %d bytes. Expected %d.\n", value.length(), FIRMWARE_SIGNATURE_LENGTH);
            signature_received = false; // Mark as not (properly) received
            if (pOTAStatusCharacteristic) {
                pOTAStatusCharacteristic->setValue("OTA_ERR_SIG_LEN");
                pOTAStatusCharacteristic->notify();
            }
        }
    }
};


// Callback for OTA Control Characteristic (Write)
class OTAControlCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        Serial.print("OTA Control Received: ");
        if (value.length() > 0) {
            Serial.println(value.c_str());
            
            if (value == "END_OTA") {
                if (!ota_in_progress || ota_handle == 0) {
                    Serial.println("OTA Error: END_OTA received but no OTA process was active or handle invalid.");
                    if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_ERR_NO_ACTIVE_OTA");
                        pOTAStatusCharacteristic->notify();
                    }
                    signature_received = false; // Reset for next attempt
                    return;
                }

                if (!signature_received) {
                    Serial.println("OTA Error: END_OTA received but no signature was provided.");
                    if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_ERR_NO_SIGNATURE");
                        pOTAStatusCharacteristic->notify();
                    }
                    // Optionally abort here, or let it fail at esp_ota_end if it checks.
                    // For safety, let's abort if signature is mandatory.
                    esp_ota_abort(ota_handle);
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    return;
                }

                // --- Placeholder for Signature Verification ---
                Serial.println("OTA: Verifying firmware signature (Placeholder - Assuming VALID for now)...");
                bool signature_is_valid = true; // Replace with actual verification
                // Example:
                // esp_err_t sig_verify_err = esp_ota_verify_secure_boot_signature(&ota_handle); // This is for secure boot, not general app sig
                // For custom signature:
                // 1. Calculate hash of the received firmware in the ota_partition.
                //    You might need to read it back or hash it as it comes.
                // 2. Use mbedtls (available in ESP-IDF) to verify the hash against `received_signature`
                //    using `FIRMWARE_SIGNATURE_PUBLIC_KEY`.
                //
                // const esp_partition_t* ota_partition_for_verification = esp_ota_get_next_update_partition(NULL);
                // if (ota_partition_for_verification != NULL) {
                //    // Logic to read from partition and verify
                // } else { signature_is_valid = false; }

                if (!signature_is_valid) {
                    Serial.println("OTA Error: Firmware signature verification FAILED!");
                    if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_ERR_SIG_INVALID");
                        pOTAStatusCharacteristic->notify();
                    }
                    esp_ota_abort(ota_handle);
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    return;
                }
                Serial.println("OTA: Firmware signature (assumed) VALID.");
                // --- End Signature Verification Placeholder ---


                Serial.println("OTA End command received. Finalizing update...");
                esp_err_t err = esp_ota_end(ota_handle);
                if (err == ESP_OK) {
                    Serial.println("OTA: esp_ota_end succeeded.");
                    if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_VALIDATING");
                        pOTAStatusCharacteristic->notify();
                        delay(10); 
                    }
                    
                    err = esp_ota_set_boot_partition(update_partition);
                    if (err == ESP_OK) {
                        Serial.println("OTA: esp_ota_set_boot_partition succeeded. Rebooting...");
                        if (pOTAStatusCharacteristic) {
                            pOTAStatusCharacteristic->setValue("OTA_SUCCESS_REBOOTING");
                            pOTAStatusCharacteristic->notify();
                            delay(100); 
                        }
                        esp_restart();
                    } else {
                        Serial.printf("OTA Error: esp_ota_set_boot_partition failed! (%s)\n", esp_err_to_name(err));
                        if (pOTAStatusCharacteristic) {
                            String errorMsg = "OTA_ERR_SET_BOOT:" + String(esp_err_to_name(err));
                            pOTAStatusCharacteristic->setValue(errorMsg.c_str());
                            pOTAStatusCharacteristic->notify();
                        }
                    }
                } else {
                    Serial.printf("OTA Error: esp_ota_end failed! (%s)\n", esp_err_to_name(err));
                    if (pOTAStatusCharacteristic) {
                        String errorMsg = "OTA_ERR_END_FAILED:" + String(esp_err_to_name(err));
                        pOTAStatusCharacteristic->setValue(errorMsg.c_str());
                        pOTAStatusCharacteristic->notify();
                    }
                }
                ota_in_progress = false;
                ota_handle = 0; 
                ota_received_size = 0;
                signature_received = false;

            } else if (value == "ABORT_OTA") {
                if (ota_in_progress) {
                    Serial.println("OTA Abort command received. Cleaning up.");
                    if (ota_handle != 0) {
                        esp_ota_abort(ota_handle); 
                    }
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_ABORTED_CMD");
                        pOTAStatusCharacteristic->notify();
                    }
                } else {
                    Serial.println("Abort command received, but no OTA in progress.");
                     if (pOTAStatusCharacteristic) {
                        pOTAStatusCharacteristic->setValue("OTA_WARN_NO_OTA_TO_ABORT");
                        pOTAStatusCharacteristic->notify();
                    }
                }
            } else if (value.rfind("TOTAL_SIZE:", 0) == 0) { 
                // Optional: Client can send total firmware size
            }
        } else {
            Serial.println("(empty)");
        }
    }
};

// Callback for OTA Data Characteristic (Write Without Response, with Notify for ACK)
class OTADataCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        size_t length = value.length();

        if (length == 0) {
            return;
        }

        if (!ota_in_progress) {
            Serial.println("First OTA data packet received. Starting OTA process...");
            signature_received = false; // Reset signature status for new OTA
            ota_received_size = 0;      // Reset received size

            update_partition = esp_ota_get_next_update_partition(NULL);
            if (update_partition == NULL) {
                Serial.println("OTA Error: No valid update partition found!");
                if (pOTAStatusCharacteristic) {
                    pOTAStatusCharacteristic->setValue("OTA_ERR_NO_PARTITION");
                    pOTAStatusCharacteristic->notify();
                }
                return;
            }
            Serial.printf("OTA: Writing to partition subtype %d at offset 0x%x\n",
                          update_partition->subtype, update_partition->address);

            esp_err_t err = esp_ota_begin(update_partition, OTA_SIZE_UNKNOWN, &ota_handle);
            if (err != ESP_OK) {
                Serial.printf("OTA Error: esp_ota_begin failed (%s)\n", esp_err_to_name(err));
                if (pOTAStatusCharacteristic) {
                    String errorMsg = "OTA_ERR_BEGIN_FAILED:" + String(esp_err_to_name(err));
                    pOTAStatusCharacteristic->setValue(errorMsg.c_str());
                    pOTAStatusCharacteristic->notify();
                }
                ota_handle = 0; 
                return;
            }
            ota_in_progress = true;
            Serial.println("OTA: esp_ota_begin succeeded. Ready for firmware data.");
            if (pOTAStatusCharacteristic) {
                pOTAStatusCharacteristic->setValue("OTA_STARTED_READY");
                pOTAStatusCharacteristic->notify();
            }
        }

        esp_err_t err = esp_ota_write(ota_handle, value.data(), length);
        if (err != ESP_OK) {
            Serial.printf("OTA Error: esp_ota_write failed (%s)\n", esp_err_to_name(err));
            if (pOTAStatusCharacteristic) {
                String errorMsg = "OTA_ERR_WRITE:" + String(esp_err_to_name(err));
                pOTAStatusCharacteristic->setValue(errorMsg.c_str());
                pOTAStatusCharacteristic->notify();
            }
            esp_ota_abort(ota_handle); 
            ota_in_progress = false;
            ota_handle = 0;
            signature_received = false;
            return;
        }

        ota_received_size += length;

        uint8_t ack_payload[1] = { (uint8_t)(ota_received_size % 256) }; 
        pCharacteristic->setValue(ack_payload, 1);
        pCharacteristic->notify();
    }
};


void pushCRGBToStrip() {
    if (ledMgr.getNumStrips() > 0) { 
        LedConfig::LedBus* strip0 = ledMgr.getStrip(0);
        if (strip0) {
            uint16_t count = min((uint16_t)strip0->getLength(), (uint16_t)NUM_LEDS);
            for (int i = 0; i < count; i++) {
                strip0->setPixelColor(i, leds[i]);
            }
        }
    }
}

void setup() {
    Serial.begin(115200);
    delay(1000); 
    Serial.println("ESP32 LedManager + OTA Demo Starting...");

    // --- Boot-time firmware state check ---
    const esp_app_desc_t *app_desc = esp_ota_get_app_description();
    Serial.printf("Current firmware version: %s\n", app_desc->version);
    Serial.println("Hardware Version: " + String(HARDWARE_VERSION)); // From firmware_version.h

    const esp_partition_t *running_partition = esp_ota_get_running_partition();
    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            Serial.println("Boot: Firmware is PENDING VERIFICATION.");
            // If we reach here, it means the app has started successfully.
            // The health check at the end of setup() will mark it valid.
        } else if (ota_state == ESP_OTA_IMG_VALID) {
            Serial.println("Boot: Firmware is VALID.");
        } else if (ota_state == ESP_OTA_IMG_INVALID) {
            Serial.println("Boot: Firmware is INVALID. This should ideally not happen if rollback is configured.");
        } else {
            Serial.printf("Boot: Firmware OTA state is UNDEFINED (%d).\n", ota_state);
        }
    } else {
        Serial.println("Boot: Could not get OTA state for the running partition.");
    }
    // --- End boot-time check ---


    Serial.println("Mounting LittleFS (once)...");
    if (!LittleFS.begin(true)) { 
        Serial.println("LittleFS Mount Failed - continuing WITHOUT filesystem for config.");
    } else {
        Serial.println("LittleFS Mounted Successfully");
        size_t totalBytes = LittleFS.totalBytes();
        size_t usedBytes = LittleFS.usedBytes();
        Serial.printf("LittleFS Total: %d bytes, Used: %d bytes\n", totalBytes, usedBytes);
    }

    LedConfig::LedStripConfig defaultStrip;
    defaultStrip.chipset     = LedConfig::LedChipset::WS2812_RGB;
    defaultStrip.pin         = LED_PIN;
    defaultStrip.numLeds     = NUM_LEDS;
    defaultStrip.colorOrder  = LedConfig::ColorOrderValue::CO_GRB;
    defaultStrip.rmtChannel  = 0;
    
    configMgr.createDefaultConfigFileIfMissing(defaultStrip);
    Serial.println("Default config check complete (file created if missing).");

    bool configLoadedAndApplied = configMgr.loadAndApplyConfiguration();
    Serial.printf("loadAndApplyConfiguration() returned: %s\n",
                  configLoadedAndApplied ? "true" : "false");

    if (!configLoadedAndApplied || ledMgr.getNumStrips() == 0) {
        if (!configLoadedAndApplied) {
            Serial.println("Config load/apply reported failure.");
        } else { 
            Serial.println("Config applied but resulted in 0 LED strips.");
        }
        Serial.println("Falling back to built-in default LED strip configuration …");
        ledMgr.clearStrips();
        if (ledMgr.addStrip(defaultStrip)) {
            Serial.println("Default strip added; calling ledMgr.begin() …");
            ledMgr.setGlobalBrightness(BRIGHTNESS);
            ledMgr.begin();
            Serial.println("ledMgr.begin() finished for fallback strip.");
        } else {
            Serial.println("CRITICAL: Failed to add fallback LED strip!");
        }
    } else {
        Serial.println("Configuration successfully loaded and applied from file.");
        Serial.println("Calling ledMgr.begin() for loaded configuration …");
        ledMgr.begin();
        Serial.println("ledMgr.begin() finished for loaded configuration.");
    }

    Serial.printf("LedManager initialized. Number of configured strips: %d\n", ledMgr.getNumStrips());
    if (ledMgr.getNumStrips() > 0) {
        LedConfig::LedBus* strip0 = ledMgr.getStrip(0);
        if (strip0) {
            const LedConfig::LedStripConfig& cfg = strip0->getConfig();
            Serial.printf("Strip 0 Details: Pin %d, LEDs %d, Chipset %d, ColorOrder %d, RMT %d, Brightness %d\n",
                          cfg.pin,
                          cfg.numLeds,
                          static_cast<int>(cfg.chipset),
                          static_cast<int>(cfg.colorOrder),
                          cfg.rmtChannel,
                          strip0->getBrightness()); 
             if (cfg.numLeds != NUM_LEDS) {
                Serial.printf("WARNING: Strip 0 configured with %d LEDs, but main code expects NUM_LEDS = %d for CRGB buffer.\n", cfg.numLeds, NUM_LEDS);
            }
        }
    } else {
        Serial.println("WARNING: No LED strips are configured in LedManager after setup!");
    }
    
    Serial.println("Testing LEDs with red pattern (LedManager)...");
    if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Red); 
        }
        ledMgr.show();
    } else {
        Serial.println("Skipping red pattern test: No strips configured.");
    }
    delay(1000);
    
    Serial.println("Clearing LEDs (LedManager)...");
    if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Black); 
        }
        ledMgr.show();
    } else {
        Serial.println("Skipping clear LEDs test: No strips configured.");
    }
    
    Serial.println("Initializing NimBLE...");
    NimBLEDevice::init("Blumon_ESP32"); 
    
    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());
    
    NimBLEService *pService = pServer->createService(SERVICE_UUID); 
    
    // Original TX Characteristic (for sending data to client)
    pTxCharacteristic = pService->createCharacteristic(
                        CHARACTERISTIC_UUID_TX, 
                        NIMBLE_PROPERTY::NOTIFY
                      );
    
    // Original RX Characteristic (for receiving data from client)
    NimBLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
                                               CHARACTERISTIC_UUID_RX, 
                                               NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
                                             );
    pRxCharacteristic->setCallbacks(new CharacteristicCallbacks());

    // --- New OTA Characteristics ---
    pDeviceInfoCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_DEVICE_INFO,
                                NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
                              );
    pDeviceInfoCharacteristic->setCallbacks(new DeviceInfoCallbacks()); 

    pOTAControlCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_CONTROL,
                                NIMBLE_PROPERTY::WRITE 
                              );
    pOTAControlCharacteristic->setCallbacks(new OTAControlCallbacks());

    pOTADataCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_DATA,
                                NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY 
                             );
    pOTADataCharacteristic->setCallbacks(new OTADataCallbacks());

    pOTAStatusCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_STATUS,
                                NIMBLE_PROPERTY::NOTIFY
                               );
    
    pOTASignatureCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_SIGNATURE,
                                NIMBLE_PROPERTY::WRITE // Acknowledge signature receipt
                               );
    pOTASignatureCharacteristic->setCallbacks(new OTASignatureCallbacks());
    // -------------------------------
    
    pService->start();
    
    NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID); 
    pAdvertising->setScanResponse(false);
    pAdvertising->setMinPreferred(0x0);
    NimBLEDevice::startAdvertising();
    
    Serial.println("NimBLE Service (incl. OTA Chars) started - waiting for connections...");
    Serial.println("Device name: Blumon_ESP32");
    Serial.println("Advertising Service UUID: " + String(SERVICE_UUID));
    
    // --- Health Check: Mark app as valid if it was pending verification ---
    if (esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            Serial.println("Setup complete. App is PENDING VERIFICATION. Marking as VALID.");
            esp_err_t mark_valid_err = esp_ota_mark_app_valid_cancel_rollback();
            if (mark_valid_err == ESP_OK) {
                Serial.println("App successfully marked as valid. Rollback cancelled.");
            } else {
                Serial.printf("Error marking app valid: %s. OTA rollback might occur on next boot if watchdog triggers.\n", esp_err_to_name(mark_valid_err));
                // Consider a more drastic error state here if marking valid fails.
            }
        } else {
            Serial.println("Setup complete. App was not pending verification.");
        }
    } else {
         Serial.println("Setup complete. Could not get OTA state for health check mark.");
    }
    // --- End Health Check ---

    Serial.println("Setup complete - Starting rainbow animation");
    Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
}

void loop() {
    unsigned long currentTime = millis();
    
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
        if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0) != nullptr && !ota_in_progress) { // Pause rainbow during OTA
            fill_rainbow(leds, NUM_LEDS, hue, 7); 
            pushCRGBToStrip();
            ledMgr.show();
            hue++;
        }
        
        static unsigned long lastStatus = 0;
        if (currentTime - lastStatus >= 5000) {
            lastStatus = currentTime;
            uint8_t currentBrightness = 0;
            if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0) != nullptr) {
                currentBrightness = ledMgr.getStrip(0)->getBrightness(); 
            }
            Serial.printf("Rainbow running - Hue: %d, Brightness: %d, Free heap: %d bytes, BLE: %s, Strips: %d, OTA: %s\n", 
                         hue, currentBrightness, ESP.getFreeHeap(), deviceConnected ? "Connected" : "Disconnected", ledMgr.getNumStrips(), ota_in_progress ? "In Progress" : "Idle");
        }
    }
    
    if (!deviceConnected && oldDeviceConnected) {
        Serial.println("Client disconnected, advertising should restart automatically if configured.");
        oldDeviceConnected = deviceConnected;
    }
    if (deviceConnected && !oldDeviceConnected) {
        Serial.println("Client reconnected.");
        oldDeviceConnected = deviceConnected;
    }

    delay(1); 
}
