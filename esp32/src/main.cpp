#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math
#include <LittleFS.h>
#include <algorithm>  // std::sort for the name-sorted pattern library
#include <cstring>    // strcmp / memcpy
#include <vector>
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
#define CHARACTERISTIC_UUID_PLAYLIST_SYNC "a0be83f0-8dc9-47f0-ab40-b19721d20ed1" // pattern cycling playlist

// LED Configuration Characteristics - for getting/setting strip configuration
#define CHARACTERISTIC_UUID_LED_CONFIG_GET "a0be83ed-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_LED_CONFIG_SET "a0be83ee-8dc9-47f0-ab40-b19721d20ed1"
// Arbitrary pixel layout (WLED ledmap) upload, per strip.
#define CHARACTERISTIC_UUID_LAYOUT_SET "a0be83f5-8dc9-47f0-ab40-b19721d20ed1"
// Layout read-back: write u8 stripIndex to request; device NOTIFYs the layout chunked.
#define CHARACTERISTIC_UUID_LAYOUT_GET "a0be83f6-8dc9-47f0-ab40-b19721d20ed1"
// Auto-layout camera calibration: write [u8 cmd(1=start,0=stop)][u8 stripIndex(0xFF=all)][u8 brightness(0=>default 40)][u8 mode(0=strobe,1=full;default 1)].
#define CHARACTERISTIC_UUID_CALIBRATION "a0be83f7-8dc9-47f0-ab40-b19721d20ed1"

// Timestamp Sync Characteristic - for synchronizing time across devices
#define CHARACTERISTIC_UUID_TIMESTAMP_SYNC "a0be83ef-8dc9-47f0-ab40-b19721d20ed1"

// Brightness Characteristic - live global brightness (single byte, applied immediately)
#define CHARACTERISTIC_UUID_BRIGHTNESS "a0be83f1-8dc9-47f0-ab40-b19721d20ed1"

// Device Name Characteristic - read/write the user-facing BLE device name
#define CHARACTERISTIC_UUID_DEVICE_NAME "a0be83f2-8dc9-47f0-ab40-b19721d20ed1"

// Button Pin Characteristic - read/write the GPIO for the physical control button
// (decimal string; "-1" = none). First pass: single click steps brightness.
#define CHARACTERISTIC_UUID_BUTTON_PIN "a0be83f3-8dc9-47f0-ab40-b19721d20ed1"

// Button Event Characteristic - NOTIFY a button gesture the app must act on (the app
// owns the pattern library). Payload is a short string, e.g. "next" (next pattern).
#define CHARACTERISTIC_UUID_BUTTON_EVENT "a0be83f4-8dc9-47f0-ab40-b19721d20ed1"

// OTA Constants
#define MAX_BLE_CHUNK_SIZE 500 

NimBLEServer* pServer = nullptr;
// Handle of the current central connection (captured in onConnect), so we can request a
// faster connection interval during OTA. 0xFFFF = none.
static uint16_t currentConnHandle = 0xFFFF;
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
NimBLECharacteristic* pLayoutGetCharacteristic = nullptr; // read back a strip's layout (notify-chunked)
static volatile int layoutGetRequest = -1;                // strip index requested via LAYOUT_GET write, -1 = none

// Auto-layout calibration: when active, strips flash a structured-light sequence so the app
// camera can decode each LED's index -> position. Cycle of (1 + bits) frames, each held
// CALIB_FRAME_MS: [ALL-ON ref][bit0][bit1]...[bit(bits-1)]; LED i is on in frame "bitB" iff
// bit B of i is set. (No all-off frame: the decoder gets each pixel's OFF level from the bit
// frames it's dark in, and dropping it keeps the scene bright so the camera doesn't re-expose.)
static volatile bool calibrating = false;
static uint8_t calibStrip = 0xFF;     // which strip flashes (0xFF = all)
static uint8_t calibBits = 8;         // ceil(log2(maxNumLeds))
static uint8_t calibBrightness = 40;  // per-channel white level while flashing (camera-tunable).
                                      // Kept LOW on purpose: at full 255 the LEDs saturate the
                                      // camera and bloom into one solid blob, so adjacent LEDs
                                      // can't be told apart. Dim => distinct dots => decodable.
static uint8_t calibMode = 1;         // 0 = strobe (ALL off/on only — for fast exposure tuning),
                                      // 1 = full structured-light sequence (off/on + bit planes).
static uint32_t calibStartMs = 0;
// Hold each calibration frame this long. Shorter = faster cycle = less camera motion smear per
// cycle (the decoder recovers the real timing from the data, so this isn't safety-critical), but
// it must stay well above the camera's frame interval (~33ms @30fps) so a few frames land in each
// slot. 120ms ≈ 3-4 camera frames/slot and roughly halves the old 220ms cycle.
static const uint32_t CALIB_FRAME_MS = 120;

// Timestamp Sync Characteristic
NimBLECharacteristic* pTimestampSyncCharacteristic = nullptr;

// Playlist Sync Characteristic (pattern cycling)
NimBLECharacteristic* pPlaylistSyncCharacteristic = nullptr;

// Brightness Characteristic (live global brightness)
NimBLECharacteristic* pBrightnessCharacteristic = nullptr;

// Device Name Characteristic (user-settable BLE name; defaults to a MAC-suffixed name)
NimBLECharacteristic* pDeviceNameCharacteristic = nullptr;
static String deviceName;
static const char* DEVICE_NAME_FILE = "/device_name.txt";

// Button (physical control). First pass: a single, debounced click steps brightness.
// Polled in loop() (no ISR yet) to stay clear of the BLE host task. -1 = no button.
NimBLECharacteristic* pButtonPinCharacteristic = nullptr;
NimBLECharacteristic* pButtonEventCharacteristic = nullptr;
static const char* BUTTON_PIN_FILE = "/button_pin.txt";
static int buttonPin = -1;
static int buttonLastReading = HIGH;   // INPUT_PULLUP idle = HIGH
static int buttonStableState = HIGH;
static uint32_t buttonDebounceAtMs = 0;
static const uint32_t BUTTON_DEBOUNCE_MS = 30;
// Click gesture detection: a lone click resolves after the double-click window;
// a second press within it is a double click.
static uint8_t buttonClickCount = 0;
static uint32_t buttonLastPressMs = 0;
static const uint32_t BUTTON_DOUBLE_GAP_MS = 300;

// Name / button writes arrive on the BLE host task but touch flash + advertising, so
// (like patterns/config) they're staged here and applied on the loop task. Doing the
// LittleFS write on the BLE task races the loop's flash writes and can fail to commit.
static volatile bool deviceNamePending = false;
static String pendingDeviceName;
static volatile bool buttonPinPending = false;
static volatile int pendingButtonPin = -1;

// Pattern Storage
static uint8_t* patternBuffer = nullptr;
static size_t patternBufferSize = 0;
static bool newPatternAvailable = false;
// Guards the pattern buffer hand-off between the BLE host task (onWrite) and the
// Arduino loop task (processReceivedPattern). Without it, a rapid follow-up write
// (e.g. dragging a slider) frees patternBuffer while loadPatternFromMessagePack is
// mid-parse on the loop task -> use-after-free -> garbage frame (rainbow artifacts).
static portMUX_TYPE patternMux = portMUX_INITIALIZER_UNLOCKED;

// Debounced pattern persistence. The pattern is applied to the renderer instantly on
// every BLE update (live preview is unaffected), but writing to flash on every update
// would thrash LittleFS during editing. We stage the latest pattern and persist it
// only once edits settle (see processPatternFlashSave). Loop-task only — no lock.
static uint8_t* patternSaveBuf = nullptr;
static size_t patternSaveSize = 0;
static String patternSaveName;   // pattern name captured at receive, used to key the library
static bool patternSaveDirty = false;
static uint32_t patternSaveChangedAtMs = 0;
static const uint32_t PATTERN_SAVE_DEBOUNCE_MS = 2000;

// Live global brightness: the app sends a single byte on each slider tick. We stage
// it here (BLE task) and apply it from loop() via ledMgr.setGlobalBrightness() — the
// lightweight path that just rescales output at show(), no strip reallocation. The
// persisted save is debounced so dragging doesn't thrash flash.
static volatile bool newBrightnessAvailable = false;
static volatile uint8_t pendingBrightness = 255;
static bool brightnessDirty = false;
static uint32_t brightnessChangedAtMs = 0;

// Pattern library + cycling. The device stores a SET of named patterns (see the
// /lib library below). Cycling is just an auto-advance through that set in a stable
// name-sorted order, driven by the SYNCED clock so connected devices step together.
// Cycling on/off is independent of the stored patterns — turning it off only stops
// advancing. The control payload is [u32 intervalMs][u8 enabled], staged from the BLE
// task and applied (with flash persistence) on the loop task.
static uint32_t cycleIntervalMs = 30000; // default 30s
static bool cyclingActive = false;
static int lastCycleIndex = -1;
static uint32_t pendingCycleIntervalMs = 0;
static bool pendingCycleEnabled = false;
static bool newCycleControlAvailable = false;

// Pattern library index — declared here so the button handler (above the storage
// helpers) can advance through it. The /lib storage helpers are defined further down.
static std::vector<String> libNames; // file-index i -> pattern name (/lib/<i>.mp)
static std::vector<int> libOrder;     // file-indices sorted by name (cycle/advance order)
static bool libSetActiveByOrderPos(int pos); // defined with the library helpers below

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

// Staged arbitrary-layout upload (applied from loop(), same reason as LED config above).
// Reassembled from chunked writes: each frame is [u16 totalLen][u16 offset][bytes].
static uint8_t* layoutBuffer = nullptr;
static size_t layoutBufferSize = 0;     // == totalLen once the first chunk arrives
static size_t layoutAccumLen = 0;       // bytes received so far (in-order)
static volatile bool newLayoutAvailable = false;

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
    deviceInfoJson += "\"name\":\"" + deviceName + "\",";
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
// Diagnostic: logs how many patterns the device currently has (RAM cycling state +
// what's persisted in flash). Defined later alongside the flash helpers; declared here
// so the BLE callbacks can trace pattern count across connect/disconnect.
static void logPatternState(const char* when);

class ServerCallbacks: public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) {
        deviceConnected = true;
        currentConnHandle = desc ? desc->conn_handle : 0xFFFF;
        Serial.println("BLE Client Connected");
        logPatternState("connect");
        // Update device info characteristic as heap might have changed or client needs fresh info
        updateDeviceInfoCharacteristic();
        // Note: Mobile app will send timestamp sync after connection is established
    };

    void onDisconnect(NimBLEServer* pServer) {
        currentConnHandle = 0xFFFF;
        deviceConnected = false;
        Serial.println("BLE Client Disconnected");
        logPatternState("disconnect");
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

            // Ask the central for a fast connection interval (7.5-15ms) for the transfer
            // so packets fly more often. iOS may clamp this; it's harmless if ignored.
            // The connection resets on the post-OTA reboot, so no need to restore it.
            if (pServer && currentConnHandle != 0xFFFF) {
                pServer->updateConnParams(currentConnHandle, 6, 12, 0, 400);
            }

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

// Layout Set Callbacks - receive an arbitrary pixel layout (WLED ledmap) for one strip.
// Payload: [u8 stripIndex][u16 W][u16 H][u16 count][count × i16 ledIndex]. Staged for loop().
class LayoutSetCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() < 4) return; // need [u16 totalLen][u16 offset]
        const uint8_t* d = (const uint8_t*)value.data();
        uint16_t totalLen = (uint16_t)(d[0] | (d[1] << 8));
        uint16_t offset   = (uint16_t)(d[2] | (d[3] << 8));
        size_t dataLen = value.length() - 4;
        if (totalLen == 0 || totalLen > 16384) return; // sanity (64x64 map ≈ 8 KB)

        if (offset == 0) { // first chunk: (re)allocate the reassembly buffer
            if (layoutBuffer) { free(layoutBuffer); layoutBuffer = nullptr; }
            layoutBuffer = (uint8_t*)malloc(totalLen);
            layoutBufferSize = layoutBuffer ? totalLen : 0;
            layoutAccumLen = 0;
        }
        if (!layoutBuffer || (size_t)offset + dataLen > layoutBufferSize) return; // out of order / overrun
        memcpy(layoutBuffer + offset, d + 4, dataLen);
        layoutAccumLen = (size_t)offset + dataLen; // writes are serialized + in order
        if (layoutAccumLen >= layoutBufferSize) newLayoutAvailable = true;
    }
};

// Layout Get Callbacks - app writes a u8 strip index; loop() notifies that strip's layout.
class LayoutGetCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() >= 1) layoutGetRequest = (uint8_t)value[0];
    }
};

// Calibration Callbacks - start/stop the auto-layout structured-light flash sequence.
class CalibrationCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string v = pCharacteristic->getValue();
        if (v.length() < 1) return;
        uint8_t cmd = (uint8_t)v[0];
        uint8_t strip = (v.length() >= 2) ? (uint8_t)v[1] : 0xFF;
        if (cmd == 1) {
            calibBrightness = (v.length() >= 3 && v[2]) ? (uint8_t)v[2] : 40;
            calibMode = (v.length() >= 4) ? (uint8_t)v[3] : 1;
            uint16_t maxN = 1;
            for (size_t i = 0; i < ledMgr.getNumStrips(); i++) {
                const LedConfig::LedBus* s = ledMgr.getStrip(i);
                if (s && s->getLength() > maxN) maxN = s->getLength();
            }
            uint8_t bits = 1; while ((1u << bits) < maxN) bits++;
            calibBits = bits; calibStrip = strip; calibStartMs = millis(); calibrating = true;
            Serial.printf("[Calib] START strip=%d bits=%d bright=%d mode=%d (cycle=%d frames @ %dms)\n",
                          strip, bits, calibBrightness, calibMode, calibMode == 0 ? 2 : 2 + bits, (int)CALIB_FRAME_MS);
        } else {
            calibrating = false;
            Serial.println("[Calib] STOP");
        }
    }
};

// Pattern Sync Callbacks - for receiving messagepack-encoded patterns
class PatternSyncCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string rxValue = pCharacteristic->getValue();
        if (rxValue.length() == 0) return;

        // Build the new buffer OUTSIDE the critical section — malloc/free must not
        // run while holding a portMUX spinlock.
        size_t len = rxValue.length();
        uint8_t* buf = (uint8_t*)malloc(len);
        if (buf == nullptr) {
            Serial.println("Pattern Sync: Failed to allocate memory for pattern");
            return;
        }
        memcpy(buf, rxValue.data(), len);

        // Atomically publish the new buffer to the loop task. We only swap pointers
        // under the lock; the previous unconsumed buffer is freed afterwards, outside
        // the lock. The loop task takes ownership before parsing (see
        // processReceivedPattern), so it can never read a buffer we free here.
        uint8_t* old = nullptr;
        portENTER_CRITICAL(&patternMux);
        old = patternBuffer;
        patternBuffer = buf;
        patternBufferSize = len;
        newPatternAvailable = true;
        portEXIT_CRITICAL(&patternMux);
        if (old != nullptr) free(old);
    }
};

// Cycle Control Callbacks - receives the cycling on/off + interval. Payload is
// [u32 intervalMs LE][u8 enabled]. Staged here; applied/persisted on the loop task.
class CycleControlCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string v = pCharacteristic->getValue();
        if (v.length() < 5) return;
        uint32_t iv = 0;
        memcpy(&iv, v.data(), 4);
        pendingCycleIntervalMs = iv;
        pendingCycleEnabled = ((uint8_t)v[4] != 0);
        newCycleControlAvailable = true;
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

// Live global brightness. The app writes a single byte (0-255) on each slider tick.
// We only stage it here; applying touches the LED strips and must run on the loop
// task (see processReceivedBrightness).
class BrightnessCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() >= 1) {
            pendingBrightness = (uint8_t)value[0];
            newBrightnessAvailable = true;
        }
    }
};

// Load the device name from flash, or build a default that's unique out of the box
// (ChromaBay_<MAC suffix>). Call after LittleFS is mounted and before NimBLEDevice::init.
static void loadDeviceName() {
    if (LittleFS.exists(DEVICE_NAME_FILE)) {
        File f = LittleFS.open(DEVICE_NAME_FILE, FILE_READ);
        if (f) {
            String n = f.readString();
            f.close();
            n.trim();
            if (n.length() > 0) { deviceName = n; return; }
        }
    }
    // Default: append the low 2 bytes of the factory MAC so multiple units differ.
    uint64_t mac = ESP.getEfuseMac();
    char suffix[8];
    snprintf(suffix, sizeof(suffix), "%02X%02X", (uint8_t)(mac >> 8), (uint8_t)mac);
    deviceName = String("ChromaBay_") + suffix;
}

static void saveDeviceName(const String& name) {
    File f = LittleFS.open(DEVICE_NAME_FILE, FILE_WRITE);
    if (!f) { Serial.println("Device name: failed to open for write"); return; }
    f.print(name);
    f.close();
    Serial.printf("Device name saved: %s\n", name.c_str());
}

// Read/write the user-facing BLE device name. Write persists it, updates the GAP name
// and the advertised name (so future scans show it), and refreshes device info.
class DeviceNameCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic) {
        pCharacteristic->setValue((uint8_t*)deviceName.c_str(), deviceName.length());
    }
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        // Stage only — the flash write + advertising update happen on the loop task
        // (processDeviceName) so they don't race the loop's other flash writes.
        std::string value = pCharacteristic->getValue();
        pendingDeviceName = String(value.c_str());
        deviceNamePending = true;
    }
};

// Apply a staged rename from the loop task: persist to flash, update the GAP +
// advertised name, refresh device info.
void processDeviceName() {
    if (!deviceNamePending) return;
    deviceNamePending = false;
    String n = pendingDeviceName;
    n.trim();
    if (n.length() == 0 || n.length() > 31) return; // keep within BLE name limits
    deviceName = n;
    saveDeviceName(deviceName);
    NimBLEDevice::setDeviceName(deviceName.c_str());
    NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
    if (adv) {
        adv->stop();
        adv->setName(deviceName.c_str());
        adv->start();
    }
    updateDeviceInfoCharacteristic();
    Serial.printf("Device renamed to: %s\n", deviceName.c_str());
}

// --- Physical button (first pass: single click steps brightness) ---

static void configureButtonPin() {
    if (buttonPin >= 0) {
        pinMode(buttonPin, INPUT_PULLUP); // button to GND, pressed = LOW
        buttonLastReading = HIGH;
        buttonStableState = HIGH;
    }
}

static void loadButtonPin() {
    buttonPin = -1;
    if (LittleFS.exists(BUTTON_PIN_FILE)) {
        File f = LittleFS.open(BUTTON_PIN_FILE, FILE_READ);
        if (f) {
            String s = f.readString();
            f.close();
            s.trim();
            if (s.length() > 0) {
                int p = s.toInt();
                if (p >= 0 && p <= 39) buttonPin = p;
            }
        }
    }
    configureButtonPin();
    Serial.printf("Button pin: %d\n", buttonPin);
}

static void saveButtonPin(int pin) {
    File f = LittleFS.open(BUTTON_PIN_FILE, FILE_WRITE);
    if (!f) { Serial.println("Button pin: failed to open for write"); return; }
    f.print(pin);
    f.close();
    Serial.printf("Button pin saved: %d\n", pin);
}

// Single click action: dim one step down a perceptual (power-of-2) ladder
// 255 -> 128 -> 64 -> 32 -> 16 -> 8 -> 4 -> 2 -> 1 -> 0, then 0 -> 255. Linear -32
// steps barely changed the top end and skipped the visible low levels; powers of 2
// track perceived brightness far better. Off-ladder values snap to the next rung below.
static void onButtonSingleClick() {
    uint8_t b = ledMgr.getGlobalBrightness();
    static const uint8_t rungs[] = { 255, 128, 64, 32, 16, 8, 4, 2, 1, 0 };
    uint8_t nb;
    if (b == 0) {
        nb = 255; // any press from off -> full
    } else {
        nb = 0;
        for (uint8_t i = 0; i < sizeof(rungs); i++) {
            if (rungs[i] < b) { nb = rungs[i]; break; } // largest rung strictly below b
        }
    }
    ledMgr.setGlobalBrightness(nb);
    brightnessDirty = true;
    brightnessChangedAtMs = millis();
    Serial.printf("Button: brightness %u -> %u\n", b, nb);
}

// Double click -> next pattern. The device holds its own library now, so it advances
// locally to the next pattern in the name-sorted order (same order cycling uses). Runs
// on the loop task, so it may read flash directly. Still notifies the app so its UI can
// follow along.
static void onButtonDoubleClick() {
    Serial.println("Button: double click -> next pattern");
    if (!libOrder.empty()) {
        // Find the current pattern's sorted position by name, then advance past it.
        String cur = patternRenderer ? String(patternRenderer->getCurrentPatternName()) : String();
        int pos = 0; // default: if current isn't found, this lands on the first pattern
        for (size_t p = 0; p < libOrder.size(); p++) {
            if (libNames[libOrder[p]] == cur) { pos = (int)p + 1; break; }
        }
        libSetActiveByOrderPos(pos); // wraps
        // If cycling, don't let the next tick immediately override this manual advance.
        if (cyclingActive && cycleIntervalMs > 0) {
            lastCycleIndex = (int)((getSynchronizedTime() / cycleIntervalMs) % (unsigned long)libOrder.size());
        }
    }
    if (pButtonEventCharacteristic) {
        const char* ev = "next";
        pButtonEventCharacteristic->setValue((uint8_t*)ev, 4);
        pButtonEventCharacteristic->notify();
    }
}

// Poll + debounce the button on the loop task, then classify clicks: a second press
// within BUTTON_DOUBLE_GAP_MS is a double click; otherwise a lone click resolves once
// the window passes. (Single click therefore lags by the window — standard tradeoff.)
static void processButton() {
    if (buttonPin < 0) return;
    uint32_t now = millis();
    int reading = digitalRead(buttonPin);
    if (reading != buttonLastReading) {
        buttonDebounceAtMs = now;
        buttonLastReading = reading;
    }
    if ((now - buttonDebounceAtMs) > BUTTON_DEBOUNCE_MS && reading != buttonStableState) {
        buttonStableState = reading;
        if (buttonStableState == LOW) { // a debounced press
            buttonClickCount++;
            buttonLastPressMs = now;
            if (buttonClickCount >= 2) {
                onButtonDoubleClick();
                buttonClickCount = 0;
            }
        }
    }
    // Resolve a single click once the double-click window has elapsed with no 2nd press.
    if (buttonClickCount == 1 && (now - buttonLastPressMs) > BUTTON_DOUBLE_GAP_MS) {
        buttonClickCount = 0;
        onButtonSingleClick();
    }
}

class ButtonPinCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic) {
        String s = String(buttonPin);
        pCharacteristic->setValue((uint8_t*)s.c_str(), s.length());
    }
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        // Stage only; persist + (re)configure the pin on the loop task.
        std::string value = pCharacteristic->getValue();
        String s = String(value.c_str());
        s.trim();
        int p = s.length() > 0 ? s.toInt() : -1;
        pendingButtonPin = (p >= 0 && p <= 39) ? p : -1;
        buttonPinPending = true;
    }
};

// Apply a staged button-pin change from the loop task (persist + reconfigure GPIO).
void processButtonPinUpdate() {
    if (!buttonPinPending) return;
    buttonPinPending = false;
    buttonPin = pendingButtonPin;
    saveButtonPin(buttonPin);
    configureButtonPin();
}

// --- On-device pattern library ---
// Patterns are stored as contiguous /lib/<i>.mp files, each framed:
//   [u16 nameLen LE][name bytes][raw MessagePack pattern].
// Patterns are upserted BY NAME (the app sends "here's your pattern now"); cycling and
// double-click advance through a stable name-sorted view. The active pattern's name is
// remembered in LIB_CURRENT_FILE so the device resumes it on boot.
static const char* LIB_DIR = "/lib";
static const char* LIB_CURRENT_FILE = "/lib_current.txt";
static const char* CYCLE_FILE = "/cycle.bin"; // [u32 intervalMs][u8 enabled]
static const size_t LIB_SCAN_MAX = 256;         // upper bound on stored patterns
static const size_t LIB_MIN_FREE_BYTES = 32768; // headroom so the FS never fills

static String libPath(int i) { return String(LIB_DIR) + "/" + i + ".mp"; }

// Read just the name header of /lib/<i>.mp.
static String libReadName(int i) {
    File f = LittleFS.open(libPath(i), FILE_READ);
    if (!f) return String();
    if (f.available() < 2) { f.close(); return String(); }
    uint8_t lo = (uint8_t)f.read();
    uint8_t hi = (uint8_t)f.read();
    uint16_t nameLen = (uint16_t)lo | ((uint16_t)hi << 8);
    String name;
    for (uint16_t k = 0; k < nameLen && f.available(); k++) name += (char)f.read();
    f.close();
    return name;
}

// Recompute libOrder: file-indices sorted by name, for a stable cycle/advance order
// that's identical across devices holding the same set.
static void libRebuildOrder() {
    libOrder.clear();
    for (size_t i = 0; i < libNames.size(); i++) libOrder.push_back((int)i);
    std::sort(libOrder.begin(), libOrder.end(),
              [](int a, int b) { return strcmp(libNames[a].c_str(), libNames[b].c_str()) < 0; });
}

// Boot: rebuild the in-RAM index from the contiguous /lib/<i>.mp files.
static void libScan() {
    libNames.clear();
    if (!LittleFS.exists(LIB_DIR)) { LittleFS.mkdir(LIB_DIR); libRebuildOrder(); return; }
    for (size_t i = 0; i < LIB_SCAN_MAX; i++) {
        if (!LittleFS.exists(libPath((int)i))) break; // files are kept contiguous
        libNames.push_back(libReadName((int)i));
    }
    libRebuildOrder();
    Serial.printf("Library: %u stored pattern(s)\n", (unsigned)libNames.size());
}

// Store/overwrite a pattern by name (loop task only — does flash I/O). `msgpack`/`size`
// is the raw pattern payload as received over BLE.
static bool libUpsert(const String& name, const uint8_t* msgpack, size_t size) {
    if (name.length() == 0 || msgpack == nullptr || size == 0) return false;
    int idx = -1;
    for (size_t i = 0; i < libNames.size(); i++) if (libNames[i] == name) { idx = (int)i; break; }
    const bool isNew = (idx < 0);
    if (isNew) {
        size_t freeBytes = LittleFS.totalBytes() - LittleFS.usedBytes();
        if (libNames.size() >= LIB_SCAN_MAX || freeBytes < size + LIB_MIN_FREE_BYTES) {
            Serial.println("Library: full / low on flash — not adding new pattern");
            return false;
        }
        idx = (int)libNames.size();
    }
    File f = LittleFS.open(libPath(idx), FILE_WRITE);
    if (!f) { Serial.println("Library: write open failed"); return false; }
    uint16_t nameLen = (uint16_t)name.length();
    f.write((uint8_t)(nameLen & 0xFF));
    f.write((uint8_t)((nameLen >> 8) & 0xFF));
    f.write((const uint8_t*)name.c_str(), nameLen);
    size_t w = f.write(msgpack, size);
    f.close();
    if (w != size) { Serial.println("Library: short write"); return false; }
    if (isNew) { libNames.push_back(name); libRebuildOrder(); }
    Serial.printf("Library upsert [%d] '%s' (%u bytes) — %u total\n",
                  idx, name.c_str(), (unsigned)size, (unsigned)libNames.size());
    return true;
}

// Load the pattern at file-index `idx` into the renderer (strips the name header).
static bool libLoadIndex(int idx) {
    if (idx < 0 || (size_t)idx >= libNames.size() || patternRenderer == nullptr) return false;
    File f = LittleFS.open(libPath(idx), FILE_READ);
    if (!f) return false;
    size_t total = f.size();
    if (total < 2) { f.close(); return false; }
    uint8_t lo = (uint8_t)f.read();
    uint8_t hi = (uint8_t)f.read();
    uint16_t nameLen = (uint16_t)lo | ((uint16_t)hi << 8);
    for (uint16_t k = 0; k < nameLen && f.available(); k++) f.read(); // skip name
    if (total < (size_t)2 + nameLen) { f.close(); return false; }
    size_t mpLen = total - 2 - nameLen;
    if (mpLen == 0) { f.close(); return false; }
    uint8_t* buf = (uint8_t*)malloc(mpLen);
    if (!buf) { f.close(); return false; }
    size_t r = f.read(buf, mpLen);
    f.close();
    bool ok = (r == mpLen) && patternRenderer->loadPatternFromMessagePack(buf, mpLen);
    free(buf);
    return ok;
}

// Remember / read which pattern is active (by name), so a reboot resumes it.
static void libSaveCurrentName(const String& name) {
    File f = LittleFS.open(LIB_CURRENT_FILE, FILE_WRITE);
    if (!f) return;
    f.write((const uint8_t*)name.c_str(), name.length());
    f.close();
}
static String libReadCurrentName() {
    if (!LittleFS.exists(LIB_CURRENT_FILE)) return String();
    File f = LittleFS.open(LIB_CURRENT_FILE, FILE_READ);
    if (!f) return String();
    String s;
    while (f.available()) s += (char)f.read();
    f.close();
    s.trim();
    return s;
}

// Make the pattern at sorted position `pos` (wraps) the live + remembered one.
static bool libSetActiveByOrderPos(int pos) {
    size_t count = libOrder.size();
    if (count == 0) return false;
    pos = ((pos % (int)count) + (int)count) % (int)count;
    int fileIdx = libOrder[pos];
    if (!libLoadIndex(fileIdx)) return false;
    libSaveCurrentName(libNames[fileIdx]);
    return true;
}

// Cycle on/off + interval persistence (so a device resumes cycling after a reboot).
static void saveCycleState() {
    File f = LittleFS.open(CYCLE_FILE, FILE_WRITE);
    if (!f) return;
    uint32_t iv = cycleIntervalMs;
    f.write((const uint8_t*)&iv, 4);
    f.write((uint8_t)(cyclingActive ? 1 : 0));
    f.close();
}
static void restoreCycleState() {
    if (!LittleFS.exists(CYCLE_FILE)) return;
    File f = LittleFS.open(CYCLE_FILE, FILE_READ);
    if (!f) return;
    if (f.available() >= 5) {
        uint32_t iv = 0;
        f.read((uint8_t*)&iv, 4);
        uint8_t en = (uint8_t)f.read();
        if (iv >= 1) cycleIntervalMs = iv;
        cyclingActive = (en != 0);
        lastCycleIndex = -1;
    }
    f.close();
}

// Diagnostic: report how many patterns the device currently has in its library and
// whether it's auto-cycling. Handy for tracing the count from the serial monitor.
static void logPatternState(const char* when) {
    Serial.printf("[PatternState @ %s] libraryPatterns=%u  cyclingActive=%d  intervalMs=%lu  current='%s'\n",
                  when, (unsigned)libNames.size(), (int)cyclingActive,
                  (unsigned long)cycleIntervalMs,
                  patternRenderer ? patternRenderer->getCurrentPatternName() : "");
}

// Apply a freshly-received cycle-control command (called from loop()).
void processReceivedCycleControl() {
    if (!newCycleControlAvailable) return;
    newCycleControlAvailable = false;
    if (pendingCycleIntervalMs >= 1) cycleIntervalMs = pendingCycleIntervalMs;
    cyclingActive = pendingCycleEnabled;
    lastCycleIndex = -1; // re-apply on next updateCycle
    saveCycleState();
    Serial.printf("Cycle control: %s, %lu ms\n", cyclingActive ? "ON" : "OFF", (unsigned long)cycleIntervalMs);
}

// When cycling, advance through the name-sorted library on the SYNCED clock so every
// connected device steps at the same wall-clock instant. Called every render tick.
void updateCycle() {
    if (!cyclingActive || patternRenderer == nullptr) return;
    size_t count = libOrder.size();
    if (count == 0 || cycleIntervalMs == 0) return;
    unsigned long t = getSynchronizedTime();
    int index = (int)((t / cycleIntervalMs) % (unsigned long)count);
    if (index != lastCycleIndex) {
        lastCycleIndex = index;
        int fileIdx = libOrder[index];
        if (libLoadIndex(fileIdx)) {
            libSaveCurrentName(libNames[fileIdx]);
            Serial.printf("Cycle -> '%s' (%d/%u) @ %lu ms\n", libNames[fileIdx].c_str(), index, (unsigned)count, t);
        }
    }
}

// Function to process received pattern data
void processReceivedPattern() {
    if (patternRenderer == nullptr) return;

    // Take exclusive ownership of the pending buffer under the lock, so a concurrent
    // BLE write (rapid slider drags) can't free it while we parse below.
    uint8_t* buf = nullptr;
    size_t size = 0;
    portENTER_CRITICAL(&patternMux);
    if (newPatternAvailable && patternBuffer != nullptr) {
        buf = patternBuffer;
        size = patternBufferSize;
        patternBuffer = nullptr;
        patternBufferSize = 0;
        newPatternAvailable = false;
    }
    portEXIT_CRITICAL(&patternMux);
    if (buf == nullptr) return;

    // We own `buf` now — onWrite will only ever touch a newer buffer, never this one.
    // "Here's your pattern now": show it immediately and stage an upsert-BY-NAME into
    // the library (debounced so a slider drag doesn't hammer flash). Cycling is left
    // untouched — it's just an auto-advance, independent of the stored set; this manual
    // pick simply shows until the next cycle boundary.
    bool success = patternRenderer->loadPatternFromMessagePack(buf, size);
    if (success) {
        if (cyclingActive && cycleIntervalMs > 0 && !libOrder.empty()) {
            // Don't let the next tick instantly override the manual pick.
            lastCycleIndex = (int)((getSynchronizedTime() / cycleIntervalMs) % (unsigned long)libOrder.size());
        }
        if (patternSaveBuf) free(patternSaveBuf);
        patternSaveBuf = buf;
        patternSaveSize = size;
        patternSaveName = patternRenderer->getCurrentPatternName(); // key for the library upsert
        patternSaveDirty = true;
        patternSaveChangedAtMs = millis();
        buf = nullptr; // ownership transferred; don't free below
    } else {
        Serial.println("Failed to load pattern into renderer");
    }

    if (buf) free(buf);
}

// Persist the most-recently-applied pattern to flash once updates have settled. The
// pattern is already live in the renderer; this writes only the power-on-restore copy,
// debounced so rapid edits don't hammer LittleFS.
void processPatternFlashSave() {
    if (patternSaveDirty && (millis() - patternSaveChangedAtMs > PATTERN_SAVE_DEBOUNCE_MS)) {
        patternSaveDirty = false;
        if (patternSaveBuf && patternSaveSize > 0 && patternSaveName.length() > 0) {
            // Upsert by name into the library, and mark it the active pattern.
            if (libUpsert(patternSaveName, patternSaveBuf, patternSaveSize)) {
                libSaveCurrentName(patternSaveName);
            }
        }
    }
}

// Apply staged live brightness from the loop task, and persist it once the slider
// has settled (debounced to avoid hammering flash during a drag).
void processReceivedBrightness() {
    if (newBrightnessAvailable) {
        uint8_t b = pendingBrightness;
        newBrightnessAvailable = false;
        ledMgr.setGlobalBrightness(b);
        brightnessDirty = true;
        brightnessChangedAtMs = millis();
    }
    if (brightnessDirty && (millis() - brightnessChangedAtMs > 1500)) {
        configMgr.saveConfiguration();
        brightnessDirty = false;
    }
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
                        } else if (strcmp(strip_key, "gm") == 0) {
                            stripConfig.gamma = mpack_expect_u16(&reader) / 100.0f;
                        } else if (strcmp(strip_key, "wp") == 0) {
                            uint32_t wp = mpack_expect_u32(&reader);
                            stripConfig.wpR = (wp >> 16) & 0xFF;
                            stripConfig.wpG = (wp >> 8) & 0xFF;
                            stripConfig.wpB = wp & 0xFF;
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

// Apply a staged arbitrary-layout upload from loop() (safe re: render task). Payload is
// [u8 stripIndex][u16 W][u16 H][u16 count][count×i16] — the body after stripIndex is exactly
// the /layout_<i>.bin file format. count==0 (or empty body) clears the strip's layout.
void processReceivedLayout() {
    // Only act once a full upload has been reassembled. Crucially do NOT touch layoutBuffer
    // while chunks are still arriving (newLayoutAvailable == false) — freeing it here would
    // destroy the in-progress reassembly between chunks.
    if (!newLayoutAvailable) return;
    newLayoutAvailable = false;
    if (layoutBuffer == nullptr || layoutBufferSize < 1) { layoutAccumLen = 0; return; }
    uint8_t stripIndex = layoutBuffer[0];
    char path[24];
    snprintf(path, sizeof(path), "/layout_%u.bin", (unsigned)stripIndex);

    bool clear = (layoutBufferSize < 7); // need at least W,H,count after the index byte
    uint16_t count = clear ? 0 : (uint16_t)(layoutBuffer[5] | (layoutBuffer[6] << 8));
    if (clear || count == 0) {
        LittleFS.remove(path);
        Serial.printf("[Layout] Strip %u layout cleared\n", (unsigned)stripIndex);
    } else {
        File f = LittleFS.open(path, FILE_WRITE);
        if (f) {
            f.write(layoutBuffer + 1, layoutBufferSize - 1);
            f.close();
            Serial.printf("[Layout] Strip %u layout saved (%u bytes)\n",
                          (unsigned)stripIndex, (unsigned)(layoutBufferSize - 1));
        } else {
            Serial.println("[Layout] Failed to open layout file for writing");
        }
    }
    configMgr.loadStripLayouts(); // apply live across all strips

    newLayoutAvailable = false;
    free(layoutBuffer);
    layoutBuffer = nullptr;
    layoutBufferSize = 0;
    layoutAccumLen = 0;
}

// Respond to a LAYOUT_GET request: NOTIFY the requested strip's /layout_<i>.bin back to the
// app, chunked as [u16 totalLen][u16 offset][bytes] (same framing as upload). totalLen==0
// means "no layout" (grid mapping). Runs from loop() so file IO doesn't block the BLE task.
void processLayoutGetRequest() {
    int idx = layoutGetRequest;
    if (idx < 0 || !pLayoutGetCharacteristic) return;
    layoutGetRequest = -1;

    char path[24];
    snprintf(path, sizeof(path), "/layout_%u.bin", (unsigned)idx);
    uint8_t* data = nullptr;
    size_t len = 0;
    if (LittleFS.exists(path)) {
        File f = LittleFS.open(path, FILE_READ);
        if (f) {
            size_t sz = f.size();
            if (sz > 0 && sz <= 16384) {
                data = (uint8_t*)malloc(sz);
                if (data && f.readBytes((char*)data, sz) == sz) len = sz;
                else { if (data) { free(data); data = nullptr; } }
            }
            f.close();
        }
    }

    const size_t CH = 180;
    if (len == 0) {
        uint8_t hdr[4] = {0, 0, 0, 0}; // totalLen 0
        pLayoutGetCharacteristic->setValue(hdr, 4);
        pLayoutGetCharacteristic->notify();
    } else {
        for (size_t off = 0; off < len; off += CH) {
            size_t n = (len - off < CH) ? (len - off) : CH;
            uint8_t frame[4 + 180];
            frame[0] = len & 0xFF; frame[1] = (len >> 8) & 0xFF;
            frame[2] = off & 0xFF; frame[3] = (off >> 8) & 0xFF;
            memcpy(frame + 4, data + off, n);
            pLayoutGetCharacteristic->setValue(frame, 4 + n);
            pLayoutGetCharacteristic->notify();
            delay(8); // small gap so the stack doesn't drop back-to-back notifications
        }
    }
    if (data) free(data);
    Serial.printf("[Layout] Strip %d read-back sent (%u bytes)\n", idx, (unsigned)len);
}

// Drive one structured-light calibration frame onto the strips (replaces pattern render
// while calibrating). Frame = (elapsed / CALIB_FRAME_MS) mod (2 + bits).
void renderCalibrationFrame() {
    // Two sequences, both LED-on-heavy (no long all-off — that only made the camera re-expose
    // and flash dark, slowing the scan with no decode benefit; the decoder derives each pixel's
    // OFF level from the bit frames it's dark in):
    //   strobe (mode 0): [OFF][ON]                  — fast exposure tuning only, cycleLen 2
    //   full   (mode 1): [ALL-ON][bit0]..[bit(b-1)] — structured light, cycleLen 1+bits
    uint32_t cycleLen = (calibMode == 0) ? 2u : (1u + calibBits);
    uint32_t frame = ((millis() - calibStartMs) / CALIB_FRAME_MS) % cycleLen;
    for (size_t s = 0; s < ledMgr.getNumStrips(); s++) {
        LedConfig::LedBus* st = ledMgr.getStrip(s);
        if (!st) continue;
        uint16_t n = st->getLength();
        bool targetStrip = (calibStrip == 0xFF) || (s == calibStrip);
        for (uint16_t i = 0; i < n; i++) {
            bool on;
            if (!targetStrip) on = false;              // non-target strips stay dark
            else if (calibMode == 0) on = (frame == 1); // strobe: 0=off, 1=on
            else if (frame == 0) on = true;             // full: ALL-ON reference + sync anchor
            else on = ((i >> (frame - 1)) & 1u) != 0;   // full: bit (frame-1) of the LED index
            // Write RAW (uint32_t overload bypasses the per-strip gamma/white-point LUT) so the
            // brightness maps ~linearly to light output for the camera — the CRGB path would
            // gamma-crush low values to near-zero, making the dim end of the sweep produce no light.
            uint8_t b = calibBrightness;
            uint32_t onColor = ((uint32_t)b << 16) | ((uint32_t)b << 8) | (uint32_t)b;
            uint32_t col = on ? onColor : (uint32_t)0;
            st->setPixelColor(i, col);
        }
    }
    ledMgr.show();
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

    // Initialize filesystem. Try to mount WITHOUT auto-formatting first so we never
    // silently wipe saved patterns: a reformat only happens if the existing filesystem
    // is genuinely unmountable, and we log it loudly when it does (it's the one event
    // that destroys persisted patterns). With the platform/core pinned in
    // platformio.ini, a firmware update keeps the same LittleFS format, so a healthy
    // device mounts cleanly here and its saved pattern survives the update.
    if (LittleFS.begin(false)) {
        Serial.println("LittleFS mounted");
    } else {
        Serial.println("WARNING: LittleFS mount failed — formatting (any saved pattern is lost)");
        if (!LittleFS.begin(true)) {
            Serial.println("ERROR: LittleFS Mount Failed!");
            criticalSystemsOK = false;
        } else {
            Serial.println("LittleFS formatted and mounted");
        }
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
            // Restore on power-on: prefer a saved cycling playlist, else the last
            // single pattern, so the device resumes instead of starting blank.
            // Rebuild the pattern library and resume: the saved active pattern (by
            // name) if present, else the first in sorted order. Restore cycle state too.
            libScan();
            restoreCycleState();
            {
                String cur = libReadCurrentName();
                bool loaded = false;
                if (cur.length() > 0) {
                    for (size_t p = 0; p < libOrder.size(); p++) {
                        if (libNames[libOrder[p]] == cur) { loaded = libSetActiveByOrderPos((int)p); break; }
                    }
                }
                if (!loaded && !libOrder.empty()) libSetActiveByOrderPos(0);
            }
            logPatternState("boot");
        } else {
            Serial.println("ERROR: Failed to initialize pattern renderer!");
            criticalSystemsOK = false;
        }
    }
    
    // Power-on test: Red, Green, Blue for 0.5s each before the saved pattern
    // starts (verifies the LEDs work AND that colour order is correct — if these
    // don't show as R/G/B in order, the strip's colorOrder config is wrong).
    if (ledMgr.getNumStrips() > 0) {
        const CRGB testColors[3] = { CRGB::Red, CRGB::Green, CRGB::Blue };
        for (int c = 0; c < 3; c++) {
            // Drive EVERY LED on EVERY strip for this color.
            for (size_t s = 0; s < ledMgr.getNumStrips(); s++) {
                const LedConfig::LedBus* strip = ledMgr.getStrip(s);
                if (!strip) continue;
                int len = strip->getLength();
                for (int i = 0; i < len; i++) {
                    ledMgr.setPixelColor(s, i, testColors[c]);
                }
            }
            ledMgr.show();
            delay(500);
        }
        // Clear all strips.
        for (size_t s = 0; s < ledMgr.getNumStrips(); s++) {
            const LedConfig::LedBus* strip = ledMgr.getStrip(s);
            if (!strip) continue;
            int len = strip->getLength();
            for (int i = 0; i < len; i++) {
                ledMgr.setPixelColor(s, i, CRGB::Black);
            }
        }
        ledMgr.show();
    } else {
        Serial.println("ERROR: Cannot test LED functionality!");
        criticalSystemsOK = false;
    }
    
    // Initialize BLE with the saved/default device name (LittleFS is mounted above).
    loadDeviceName();
    Serial.printf("Device name: %s\n", deviceName.c_str());
    loadButtonPin(); // configure the physical button GPIO (if any)
    NimBLEDevice::init(deviceName.c_str());
    // Negotiate a large ATT MTU so OTA chunks (up to MAX_BLE_CHUNK_SIZE = 500B) ride in
    // a single ATT packet instead of being fragmented — fewer link-layer round-trips.
    // The central (iOS) still caps the actual negotiated value; this just raises our max.
    NimBLEDevice::setMTU(517);
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

            // Arbitrary pixel layout (WLED ledmap) upload, per strip.
            NimBLECharacteristic* pLayoutSetCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LAYOUT_SET, NIMBLE_PROPERTY::WRITE);
            pLayoutSetCharacteristic->setCallbacks(new LayoutSetCallbacks());
            pLayoutGetCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LAYOUT_GET, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pLayoutGetCharacteristic->setCallbacks(new LayoutGetCallbacks());
            NimBLECharacteristic* pCalibrationCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_CALIBRATION, NIMBLE_PROPERTY::WRITE);
            pCalibrationCharacteristic->setCallbacks(new CalibrationCallbacks());
            
            // Timestamp Sync Characteristic
            pTimestampSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TIMESTAMP_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pTimestampSyncCharacteristic->setCallbacks(new TimestampSyncCallbacks());

            pPlaylistSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_PLAYLIST_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pPlaylistSyncCharacteristic->setCallbacks(new CycleControlCallbacks());

            // Brightness Characteristic (live global brightness, single byte)
            pBrightnessCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_BRIGHTNESS, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::READ);
            pBrightnessCharacteristic->setCallbacks(new BrightnessCallbacks());

            // Device Name Characteristic (read current name / write to rename)
            pDeviceNameCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_DEVICE_NAME, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
            pDeviceNameCharacteristic->setValue((uint8_t*)deviceName.c_str(), deviceName.length());
            pDeviceNameCharacteristic->setCallbacks(new DeviceNameCallbacks());

            // Button Pin Characteristic (read current pin / write to set; -1 = none)
            pButtonPinCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_BUTTON_PIN, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
            {
                String bp = String(buttonPin);
                pButtonPinCharacteristic->setValue((uint8_t*)bp.c_str(), bp.length());
            }
            pButtonPinCharacteristic->setCallbacks(new ButtonPinCallbacks());

            // Button Event Characteristic (NOTIFY — app acts on gestures like "next")
            pButtonEventCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_BUTTON_EVENT, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
            pButtonEventCharacteristic->setValue((uint8_t*)"", 0);

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
        
        // On entering/leaving calibration, force global luminance to max so calibBrightness alone
        // controls the light the camera sees (otherwise a low user brightness slider scales it
        // down and it's barely visible); restore the user's brightness on exit.
        static bool wasCalibrating = false;
        static uint8_t savedBrightness = 255;
        if (calibrating && !wasCalibrating) { savedBrightness = ledMgr.getGlobalBrightness(); ledMgr.setGlobalBrightness(255); }
        else if (!calibrating && wasCalibrating) { ledMgr.setGlobalBrightness(savedBrightness); }
        wasCalibrating = calibrating;

        // Pause pattern rendering if OTA is in progress to free up resources
        if (calibrating) {
            // Watchdog: never stay stuck in calibration (which would leave the strip "dark",
            // showing the dim flash sequence instead of a pattern) if the app crashed / closed
            // mid-scan without sending STOP. Auto-exit after 3 minutes.
            if (currentTime - calibStartMs > 180000) {
                calibrating = false;
                Serial.println("[Calib] watchdog timeout -> auto-stop");
            } else {
                renderCalibrationFrame(); // structured-light flash for camera auto-layout
            }
        } else if (patternRenderer != nullptr && !ota_in_progress) {
            updateCycle();   // pick the synced playlist pattern before rendering
            patternRenderer->update();
            patternRenderer->render();
        }
    }

    // Process received patterns and LED configuration changes on the loop task,
    // so they never race with update()/render() above.
    processReceivedPattern();
    processPatternFlashSave();
    processReceivedCycleControl();
    processReceivedLedConfig();
    processReceivedLayout();
    processLayoutGetRequest();
    processReceivedBrightness();
    processButton();
    processDeviceName();
    processButtonPinUpdate();

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
