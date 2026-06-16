#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math
#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
#include "esp_ota_ops.h" // For OTA updates

// PSA Crypto API includes for signature verification
#include "psa/crypto.h"

#include "led_manager.h" // Include the new LED Manager
#include "config_manager.h"   // Restore MessagePack config handling
#include "firmware_version.h" // Include firmware version header
#include "pattern_renderer_base.h" // Include pattern renderer

// LED Configuration (some of these are now defaults for LedManager config)
#define LED_PIN     13
#define NUM_LEDS    64  // 5x5 LED matrix (DISPLAY_WIDTH * DISPLAY_HEIGHT)
#define BRIGHTNESS  20      // Applied to LedManager

// Note: CRGB type still needed for pattern renderer, but no global array needed

// LedManager instance
LedConfig::LedManager ledMgr;
// ConfigManager instance (depends on ledMgr)
LedConfig::ConfigManager configMgr(ledMgr);
// Pattern renderer instance
PatternRendererBase* patternRenderer = nullptr;

// NimBLE LED Service (ChromaBay custom LED service UUID - restored)
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

// Pattern Sync Characteristic - for receiving messagepack-encoded patterns
#define CHARACTERISTIC_UUID_PATTERN_SYNC "a0be83ec-8dc9-47f0-ab40-b19721d20ed1"

// LED Configuration Characteristics - for getting/setting strip configuration
#define CHARACTERISTIC_UUID_LED_CONFIG_GET "a0be83ed-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_LED_CONFIG_SET "a0be83ee-8dc9-47f0-ab40-b19721d20ed1"

// Timestamp Sync Characteristic - for synchronizing time across devices
#define CHARACTERISTIC_UUID_TIMESTAMP_SYNC "a0be83ef-8dc9-47f0-ab40-b19721d20ed1"

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

// Pattern Sync Characteristic
NimBLECharacteristic* pPatternSyncCharacteristic = nullptr;

// LED Configuration Characteristics
NimBLECharacteristic* pLedConfigGetCharacteristic = nullptr;
NimBLECharacteristic* pLedConfigSetCharacteristic = nullptr;

// Timestamp Sync Characteristic
NimBLECharacteristic* pTimestampSyncCharacteristic = nullptr;

// Pattern Storage
static uint8_t* patternBuffer = nullptr;
static size_t patternBufferSize = 0;
static bool newPatternAvailable = false;

// LED Config Storage
// Like patterns, incoming LED configuration is staged here by the BLE write
// callback and applied later from loop() (see processReceivedLedConfig). The
// BLE callback runs on the NimBLE host task while the render loop runs on the
// Arduino task; applying the config (which frees/reallocates the renderer's
// pixel buffers and destroys/recreates LED strips) directly from the callback
// races with update()/render() and corrupts the output buffers.
static uint8_t* ledConfigBuffer = nullptr;
static size_t ledConfigBufferSize = 0;
static volatile bool newLedConfigAvailable = false;

bool deviceConnected = false;
bool oldDeviceConnected = false;
String receivedData = "";

// Pattern rendering variables
unsigned long lastUpdate = 0;
const unsigned long updateInterval = 20; // Update every 20ms for smooth animation

// OTA State Variables
esp_ota_handle_t ota_handle = 0;
const esp_partition_t *update_partition = nullptr;
bool ota_in_progress = false;
int ota_received_size = 0;
uint8_t received_signature[FIRMWARE_SIGNATURE_LENGTH];
bool signature_received = false;

// Signature verification task variables.
// volatile: written by the verification task, read by loop() on the Arduino task.
TaskHandle_t signature_task_handle = nullptr;
volatile bool signature_verification_complete = false;
volatile bool signature_verification_result = false;

// OTA finalize is deferred from the BLE callback to loop() so it doesn't block
// the BLE host task. While true, loop() watches signature_verification_complete
// and finalizes (or times out) the update. See finalizeOtaIfReady().
volatile bool ota_finalizing = false;
unsigned long ota_finalize_start_ms = 0;

// Structure to pass data to signature verification task
struct SignatureVerificationData {
    uint8_t signature[FIRMWARE_SIGNATURE_LENGTH];
    const esp_partition_t* partition;
    size_t firmware_size;
};

// Timestamp synchronization variables
unsigned long syncedTimestampMs = 0;    // The synchronized timestamp from mobile app
unsigned long syncedLocalTime = 0;      // Local millis() when the sync was received
bool timestampSynced = false;           // Whether we have received a sync

// Function to get the current synchronized timestamp
unsigned long getSynchronizedTime() {
    if (timestampSynced) {
        // Calculate elapsed time since sync point using local millis()
        unsigned long currentLocalTime = millis();
        unsigned long elapsedTime = currentLocalTime - syncedLocalTime;
        return syncedTimestampMs + elapsedTime;
    } else {
        // Fall back to local time if no sync received
        return millis();
    }
}

// Function to verify firmware signature using PSA Crypto API
bool verifyFirmwareSignature(const uint8_t* signature, size_t sigLen, const esp_partition_t* partition, size_t firmware_size) {
    if (sigLen != FIRMWARE_SIGNATURE_LENGTH) {
        Serial.printf("Invalid signature length: %d, expected %d\n", sigLen, FIRMWARE_SIGNATURE_LENGTH);
        return false;
    }

    psa_status_t status;
    psa_key_id_t key_id;
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    uint8_t firmware_hash[PSA_HASH_LENGTH(PSA_ALG_SHA_256)];

    // Initialize PSA Crypto
    status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        Serial.printf("Failed to initialize PSA Crypto: %ld\n", status);
        return false;
    }

    // Prepare public key in uncompressed format for PSA (0x04 + X + Y)
    uint8_t uncompressed_key[65];
    uncompressed_key[0] = 0x04; // Uncompressed point indicator
    memcpy(&uncompressed_key[1], FIRMWARE_PUBLIC_KEY, 64); // Copy X + Y coordinates

    // Set key attributes for ECDSA P-256 public key
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_VERIFY_HASH);
    psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
    psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&attributes, 256);

    // Import the public key
    status = psa_import_key(&attributes, uncompressed_key, sizeof(uncompressed_key), &key_id);
    if (status != PSA_SUCCESS) {
        Serial.printf("Failed to import public key: %ld\n", status);
        psa_reset_key_attributes(&attributes);
        return false;
    }

    // Hash the firmware data using PSA
    psa_hash_operation_t hash_op = PSA_HASH_OPERATION_INIT;
    status = psa_hash_setup(&hash_op, PSA_ALG_SHA_256);
    if (status != PSA_SUCCESS) {
        Serial.printf("Failed to setup hash operation: %ld\n", status);
        psa_destroy_key(key_id);
        psa_reset_key_attributes(&attributes);
        return false;
    }

    // Read firmware from partition in chunks and hash it
    const size_t CHUNK_SIZE = 4096;
    uint8_t* chunk_buffer = (uint8_t*)malloc(CHUNK_SIZE);
    if (!chunk_buffer) {
        Serial.println("Failed to allocate chunk buffer for hashing");
        psa_hash_abort(&hash_op);
        psa_destroy_key(key_id);
        psa_reset_key_attributes(&attributes);
        return false;
    }

    size_t remaining = firmware_size;
    size_t offset = 0;
    bool hash_success = true;

    while (remaining > 0 && hash_success) {
        size_t to_read = (remaining < CHUNK_SIZE) ? remaining : CHUNK_SIZE;
        
        esp_err_t read_err = esp_partition_read(partition, offset, chunk_buffer, to_read);
        if (read_err != ESP_OK) {
            Serial.printf("Failed to read partition at offset %d: %s\n", offset, esp_err_to_name(read_err));
            hash_success = false;
            break;
        }
        
        status = psa_hash_update(&hash_op, chunk_buffer, to_read);
        if (status != PSA_SUCCESS) {
            Serial.printf("Failed to update hash: %ld\n", status);
            hash_success = false;
            break;
        }
        
        offset += to_read;
        remaining -= to_read;
    }

    free(chunk_buffer);

    if (!hash_success) {
        psa_hash_abort(&hash_op);
        psa_destroy_key(key_id);
        psa_reset_key_attributes(&attributes);
        return false;
    }

    size_t hash_length;
    status = psa_hash_finish(&hash_op, firmware_hash, sizeof(firmware_hash), &hash_length);
    if (status != PSA_SUCCESS) {
        Serial.printf("Failed to finish hash: %ld\n", status);
        psa_destroy_key(key_id);
        psa_reset_key_attributes(&attributes);
        return false;
    }

    // Verify signature (r||s format)
    status = psa_verify_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), 
                            firmware_hash, sizeof(firmware_hash), 
                            signature, sigLen);
    
    bool verification_result = (status == PSA_SUCCESS);
    
    if (verification_result) {
        Serial.println("Firmware signature verification PASSED");
    } else {
        Serial.println("Firmware signature verification FAILED");
    }

    // Cleanup
    psa_destroy_key(key_id);
    psa_reset_key_attributes(&attributes);
    
    return verification_result;
}

// Signature verification task (runs on separate thread with large stack)
void signatureVerificationTask(void* parameter) {
    SignatureVerificationData* data = (SignatureVerificationData*)parameter;
    
    Serial.println("OTA: Starting signature verification on dedicated task...");
    
    // Call the PSA signature verification with large stack
    signature_verification_result = verifyFirmwareSignature(
        data->signature, 
        FIRMWARE_SIGNATURE_LENGTH, 
        data->partition, 
        data->firmware_size
    );
    
    signature_verification_complete = true;
    
    // Clean up and delete this task
    free(data);
    vTaskDelete(nullptr);
}


// Function to update the Device Info characteristic
// This should be called periodically or when relevant info changes (e.g., heap on connect)
void updateDeviceInfoCharacteristic() {
    if (!pDeviceInfoCharacteristic) {
        // This should not happen if BLE setup is correct
        return;
    }

    String deviceInfoJson = "{";
    deviceInfoJson += "\"fw_ver\":\"" + String(FIRMWARE_VERSION) + "\",";
    deviceInfoJson += "\"hw_ver\":\"" + String(HARDWARE_VERSION) + "\",";
    deviceInfoJson += "\"heap\":" + String(ESP.getFreeHeap());
    deviceInfoJson += "}";
    
    // IMPORTANT: Always use setValue with explicit length for strings with NimBLE
    // to avoid issues with strlen or incomplete data transmission.
    // The NimBLE setValue(const char*) overload has proven unreliable.
    pDeviceInfoCharacteristic->setValue((uint8_t*)deviceInfoJson.c_str(), deviceInfoJson.length());
    
    // Optionally notify if the characteristic supports it and clients are subscribed,
    // though for device info, a read-on-demand is usually sufficient.
    // if (deviceConnected) { pDeviceInfoCharacteristic->notify(); }
}

// NimBLE Server Callbacks
class ServerCallbacks: public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) {
        deviceConnected = true;
        Serial.println("BLE Client Connected");
        // Update device info characteristic as heap might have changed or client needs fresh info
        updateDeviceInfoCharacteristic(); 
        // Note: Mobile app will send timestamp sync after connection is established
    };

    void onDisconnect(NimBLEServer* pServer) {
        deviceConnected = false;
        Serial.println("BLE Client Disconnected");
        // If OTA was in progress and client disconnects, abort it to free resources
        if (ota_in_progress) {
            Serial.println("Client disconnected during OTA. Aborting OTA.");
            if (ota_handle != 0) { 
                 esp_ota_abort(ota_handle); 
            }
            ota_in_progress = false;
            ota_handle = 0;
            signature_received = false; // Reset signature status
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_ERR_DISCONNECTED";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
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
            
            // Process general BLE commands
            if (receivedData == "status") {
                String response = "LEDs: " + String(ledMgr.getNumStrips() > 0 ? ledMgr.getStrip(0)->getLength() : 0) + 
                                ", Brightness: " + String(ledMgr.getGlobalBrightness()) + 
                                ", Free Heap: " + String(ESP.getFreeHeap());
                if (pTxCharacteristic) {
                    pTxCharacteristic->setValue((uint8_t*)response.c_str(), response.length());
                    pTxCharacteristic->notify();
                }
            } else if (receivedData == "info") {
                String response = "ChromaBay ESP32 - LedManager Rainbow Demo (NimBLE)";
                 if (pTxCharacteristic) {
                    pTxCharacteristic->setValue((uint8_t*)response.c_str(), response.length());
                    pTxCharacteristic->notify();
                }
            }
        }
    }
};

// Callback for OTA Signature Characteristic (Write)
class OTASignatureCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() == FIRMWARE_SIGNATURE_LENGTH) {
            memcpy(received_signature, value.data(), FIRMWARE_SIGNATURE_LENGTH);
            signature_received = true;
            Serial.printf("OTA signature received (%d bytes)\n", value.length());
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_SIG_RECEIVED";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
        } else {
            Serial.printf("OTA Error: Invalid signature length %d bytes (expected %d)\n", value.length(), FIRMWARE_SIGNATURE_LENGTH);
            signature_received = false; 
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_ERR_SIG_LEN";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
        }
    }
};


// Callback for OTA Control Characteristic (Write)
class OTAControlCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value_str = pCharacteristic->getValue();
        const char* value = value_str.c_str(); 
        if (strlen(value) > 0) {
            Serial.printf("OTA Control: %s\n", value);
            
            if (strcmp(value, "END_OTA") == 0) {
                if (!ota_in_progress || ota_handle == 0) {
                    Serial.println("OTA Error: END_OTA received but no OTA process was active or handle invalid.");
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_NO_ACTIVE_OTA";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                    signature_received = false; 
                    return;
                }

                if (!signature_received) {
                    Serial.println("OTA Error: END_OTA received but no signature was provided.");
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_NO_SIGNATURE";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                    esp_ota_abort(ota_handle);
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    return;
                }

                // Real firmware signature verification - BEFORE esp_ota_end()
                Serial.println("OTA: Verifying firmware signature...");
                
                // Create signature verification data structure
                SignatureVerificationData* verif_data = (SignatureVerificationData*)malloc(sizeof(SignatureVerificationData));
                if (!verif_data) {
                    Serial.println("OTA Error: Failed to allocate memory for signature verification!");
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_MEMORY";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                    esp_ota_abort(ota_handle);
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    return;
                }
                
                // Copy verification data
                memcpy(verif_data->signature, received_signature, FIRMWARE_SIGNATURE_LENGTH);
                verif_data->partition = update_partition;
                verif_data->firmware_size = ota_received_size;
                
                // Reset verification status
                signature_verification_complete = false;
                signature_verification_result = false;
                
                // Create signature verification task with large stack (16KB)
                BaseType_t task_created = xTaskCreate(
                    signatureVerificationTask,
                    "sig_verify",
                    16384,  // 16KB stack size (much larger than BLE callback stack)
                    verif_data,
                    1,      // Priority
                    &signature_task_handle
                );
                
                if (task_created != pdPASS) {
                    Serial.println("OTA Error: Failed to create signature verification task!");
                    free(verif_data);
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_TASK_CREATE";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                    esp_ota_abort(ota_handle);
                    ota_in_progress = false;
                    ota_handle = 0;
                    ota_received_size = 0;
                    signature_received = false;
                    return;
                }
                
                // Signature verification runs on its own task. Do NOT block the
                // BLE host task waiting for it: spinning here for up to 30s
                // starves the whole BLE stack (connection supervision included)
                // and typically drops the link mid-finalize, and the
                // notifications below may never flush. Flag the finalize and let
                // loop() complete it (verify result -> esp_ota_end ->
                // set_boot_partition -> restart) once the result is ready.
                // See finalizeOtaIfReady().
                ota_finalizing = true;
                ota_finalize_start_ms = millis();
                return;

            } else if (strcmp(value, "ABORT_OTA") == 0) {
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
                        const char* msg = "OTA_ABORTED_CMD";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                } else {
                    Serial.println("Abort command received, but no OTA in progress.");
                     if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_WARN_NO_OTA_TO_ABORT";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                }
            } else if (strncmp(value, "TOTAL_SIZE:", 11) == 0) { 
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
                    const char* msg = "OTA_ERR_NO_PARTITION";
                    pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
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
                    pOTAStatusCharacteristic->setValue((uint8_t*)errorMsg.c_str(), errorMsg.length());
                    pOTAStatusCharacteristic->notify();
                }
                ota_handle = 0; 
                return;
            }
            ota_in_progress = true;
            
            // Turn off LEDs during OTA to save power and avoid interference
            if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
                for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
                    ledMgr.setPixelColor(0, i, CRGB::Black); 
                }
                ledMgr.show();
            }
            
            Serial.println("OTA: esp_ota_begin succeeded. Ready for firmware data.");
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_STARTED_READY";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
        }

        // Write received data to OTA partition
        esp_err_t err = esp_ota_write(ota_handle, value.data(), length);
        if (err != ESP_OK) {
            Serial.printf("OTA Error: esp_ota_write failed (%s)\n", esp_err_to_name(err));
            if (pOTAStatusCharacteristic) {
                String errorMsg = "OTA_ERR_WRITE:" + String(esp_err_to_name(err));
                pOTAStatusCharacteristic->setValue((uint8_t*)errorMsg.c_str(), errorMsg.length());
                pOTAStatusCharacteristic->notify();
            }
            esp_ota_abort(ota_handle); 
            ota_in_progress = false;
            ota_handle = 0;
            signature_received = false;
            return;
        }

        ota_received_size += length;

        // Print progress every 50KB
        static int lastReportedKB = 0;
        int currentKB = ota_received_size / 1024;
        if (currentKB >= lastReportedKB + 50) {
            lastReportedKB = currentKB;
            Serial.printf("OTA: %d KB received\n", currentKB);
        }

        // Acknowledge chunk receipt by notifying on the same characteristic (flow control)
        uint8_t ack_payload[1] = { (uint8_t)(ota_received_size % 256) }; // Simple ACK
        pCharacteristic->setValue(ack_payload, 1); 
        pCharacteristic->notify();
    }
};

// LED Config Get Callbacks - for reading LED strip configuration
class LedConfigGetCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic) {
        Serial.println("LED Config requested via BLE");
        
        // Get current configuration as MessagePack
        LedConfig::FullLedConfiguration currentConfig = configMgr.getCurrentConfigurationFromManager();
        
        // Serialize to MessagePack
        mpack_writer_t writer;
        char* mpack_buffer = nullptr;
        size_t mpack_size = 0;
        mpack_writer_init_growable(&writer, &mpack_buffer, &mpack_size);
        
        // Serialize the configuration
        mpack_start_map(&writer, 2); // globalBrightness, strips
        mpack_write_cstr(&writer, "gb");
        mpack_write_u8(&writer, currentConfig.globalBrightness);
        mpack_write_cstr(&writer, "strips");
        mpack_start_array(&writer, currentConfig.strips.size());
        
        for (const auto& strip : currentConfig.strips) {
            mpack_start_map(&writer, 8);
            mpack_write_cstr(&writer, "cs"); mpack_write_u8(&writer, static_cast<uint8_t>(strip.chipset));
            mpack_write_cstr(&writer, "pin"); mpack_write_u8(&writer, strip.pin);
            mpack_write_cstr(&writer, "num"); mpack_write_u16(&writer, strip.numLeds);
            mpack_write_cstr(&writer, "co"); mpack_write_u8(&writer, static_cast<uint8_t>(strip.colorOrder));
            mpack_write_cstr(&writer, "rmt"); mpack_write_u8(&writer, strip.rmtChannel);
            mpack_write_cstr(&writer, "w"); mpack_write_u16(&writer, strip.width);
            mpack_write_cstr(&writer, "h"); mpack_write_u16(&writer, strip.height);
            mpack_write_cstr(&writer, "ort"); mpack_write_u8(&writer, strip.orientation);
            mpack_finish_map(&writer);
        }
        mpack_finish_array(&writer);
        mpack_finish_map(&writer);
        
        if (mpack_writer_destroy(&writer) == mpack_ok && mpack_buffer) {
            // Set the characteristic value
            pCharacteristic->setValue((uint8_t*)mpack_buffer, mpack_size);
            Serial.printf("LED Config sent: %d bytes\n", mpack_size);
            free(mpack_buffer);
        } else {
            Serial.println("Failed to serialize LED config");
            if (mpack_buffer) free(mpack_buffer);
        }
    }
};

// LED Config Set Callbacks - for writing LED strip configuration
class LedConfigSetCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.printf("LED Config update received: %d bytes\n", value.length());

            // Stage the raw MessagePack for the render loop to apply. We must NOT
            // apply it here: this callback runs on the BLE host task, while the
            // render loop runs on the Arduino task. Applying the config frees and
            // reallocates the renderer's pixel buffers and destroys/recreates the
            // LED strips, which races with update()/render() and corrupts the
            // output buffers. processReceivedLedConfig() applies it safely from
            // loop(), mirroring how patterns are handled.
            if (ledConfigBuffer != nullptr) {
                free(ledConfigBuffer);
                ledConfigBuffer = nullptr;
                ledConfigBufferSize = 0;
            }

            ledConfigBufferSize = value.length();
            ledConfigBuffer = (uint8_t*)malloc(ledConfigBufferSize);

            if (ledConfigBuffer != nullptr) {
                memcpy(ledConfigBuffer, value.data(), ledConfigBufferSize);
                newLedConfigAvailable = true;
            } else {
                Serial.println("LED Config: Failed to allocate memory for config");
                ledConfigBufferSize = 0;
            }
        }
    }
};

// Pattern Sync Callbacks - for receiving messagepack-encoded patterns
class PatternSyncCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string rxValue = pCharacteristic->getValue();
        
        if (rxValue.length() > 0) {
            //Serial.printf("Pattern Sync: Received %d bytes\n", rxValue.length());
            
            // Free existing pattern buffer if it exists
            if (patternBuffer != nullptr) {
                free(patternBuffer);
                patternBuffer = nullptr;
                patternBufferSize = 0;
            }
            
            // Allocate new buffer and copy pattern data
            patternBufferSize = rxValue.length();
            patternBuffer = (uint8_t*)malloc(patternBufferSize);
            
            if (patternBuffer != nullptr) {
                memcpy(patternBuffer, rxValue.data(), patternBufferSize);
                newPatternAvailable = true;
                //Serial.println("Pattern Sync: Pattern received and stored successfully");
            } else {
                Serial.println("Pattern Sync: Failed to allocate memory for pattern");
                patternBufferSize = 0;
            }
        }
    }
};

// Timestamp Sync Callbacks - for receiving timestamp synchronization from mobile app
class TimestampSyncCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() == 8) { // Expecting 64-bit timestamp in milliseconds
            // Parse the timestamp (little-endian 64-bit unsigned integer)
            uint64_t timestamp = 0;
            memcpy(&timestamp, value.data(), 8);
            
            unsigned long localTime = millis();
            
            // Store sync point
            syncedTimestampMs = (unsigned long)timestamp;
            syncedLocalTime = localTime;
            timestampSynced = true;
            
            // Update pattern renderer with synchronized time
            if (patternRenderer) {
                patternRenderer->setSynchronizedTime(syncedTimestampMs, syncedLocalTime);
            }
            
            Serial.printf("Timestamp sync received: %lu ms (local: %lu ms)\n", 
                         syncedTimestampMs, syncedLocalTime);
        } else {
            Serial.printf("Invalid timestamp sync length: %d bytes (expected 8)\n", value.length());
        }
    }
};

// Function to process received pattern data
void processReceivedPattern() {
    if (!newPatternAvailable || patternBuffer == nullptr || patternRenderer == nullptr) {
        return;
    }
    
    //Serial.println("Processing received pattern...");
    
    // Try to load the pattern into the pattern renderer
    bool success = patternRenderer->loadPatternFromMessagePack(patternBuffer, patternBufferSize);
    
    if (success) {
        //Serial.println("Pattern loaded successfully into renderer");
    } else {
        Serial.println("Failed to load pattern into renderer");
    }
    
    // Mark pattern as processed
    newPatternAvailable = false;

    //Serial.println("Pattern processing completed");
}

// Function to process a staged LED configuration. Runs from loop() on the
// Arduino task, so applying the config (reallocating renderer buffers and
// recreating LED strips) never races with update()/render().
void processReceivedLedConfig() {
    if (!newLedConfigAvailable || ledConfigBuffer == nullptr) {
        return;
    }

    // Parse MessagePack data
    mpack_reader_t reader;
    mpack_reader_init_data(&reader, (const char*)ledConfigBuffer, ledConfigBufferSize);

    try {
        uint32_t map_count = mpack_expect_map(&reader);
        LedConfig::FullLedConfiguration newConfig;

        for (uint32_t i = 0; i < map_count; ++i) {
            char key_buffer[16];
            mpack_expect_cstr(&reader, key_buffer, sizeof(key_buffer));

            if (strcmp(key_buffer, "gb") == 0) {
                newConfig.globalBrightness = mpack_expect_u8(&reader);
            } else if (strcmp(key_buffer, "strips") == 0) {
                uint32_t strips_count = mpack_expect_array(&reader);
                newConfig.strips.reserve(strips_count);

                for (uint32_t s = 0; s < strips_count; ++s) {
                    uint32_t strip_map_count = mpack_expect_map(&reader);
                    LedConfig::LedStripConfig stripConfig;

                    for (uint32_t k = 0; k < strip_map_count; ++k) {
                        char strip_key[16];
                        mpack_expect_cstr(&reader, strip_key, sizeof(strip_key));

                        if (strcmp(strip_key, "cs") == 0) {
                            stripConfig.chipset = static_cast<LedConfig::LedChipset>(mpack_expect_u8(&reader));
                        } else if (strcmp(strip_key, "pin") == 0) {
                            stripConfig.pin = mpack_expect_u8(&reader);
                        } else if (strcmp(strip_key, "num") == 0) {
                            stripConfig.numLeds = mpack_expect_u16(&reader);
                        } else if (strcmp(strip_key, "co") == 0) {
                            stripConfig.colorOrder = static_cast<LedConfig::ColorOrderValue>(mpack_expect_u8(&reader));
                        } else if (strcmp(strip_key, "rmt") == 0) {
                            stripConfig.rmtChannel = mpack_expect_u8(&reader);
                        } else if (strcmp(strip_key, "w") == 0) {
                            stripConfig.width = mpack_expect_u16(&reader);
                        } else if (strcmp(strip_key, "h") == 0) {
                            stripConfig.height = mpack_expect_u16(&reader);
                        } else if (strcmp(strip_key, "ort") == 0) {
                            stripConfig.orientation = mpack_expect_u8(&reader);
                        } else {
                            mpack_discard(&reader);
                        }
                    }
                    mpack_done_map(&reader);

                    if (stripConfig.numLeds > 0) {
                        newConfig.strips.push_back(stripConfig);
                    }
                }
                mpack_done_array(&reader);
            } else {
                mpack_discard(&reader);
            }
        }
        mpack_done_map(&reader);

        // Apply the new configuration. Safe here: we are on the loop task and run
        // outside update()/render(), so nothing else touches the renderer buffers
        // or LED strips while we reallocate/recreate them.
        configMgr.applyConfiguration(newConfig);

        // Update pattern renderer matrix config
        if (patternRenderer) {
            patternRenderer->updateMatrixConfig();
        }

        // Save configuration to file
        configMgr.saveConfiguration();

        Serial.println("LED Configuration updated successfully");

    } catch (...) {
        Serial.println("Error parsing LED configuration MessagePack data");
    }

    mpack_reader_destroy(&reader);

    // Mark config as processed and release the staging buffer
    newLedConfigAvailable = false;
    free(ledConfigBuffer);
    ledConfigBuffer = nullptr;
    ledConfigBufferSize = 0;
}

// Finalize a pending OTA update from the loop task once the signature
// verification task has produced a result (or timed out). This runs the work
// that used to block the BLE host-task callback: verify result -> esp_ota_end ->
// set_boot_partition -> restart. Running it from loop() keeps the BLE stack
// responsive throughout the finalize.
void finalizeOtaIfReady() {
    if (!ota_finalizing) return;

    // Still verifying: enforce the 30s timeout, otherwise keep waiting.
    if (!signature_verification_complete) {
        if (millis() - ota_finalize_start_ms >= 30000) {
            Serial.println("OTA Error: Signature verification timed out!");
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_ERR_SIG_TIMEOUT";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
            esp_ota_abort(ota_handle);
            ota_finalizing = false;
            ota_in_progress = false;
            ota_handle = 0;
            ota_received_size = 0;
            signature_received = false;
        }
        return;
    }

    // Verification finished — we own the finalize from here.
    ota_finalizing = false;

    if (!signature_verification_result) {
        Serial.println("OTA Error: Firmware signature verification FAILED!");
        if (pOTAStatusCharacteristic) {
            const char* msg = "OTA_ERR_SIG_INVALID";
            pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
            pOTAStatusCharacteristic->notify();
        }
        esp_ota_abort(ota_handle);
        ota_in_progress = false;
        ota_handle = 0;
        ota_received_size = 0;
        signature_received = false;
        return;
    }

    Serial.println("OTA: Firmware signature verification PASSED.");
    Serial.printf("OTA End command received. Finalizing update... (Total received: %d bytes)\n", ota_received_size);

    esp_err_t err = esp_ota_end(ota_handle);
    if (err == ESP_OK) {
        Serial.println("OTA: Firmware write completed successfully.");
        if (pOTAStatusCharacteristic) {
            const char* msg = "OTA_VALIDATING";
            pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
            pOTAStatusCharacteristic->notify();
            delay(10); // Allow BLE notification to send
        }

        Serial.println("OTA: Setting new firmware as boot partition...");
        err = esp_ota_set_boot_partition(update_partition);
        if (err == ESP_OK) {
            Serial.println("OTA: Boot partition updated successfully. Rebooting in 2 seconds...");
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_SUCCESS_REBOOTING";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
                delay(100); // Allow BLE notification to send before reboot
            }
            delay(2000); // Give time for final messages
            esp_restart();
        } else {
            Serial.printf("OTA Error: esp_ota_set_boot_partition failed! (%s)\n", esp_err_to_name(err));
            if (pOTAStatusCharacteristic) {
                String errorMsg = "OTA_ERR_SET_BOOT:" + String(esp_err_to_name(err));
                pOTAStatusCharacteristic->setValue((uint8_t*)errorMsg.c_str(), errorMsg.length());
                pOTAStatusCharacteristic->notify();
            }
        }
    } else {
        Serial.printf("OTA Error: esp_ota_end failed! (%s)\n", esp_err_to_name(err));
        if (pOTAStatusCharacteristic) {
            String errorMsg = "OTA_ERR_END_FAILED:" + String(esp_err_to_name(err));
            pOTAStatusCharacteristic->setValue((uint8_t*)errorMsg.c_str(), errorMsg.length());
            pOTAStatusCharacteristic->notify();
        }
    }

    // Reset OTA state after attempting to end (unless we already rebooted).
    ota_in_progress = false;
    ota_handle = 0;
    ota_received_size = 0;
    signature_received = false;
}

// pushCRGBToStrip function removed - pattern renderer handles LED output directly

void setup() {
    Serial.begin(115200);
    delay(1000); 
    Serial.println("ESP32 LedManager + OTA Demo Starting...");

    // --- Boot-time firmware state check ---
    Serial.printf("Firmware version: %s\n", FIRMWARE_VERSION);

    const esp_partition_t *running_partition = esp_ota_get_running_partition();
    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            Serial.println("Boot: Firmware PENDING VERIFICATION - checking critical systems...");
        } else if (ota_state == ESP_OTA_IMG_VALID) {
            Serial.println("Boot: Firmware VALID");
        } else if (ota_state == ESP_OTA_IMG_INVALID) {
            Serial.println("Boot: Firmware INVALID");
        }
    }

    // --- Critical System Initialization with Rollback on Failure ---
    bool criticalSystemsOK = true;

    // Initialize filesystem
    if (!LittleFS.begin(true)) { 
        Serial.println("ERROR: LittleFS Mount Failed!");
        criticalSystemsOK = false;
    } else {
        Serial.println("LittleFS mounted");
    }

    // Initialize LED configuration
    LedConfig::LedStripConfig defaultStrip;
    defaultStrip.chipset     = LedConfig::LedChipset::WS2812_RGB;
    defaultStrip.pin         = LED_PIN;
    defaultStrip.numLeds     = NUM_LEDS;
    defaultStrip.colorOrder  = LedConfig::ColorOrderValue::CO_GRB;
    defaultStrip.rmtChannel  = 0;
    defaultStrip.width       = 0;  // 0 = linear strip
    defaultStrip.height      = 0;  // 0 = linear strip
    defaultStrip.orientation = 0;  // 0 = no rotation, no flip, no serpentine
    
    // Ensure we have a valid config file (create/overwrite if missing or empty/invalid)
    configMgr.ensureValidConfigFile(defaultStrip);
    bool configLoadedAndApplied = configMgr.loadAndApplyConfiguration();

    // Fallback to default strip if config loading/application fails or results in no strips
    if (!configLoadedAndApplied || ledMgr.getNumStrips() == 0) {
        Serial.println("Using fallback LED configuration");
        ledMgr.clearStrips();
        if (!ledMgr.addStrip(defaultStrip)) {
            Serial.println("ERROR: Failed to add LED strip!");
            criticalSystemsOK = false;
        } else {
            ledMgr.setGlobalBrightness(BRIGHTNESS);
            ledMgr.begin(); // Initialize the LED hardware driver
        }
    }

    if (ledMgr.getNumStrips() == 0) {
        Serial.println("ERROR: No LED strips configured!");
        criticalSystemsOK = false;
    } else {
        Serial.printf("LED strips: %d\n", ledMgr.getNumStrips());
        
        // Initialize pattern renderer
        patternRenderer = new PatternRendererBase(&ledMgr);
        if (patternRenderer) {
            Serial.println("Pattern renderer initialized");
            // Update with current LED configuration
            patternRenderer->updateMatrixConfig();
        } else {
            Serial.println("ERROR: Failed to initialize pattern renderer!");
            criticalSystemsOK = false;
        }
    }
    
    // Test LED functionality
    if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Red); 
        }
        ledMgr.show();
        delay(500);
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Black); 
        }
        ledMgr.show();
    } else {
        Serial.println("ERROR: Cannot test LED functionality!");
        criticalSystemsOK = false;
    }
    
    // Initialize BLE
    NimBLEDevice::init("ChromaBay_ESP32"); 
    pServer = NimBLEDevice::createServer();
    if (!pServer) {
        Serial.println("ERROR: Failed to create BLE server!");
        criticalSystemsOK = false;
    } else {
        pServer->setCallbacks(new ServerCallbacks());
        
        NimBLEService *pService = pServer->createService(SERVICE_UUID); 
        if (!pService) {
            Serial.println("ERROR: Failed to create BLE service!");
            criticalSystemsOK = false;
        } else {
            // Create characteristics
            pTxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TX, NIMBLE_PROPERTY::NOTIFY);
            NimBLECharacteristic* pRxCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
            pRxCharacteristic->setCallbacks(new CharacteristicCallbacks());

            // OTA Characteristics
            pDeviceInfoCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_DEVICE_INFO, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
            pOTAControlCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_OTA_CONTROL, NIMBLE_PROPERTY::WRITE);
            pOTAControlCharacteristic->setCallbacks(new OTAControlCallbacks());
            pOTADataCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_OTA_DATA, NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
            pOTADataCharacteristic->setCallbacks(new OTADataCallbacks());
            pOTAStatusCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_OTA_STATUS, NIMBLE_PROPERTY::NOTIFY);
            pOTASignatureCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_OTA_SIGNATURE, NIMBLE_PROPERTY::WRITE);
            pOTASignatureCharacteristic->setCallbacks(new OTASignatureCallbacks());
            
            // Pattern Sync Characteristic
            pPatternSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_PATTERN_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pPatternSyncCharacteristic->setCallbacks(new PatternSyncCallbacks());
            
            // LED Configuration Characteristics
            pLedConfigGetCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LED_CONFIG_GET, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
            pLedConfigGetCharacteristic->setCallbacks(new LedConfigGetCallbacks());
            pLedConfigSetCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LED_CONFIG_SET, NIMBLE_PROPERTY::WRITE);
            pLedConfigSetCharacteristic->setCallbacks(new LedConfigSetCallbacks());
            
            // Timestamp Sync Characteristic
            pTimestampSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TIMESTAMP_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pTimestampSyncCharacteristic->setCallbacks(new TimestampSyncCallbacks());
            
            pService->start();
            updateDeviceInfoCharacteristic();
            
            NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
            pAdvertising->addServiceUUID(SERVICE_UUID); 
            pAdvertising->setScanResponse(true);  // Enable scan response for more space
            pAdvertising->setMinPreferred(0x0);
            NimBLEDevice::startAdvertising();
            
            Serial.println("BLE services started");
        }
    }

    // --- Critical Systems Health Check and Rollback Decision ---
    if (!criticalSystemsOK) {
        Serial.println("CRITICAL: System initialization failed!");
        
        if (esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
            if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
                Serial.println("Triggering firmware rollback...");
                esp_err_t rollback_err = esp_ota_mark_app_invalid_rollback_and_reboot();
                if (rollback_err != ESP_OK) {
                    Serial.printf("ERROR: Rollback failed: %s\n", esp_err_to_name(rollback_err));
                }
            }
        }
    }

    // --- Mark firmware as valid if all systems OK ---
    if (criticalSystemsOK && esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            Serial.println("All systems OK - marking firmware as valid");
            esp_err_t mark_valid_err = esp_ota_mark_app_valid_cancel_rollback();
            if (mark_valid_err != ESP_OK) {
                Serial.printf("Warning: Failed to mark firmware valid: %s\n", esp_err_to_name(mark_valid_err));
            }
        }
    }

    Serial.println("Setup complete");
}

unsigned long lastHeapUpdateTime = 0;
const unsigned long heapUpdateInterval = 5000; // Update heap in device info every 5 seconds

void loop() {
    unsigned long currentTime = millis();
    
    // Update pattern rendering
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
        // Pause pattern rendering if OTA is in progress to free up resources
        if (patternRenderer != nullptr && !ota_in_progress) {
            patternRenderer->update();
            patternRenderer->render();
        }
    }

    // Process received patterns and LED configuration changes on the loop task,
    // so they never race with update()/render() above.
    processReceivedPattern();
    processReceivedLedConfig();

    // Finalize a pending OTA off the BLE host task (verify result, end, reboot)
    finalizeOtaIfReady();

    // Periodically update device info characteristic (for heap value)
    if (currentTime - lastHeapUpdateTime >= heapUpdateInterval) {
        lastHeapUpdateTime = currentTime;
        if (deviceConnected) {
            updateDeviceInfoCharacteristic();
        }
    }
    
    // Handle BLE connection changes
    if (!deviceConnected && oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
    }
    if (deviceConnected && !oldDeviceConnected) {
        Serial.println("BLE client connected");
        oldDeviceConnected = deviceConnected;
    }

    delay(1);
}
