#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math (fill_rainbow)
#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
#include "esp_ota_ops.h" // For OTA updates
#include "esp_app_format.h" // For esp_app_desc_t and image state checks

// PSA Crypto API includes for signature verification
#include "psa/crypto.h"

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

// Signature verification task variables
TaskHandle_t signature_task_handle = nullptr;
bool signature_verification_complete = false;
bool signature_verification_result = false;

// Structure to pass data to signature verification task
struct SignatureVerificationData {
    uint8_t signature[FIRMWARE_SIGNATURE_LENGTH];
    const esp_partition_t* partition;
    size_t firmware_size;
};

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
    bool verification_result = false;

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
        goto cleanup;
    }

    // Hash the firmware data using PSA
    {
        psa_hash_operation_t hash_op = PSA_HASH_OPERATION_INIT;
        status = psa_hash_setup(&hash_op, PSA_ALG_SHA_256);
        if (status != PSA_SUCCESS) {
            Serial.printf("Failed to setup hash operation: %ld\n", status);
            goto cleanup_key;
        }

        // Read firmware from partition in chunks and hash it
        const size_t CHUNK_SIZE = 4096;
        uint8_t* chunk_buffer = (uint8_t*)malloc(CHUNK_SIZE);
        if (!chunk_buffer) {
            Serial.println("Failed to allocate chunk buffer for hashing");
            psa_hash_abort(&hash_op);
            goto cleanup_key;
        }

        size_t remaining = firmware_size;
        size_t offset = 0;
        
        Serial.printf("Hashing %d bytes from partition using PSA\n", firmware_size);

        while (remaining > 0) {
            size_t to_read = (remaining < CHUNK_SIZE) ? remaining : CHUNK_SIZE;
            
            esp_err_t read_err = esp_partition_read(partition, offset, chunk_buffer, to_read);
            if (read_err != ESP_OK) {
                Serial.printf("Failed to read partition at offset %d: %s\n", offset, esp_err_to_name(read_err));
                free(chunk_buffer);
                psa_hash_abort(&hash_op);
                goto cleanup_key;
            }
            
            status = psa_hash_update(&hash_op, chunk_buffer, to_read);
            if (status != PSA_SUCCESS) {
                Serial.printf("Failed to update hash: %ld\n", status);
                free(chunk_buffer);
                psa_hash_abort(&hash_op);
                goto cleanup_key;
            }
            
            offset += to_read;
            remaining -= to_read;
        }

        free(chunk_buffer);

        size_t hash_length;
        status = psa_hash_finish(&hash_op, firmware_hash, sizeof(firmware_hash), &hash_length);
        if (status != PSA_SUCCESS) {
            Serial.printf("Failed to finish hash: %ld\n", status);
            goto cleanup_key;
        }
    }

    // Print debugging information
    Serial.print("Firmware hash: ");
    for (int i = 0; i < 32; i++) {
        Serial.printf("%02x", firmware_hash[i]);
    }
    Serial.println();

    Serial.print("Received signature (raw): ");
    for (int i = 0; i < sigLen; i++) {
        Serial.printf("%02x", signature[i]);
    }
    Serial.println();

    // Check if signature is already in correct format (r||s, each 32 bytes, big-endian)
    Serial.printf("Signature format analysis:\n");
    Serial.printf("R component (first 32 bytes): ");
    for (int i = 0; i < 32; i++) {
        Serial.printf("%02x", signature[i]);
    }
    Serial.println();
    
    Serial.printf("S component (last 32 bytes): ");
    for (int i = 32; i < 64; i++) {
        Serial.printf("%02x", signature[i]);
    }
    Serial.println();

    // Try multiple signature formats to determine which one works

    // Format 1: Original signature as-is (r||s format)
    Serial.println("Trying Format 1: Original r||s format");
    status = psa_verify_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), 
                            firmware_hash, sizeof(firmware_hash), 
                            signature, sigLen);
    
    if (status == PSA_SUCCESS) {
        Serial.println("✅ Firmware signature verification PASSED (Format 1: r||s)");
        verification_result = true;
        goto cleanup_key;
    } else {
        Serial.printf("❌ Format 1 failed: %ld\n", status);
    }

    // Format 2: Swapped r and s components
    if (sigLen == 64) {
        uint8_t swapped_signature[64];
        memcpy(swapped_signature, signature + 32, 32);      // s component first
        memcpy(swapped_signature + 32, signature, 32);      // r component second
        
        Serial.println("Trying Format 2: Swapped s||r format");
        status = psa_verify_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), 
                                firmware_hash, sizeof(firmware_hash), 
                                swapped_signature, sigLen);
        
        if (status == PSA_SUCCESS) {
            Serial.println("✅ Firmware signature verification PASSED (Format 2: s||r)");
            verification_result = true;
            goto cleanup_key;
        } else {
            Serial.printf("❌ Format 2 failed: %ld\n", status);
        }
    }

    // Format 3: Convert each component from little-endian to big-endian
    uint8_t bigendian_signature[64];
    // Reverse r component (first 32 bytes)
    for (int i = 0; i < 32; i++) {
        bigendian_signature[i] = signature[31 - i];
    }
    // Reverse s component (last 32 bytes)
    for (int i = 0; i < 32; i++) {
        bigendian_signature[32 + i] = signature[63 - i];
    }
    
    Serial.println("Trying Format 3: Little-endian to big-endian conversion");
    Serial.printf("Big-endian R: ");
    for (int i = 0; i < 32; i++) {
        Serial.printf("%02x", bigendian_signature[i]);
    }
    Serial.println();
    Serial.printf("Big-endian S: ");
    for (int i = 32; i < 64; i++) {
        Serial.printf("%02x", bigendian_signature[i]);
    }
    Serial.println();
    
    status = psa_verify_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), 
                            firmware_hash, sizeof(firmware_hash), 
                            bigendian_signature, sigLen);
    
    if (status == PSA_SUCCESS) {
        Serial.println("✅ Firmware signature verification PASSED (Format 3: big-endian)");
        verification_result = true;
        goto cleanup_key;
    } else {
        Serial.printf("❌ Format 3 failed: %ld\n", status);
    }

    // Format 4: Big-endian + swapped components
    uint8_t bigendian_swapped[64];
    memcpy(bigendian_swapped, bigendian_signature + 32, 32);      // s component first (big-endian)
    memcpy(bigendian_swapped + 32, bigendian_signature, 32);      // r component second (big-endian)
    
    Serial.println("Trying Format 4: Big-endian + swapped (s||r)");
    status = psa_verify_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256), 
                            firmware_hash, sizeof(firmware_hash), 
                            bigendian_swapped, sigLen);
    
    if (status == PSA_SUCCESS) {
        Serial.println("✅ Firmware signature verification PASSED (Format 4: big-endian s||r)");
        verification_result = true;
        goto cleanup_key;
    } else {
        Serial.printf("❌ Format 4 failed: %ld\n", status);
    }

    // All formats failed
    Serial.println("❌ All signature formats failed!");
    verification_result = false;

cleanup_key:
    psa_destroy_key(key_id);
cleanup:
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
                String response = "Blumon ESP32 - LedManager Rainbow Demo (NimBLE)";
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
        Serial.print("OTA Signature Received: ");
        if (value.length() == FIRMWARE_SIGNATURE_LENGTH) {
            memcpy(received_signature, value.data(), FIRMWARE_SIGNATURE_LENGTH);
            signature_received = true;
            Serial.printf("%d bytes stored.\n", value.length());
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_SIG_RECEIVED";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
        } else {
            Serial.printf("Invalid signature length %d bytes. Expected %d.\n", value.length(), FIRMWARE_SIGNATURE_LENGTH);
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
        Serial.print("OTA Control Received: ");
        if (strlen(value) > 0) {
            Serial.println(value);
            
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
                
                // Wait for signature verification to complete (with timeout)
                const int max_wait_seconds = 30;
                int wait_count = 0;
                
                while (!signature_verification_complete && wait_count < (max_wait_seconds * 10)) {
                    delay(100); // Wait 100ms
                    wait_count++;
                }
                
                if (!signature_verification_complete) {
                    Serial.println("OTA Error: Signature verification timed out!");
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_SIG_TIMEOUT";
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
                
                // Check verification result
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
                // Reset OTA state after attempting to end, unless rebooting
                ota_in_progress = false;
                ota_handle = 0; 
                ota_received_size = 0;
                signature_received = false;

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

        // Print progress every 10KB or so
        static int lastReportedKB = 0;
        int currentKB = ota_received_size / 1024;
        if (currentKB >= lastReportedKB + 10) {
            lastReportedKB = currentKB;
            Serial.printf("OTA Progress: %d KB received\n", currentKB);
        }

        // Acknowledge chunk receipt by notifying on the same characteristic (flow control)
        // This is what Sparkfun example does.
        uint8_t ack_payload[1] = { (uint8_t)(ota_received_size % 256) }; // Simple ACK
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

    bool configLoadedAndApplied = configMgr.loadAndApplyConfiguration();

    // Fallback to default strip if config loading/application fails or results in no strips
    if (!configLoadedAndApplied || ledMgr.getNumStrips() == 0) {
        if (!configLoadedAndApplied) {
            Serial.println("Config load/apply reported failure.");
        } else { 
            Serial.println("Config applied but resulted in 0 LED strips.");
        }
        Serial.println("Falling back to built-in default LED strip configuration …");
        ledMgr.clearStrips();
        if (ledMgr.addStrip(defaultStrip)) {
            ledMgr.setGlobalBrightness(BRIGHTNESS); // Apply default brightness for fallback
            ledMgr.begin();
        } else {
            Serial.println("CRITICAL: Failed to add fallback LED strip!");
        }
    } else {
        Serial.println("Configuration successfully loaded and applied from file.");
        ledMgr.begin(); // Brightness should have been loaded from config
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
    
    // Test pattern to confirm LEDs are working
    if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Red); 
        }
        ledMgr.show();
    }
    delay(1000);
    
    // Clear LEDs
    if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0)) {
        for(int i = 0; i < ledMgr.getStrip(0)->getLength(); i++) { 
            ledMgr.setPixelColor(0, i, CRGB::Black); 
        }
        ledMgr.show();
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
    // Device Info value is set by updateDeviceInfoCharacteristic(), no onRead callback needed.

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
                                NIMBLE_PROPERTY::WRITE 
                               );
    pOTASignatureCharacteristic->setCallbacks(new OTASignatureCallbacks());
    // --- End OTA Characteristics ---
    
    pService->start();
    
    updateDeviceInfoCharacteristic(); // Set initial device info before advertising
    
    NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID); 
    pAdvertising->setScanResponse(false);
    pAdvertising->setMinPreferred(0x0);
    NimBLEDevice::startAdvertising();
    
    Serial.println("NimBLE Service (incl. OTA Chars) started - waiting for connections...");
    Serial.println("Device name: Blumon_ESP32");
    Serial.println("Advertising Service UUID: " + String(SERVICE_UUID));
    
    // --- Health Check: Mark app as valid if it was pending verification ---
    // This is the point where we consider the app to have started successfully.
    if (esp_ota_get_state_partition(running_partition, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            Serial.println("Setup complete. App is PENDING VERIFICATION. Marking as VALID.");
            esp_err_t mark_valid_err = esp_ota_mark_app_valid_cancel_rollback();
            if (mark_valid_err == ESP_OK) {
                Serial.println("App successfully marked as valid. Rollback cancelled.");
            } else {
                Serial.printf("Error marking app valid: %s. OTA rollback might occur on next boot if watchdog triggers.\n", esp_err_to_name(mark_valid_err));
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

unsigned long lastHeapUpdateTime = 0;
const unsigned long heapUpdateInterval = 5000; // Update heap in device info every 5 seconds

void loop() {
    unsigned long currentTime = millis();
    
    // Update rainbow animation
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
        // Pause rainbow animation if OTA is in progress to free up resources
        if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0) != nullptr && !ota_in_progress) { 
            fill_rainbow(leds, NUM_LEDS, hue, 200); 
            pushCRGBToStrip();
            ledMgr.show();
            hue += 1;
        }
        
        // Print status every 5 seconds (only when OTA is not in progress)
        static unsigned long lastStatus = 0;
        if (currentTime - lastStatus >= 5000 && !ota_in_progress) {
            lastStatus = currentTime;
            uint8_t currentBrightness = 0;
            if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0) != nullptr) {
                currentBrightness = ledMgr.getStrip(0)->getBrightness(); 
            }
            Serial.printf("Rainbow running - Hue: %d, Brightness: %d, Free heap: %d bytes, BLE: %s, Strips: %d\n", 
                         hue, currentBrightness, ESP.getFreeHeap(), deviceConnected ? "Connected" : "Disconnected", ledMgr.getNumStrips());
        }
    }

    // Periodically update device info characteristic (for heap value)
    if (currentTime - lastHeapUpdateTime >= heapUpdateInterval) {
        lastHeapUpdateTime = currentTime;
        if (deviceConnected) { // Only update if connected to potentially save power/CPU
            updateDeviceInfoCharacteristic();
        }
    }
    
    // Handle BLE connection changes
    if (!deviceConnected && oldDeviceConnected) {
        Serial.println("Client disconnected, advertising should restart automatically if configured.");
        oldDeviceConnected = deviceConnected;
    }
    if (deviceConnected && !oldDeviceConnected) {
        Serial.println("Client reconnected.");
        oldDeviceConnected = deviceConnected;
    }

    delay(1); // Small delay to allow other tasks (like BLE stack) to run
}
