#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math
#include <LittleFS.h>
#include <algorithm>  // std::sort for the name-sorted pattern library
#include <cstring>    // strcmp / memcpy
#include <vector>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>
// Compile-time transport selection. Default build (CHROMABAY_WIFI=1) includes the WiFi/TCP
// transport + Art-Net/sACN streaming; it needs the new (>=1.75MB) OTA partition. The nowifi
// build (=0) drops all of that so the image is small enough to OTA onto legacy 1.375MB-slot
// devices (WiFi on those requires a USB reflash to repartition). BLE control, patterns,
// sleep timer, RGB test and the Clock node work in both.
#ifndef CHROMABAY_WIFI
#define CHROMABAY_WIFI 1
#endif
#if CHROMABAY_WIFI
#include <WiFi.h>       // WiFi transport (alternative to BLE, chosen per comm mode)
#include <WiFiUdp.h>    // Art-Net / sACN realtime pixel streaming (UDP)
#include <ESPmDNS.h>    // advertise the endpoint as _chromabay._tcp for app discovery
#include <mbedtls/sha1.h>    // WebSocket handshake (Sec-WebSocket-Accept = base64(sha1(key+GUID)))
#include <mbedtls/base64.h>
#endif
#include "esp_ota_ops.h" // For OTA updates
#include "esp_chip_info.h" // Report which ESP32 variant we're running on (device-info JSON)
#include "device_settings.h" // NVS-backed comm mode / WiFi creds / sleep timer / rgb-test
#include <time.h>           // wall-clock: time()/localtime for the on/off schedule
#include <sys/time.h>       // settimeofday() — feed the system clock from app sync / NTP

// PSA Crypto API includes for signature verification
#include "psa/crypto.h"

#include "led_manager.h" // Include the new LED Manager
#include "config_manager.h"   // Restore MessagePack config handling
#include "firmware_version.h" // Include firmware version header
#include "sentry_reporting.h" // Crash/reset-reason reporting (no-op unless a DSN is baked in)
#include "pattern_renderer_base.h" // Include pattern renderer

// LED Configuration (some of these are now defaults for LedManager config)
// Default LED data pin. Overridable per chip from platformio.ini (each board's onboard
// LED sits on a different GPIO — e.g. 13 on classic ESP32, 35 on AtomS3, 2 on XIAO C3).
// It's only a first-boot default; the app can reassign the pin at runtime.
#ifndef CHROMABAY_DEFAULT_LED_PIN
#define CHROMABAY_DEFAULT_LED_PIN 13
#endif
#define LED_PIN     CHROMABAY_DEFAULT_LED_PIN
#define NUM_LEDS    64  // 5x5 LED matrix (DISPLAY_WIDTH * DISPLAY_HEIGHT)
#define BRIGHTNESS  20      // Applied to LedManager
// Never boot dark: a device that lost power (or was saved at a very low value) comes back
// visibly so it's obviously alive + controllable. Floors the power-on brightness only; live
// slider sets afterward can still go to 0.
#define BOOT_MIN_BRIGHTNESS 16

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

// Library Command Characteristic - WRITE ops on the on-device pattern set:
//   [0x00]                = clear the whole library
//   [0x01][name UTF-8...] = delete the pattern with that name
#define CHARACTERISTIC_UUID_LIBRARY_CMD "a0be83f8-8dc9-47f0-ab40-b19721d20ed1"
// Read the device's stored pattern library back to the app (notify-chunked), for the app's
// "From Devices" view. App writes any byte to request; device NOTIFYs each stored pattern's
// MessagePack framed [u8 idx][u16 totalLen LE][u16 offset LE][bytes], then a done sentinel idx=0xFF.
#define CHARACTERISTIC_UUID_LIBRARY_DUMP "a0be83f9-8dc9-47f0-ab40-b19721d20ed1"

// Comm/Device settings characteristic - read returns a JSON of the device settings
// (comm mode, wifi ssid, sleep timer, rgb-test, wifi ip); write is a JSON patch. Used to
// provision WiFi over BLE and to flip settings; a mode/ssid change triggers a reboot.
#define CHARACTERISTIC_UUID_COMM_CONFIG "a0be83fa-8dc9-47f0-ab40-b19721d20ed1"

// TCP transport: port the device listens on in WiFi mode, and the framed-message protocol
// version. Each frame is [u8 channel][u32 len LE][payload]. Channels mirror the BLE
// characteristics (see TcpChannel below). mDNS service: _chromabay._tcp.
#define CHROMABAY_TCP_PORT 8080

// OTA Constants
#define MAX_BLE_CHUNK_SIZE 500 

// --- Device settings + transport selection -----------------------------------------
// Loaded from NVS at boot. gWifiMode is true when this boot is running the WiFi/TCP
// transport (STA connected); false = BLE. Exactly one transport is active per boot; the
// app flips the mode (over whichever transport is live) and the device reboots into it.
DeviceSettings::Settings gSettings;
static bool gWifiMode = false;           // this boot is serving over WiFi/TCP
// A COMM_CONFIG (settings) write, staged for the loop task (which saves to NVS and, if the
// mode/creds changed, reboots into the new transport — never from a BLE/TCP callback).
static uint8_t* commCfgBuf = nullptr;
static size_t   commCfgLen = 0;
static volatile bool newCommCfgAvailable = false;

// Sleep timer: after gSettings.sleepMinutes of no app activity + no button, blank the
// output and pause rendering until any activity wakes it. 0 = disabled.
static bool gAsleep = false;
static uint32_t gLastActivityMs = 0;
static void noteActivity();              // defined below; resets the sleep countdown / wakes

// On/off is tied to GLOBAL BRIGHTNESS: brightness 0 == off (output blanked + render skipped);
// any non-zero == on. The daily schedule + a power toggle just drive brightness, so the one
// control the user already touches is the single source of on/off.
//  - gClockValid: true once we know the wall-clock time (app TIMESTAMP_SYNC or WiFi NTP).
//  - gSchedInOffWindow: schedule edge state; on a transition it sets brightness (0 / last-on).
//  - gBriDark: mirror of "brightness == 0", used to blank once + skip rendering.
// On power loss the clock resets to unknown → schedule inert until the app connects / NTP.
static bool gClockValid = false;
static bool gSchedInOffWindow = false;
static bool gBriDark = false;
static const uint32_t LNZB_DEBOUNCE_MS = 10000; // brightness must hold ~10s before we trust it as "settled"
static void blankAllStrips();            // defined below; writes every LED black once

// Realtime streaming (Art-Net/sACN): while millis() < gRealtimeUntilMs the render loop
// yields to streamed pixels; it lapses back to the pattern/cycle after rtTimeout of silence.
static uint32_t gRealtimeUntilMs = 0;

NimBLEServer* pServer = nullptr;
// Handle of the current central connection (captured in onConnect), so we can request a
// faster connection interval during OTA. 0xFFFF = none.
static uint16_t currentConnHandle = 0xFFFF;
NimBLECharacteristic* pCommConfigCharacteristic = nullptr;
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
NimBLECharacteristic* pLibraryDumpCharacteristic = nullptr; // read the stored library back to the app
static volatile bool libraryDumpRequest = false;           // set by LIBRARY_DUMP write, served from loop()

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
// Hold each calibration frame this long. Must stay well above the camera's frame interval so
// several frames land cleanly in each slot — at 30fps a 120ms slot only gets ~3 frames and, with
// loop/show() jitter, the bit-planes under-sample and misalign (decode fails even on a perfectly
// sharp image). 220ms ≈ 6-7 frames/slot, which is the value that decoded reliably. Camera motion
// is handled by registration in the decoder, not by blinking faster.
static const uint32_t CALIB_FRAME_MS = 220;

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

// Pattern-sync reassembly. A pattern can exceed one BLE write (a CoreBluetooth value
// caps at 512B — e.g. an SVG-fill pattern with a detailed path), so the app sends it in
// chunks framed [u16 totalLen LE][u16 offset LE][payload], same scheme as LAYOUT_SET.
// These are touched only by the BLE host task (onWrite), so no lock is needed here;
// the completed buffer is handed to the loop task via patternBuffer under patternMux.
static uint8_t* patternRxBuf = nullptr;
static size_t patternRxSize = 0;
static size_t patternRxAccum = 0;

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
// true  = "add to library" (a deliberate sync — becomes a cycle member);
// false = "current only" (a Live push — persisted as the boot pattern but NOT cycled).
// The app sends a top-level `lib` bool in the pattern; absent (old app) defaults to library.
static bool patternSaveIsLib = true;

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

// Library command staging (see CHARACTERISTIC_UUID_LIBRARY_CMD). Set in the BLE callback,
// processed on the loop task (does flash I/O).
static volatile bool newLibCmdAvailable = false;
static uint8_t libCmdBuf[96];
static volatile size_t libCmdLen = 0;

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
String receivedData = "";

// Single-core targets (ESP32-C3, -S2) run the render loop, the NimBLE host, AND the BT
// controller ISRs on one core, so Bluetooth activity preempts LED output. For timing-critical
// one-wire LEDs (WS2812) that shows up as flicker when a refill is delayed past the reset
// window. We can't reprioritize the BT controller ISR from here, but we CAN cut how often the
// vulnerable show() runs — see the single-core mitigations below. (Dual-core boards run the
// loop on core 1 and BLE on core 0, so they don't need this.) Clock+data LEDs (APA102) are
// immune to the timing hit and are the robust choice on single-core hardware.
#if defined(CONFIG_FREERTOS_UNICORE)
static const bool SINGLE_CORE = true;
#else
static const bool SINGLE_CORE = false;
#endif

// Pattern rendering variables
unsigned long lastUpdate = 0;
// Base animation cadence. On single-core we back off a touch (fewer show()s = fewer windows
// for a BLE ISR to glitch WS2812 timing); the difference is imperceptible in the animation.
const unsigned long updateInterval = SINGLE_CORE ? 30 : 20;
unsigned long fpsLastReport = 0;          // serial FPS report timer
uint32_t fpsFrames = 0;                   // rendered frames since last report

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

// When true, the pending finalize skips ECDSA signature verification entirely. Set ONLY
// by the explicit END_OTA_UNSIGNED control command (the app's "install from file" path,
// e.g. reverting to WLED); registry/OTA updates use signed END_OTA and never touch this.
// Reset at the start of every OTA and after each finalize so it can't leak between updates.
volatile bool ota_skip_signature = false;

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
// Full-precision wall clock (the 32-bit syncedTimestampMs above wraps ~every 49 days, fine
// for animation phase but not absolute time). Captured from the same 64-bit sync; feeds the
// Clock node via WallClock::set() in loop().
uint64_t syncedEpochMs = 0;
uint32_t syncedEpochLocalMs = 0;

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
// The ESP32 variant this firmware is running on. Matches the app's registry `chip` field
// and esptool's --chip name, so the app can pick the right OTA image and never push a
// wrong-architecture build to a device.
static const char* chipModelName() {
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    switch (ci.model) {
        case CHIP_ESP32:   return "esp32";
        case CHIP_ESP32S2: return "esp32s2";
        case CHIP_ESP32S3: return "esp32s3";
        case CHIP_ESP32C3: return "esp32c3";
        default:           return "unknown";
    }
}

// Build the device-info JSON. Shared by the BLE characteristic and the WiFi/TCP transport.
// `feat` lets the app gate features/prompt upgrades; `mode`/`ip` tell it which transport is
// live and where to reach the device on WiFi.
String buildDeviceInfoJson() {
    String j = "{";
    j += "\"fw_ver\":\"" + String(FIRMWARE_VERSION) + "\",";
    j += "\"hw_ver\":\"" + String(HARDWARE_VERSION) + "\",";
    j += "\"feat\":" + String(FIRMWARE_FEATURES) + ",";
    // Does THIS image support WiFi, and how big is the OTA slot the app can flash into? The
    // app compares `slot` (the size of the partition the NEXT OTA writes to — the inactive
    // app slot, read from the live partition table, so it's correct even on devices we only
    // ever reached over OTA / WLED-conversion) against a variant's image size to pick the
    // WiFi vs no-WiFi build that actually fits.
    j += "\"wifi\":" + String(CHROMABAY_WIFI ? 1 : 0) + ",";
    { const esp_partition_t* up = esp_ota_get_next_update_partition(NULL);
      if (up) j += "\"slot\":" + String((uint32_t)up->size) + ","; }
    j += "\"chip\":\"" + String(chipModelName()) + "\",";
    j += "\"name\":\"" + deviceName + "\",";
    j += "\"mode\":\"" + String(gWifiMode ? "wifi" : "ble") + "\",";
#if CHROMABAY_WIFI
    if (gWifiMode) j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
#endif
    j += "\"sleep\":" + String(gSettings.sleepMinutes) + ",";
    j += "\"rgbtest\":" + String(gSettings.rgbTest ? 1 : 0) + ",";
    j += "\"heap\":" + String(ESP.getFreeHeap());
    j += "}";
    return j;
}

void updateDeviceInfoCharacteristic() {
    if (!pDeviceInfoCharacteristic) return; // BLE not running (WiFi mode) — nothing to update
    String deviceInfoJson = buildDeviceInfoJson();
    // IMPORTANT: Always use setValue with explicit length for strings with NimBLE
    // to avoid issues with strlen or incomplete data transmission.
    // The NimBLE setValue(const char*) overload has proven unreliable.
    pDeviceInfoCharacteristic->setValue((uint8_t*)deviceInfoJson.c_str(), deviceInfoJson.length());
}

// --- Shared staging/serialization helpers (used by BOTH the BLE callbacks and the WiFi
// --- TCP transport, so a command behaves identically over either link) -----------------

// Any inbound command or button press counts as activity: reset the sleep countdown and,
// if we were asleep, wake (rendering resumes in loop()).
static void noteActivity() {
    gLastActivityMs = millis();
    if (gAsleep) { gAsleep = false; Serial.println("[Sleep] woke on activity"); }
}

// Write every LED on every strip black and push it out once. Used when going to sleep or
// entering a scheduled-off window; the render guard then keeps rendering paused so it stays
// dark (the configured brightness is untouched, so waking restores the look).
static void blankAllStrips() {
    // Dither-safe blank: writing black + show() alone leaves a dithered strip lit (show()
    // re-emits the last dither target). ledMgr.blank() zeroes the dither buffers + transmits
    // black, so the LEDs actually go dark for sleep / scheduled-off.
    ledMgr.blank();
}

// Hand a fully-reassembled pattern msgpack buffer to the render loop. Takes ownership of
// `full` (frees it or the buffer it replaces). Safe to call from either task — the swap is
// under patternMux.
void stageCompletePattern(uint8_t* full, size_t fullLen) {
    if (!full) return;
    noteActivity();
    uint8_t* old = nullptr;
    portENTER_CRITICAL(&patternMux);
    old = patternBuffer;
    patternBuffer = full;
    patternBufferSize = fullLen;
    newPatternAvailable = true;
    portEXIT_CRITICAL(&patternMux);
    if (old != nullptr) free(old);
}

// Stage raw LED-config msgpack for processReceivedLedConfig() to apply on the loop task.
void stageLedConfigBytes(const uint8_t* data, size_t len) {
    if (!data || len == 0) return;
    noteActivity();
    if (ledConfigBuffer != nullptr) { free(ledConfigBuffer); ledConfigBuffer = nullptr; ledConfigBufferSize = 0; }
    ledConfigBuffer = (uint8_t*)malloc(len);
    if (ledConfigBuffer != nullptr) {
        memcpy(ledConfigBuffer, data, len);
        ledConfigBufferSize = len;
        newLedConfigAvailable = true;
    } else {
        Serial.println("LED Config: alloc failed");
        ledConfigBufferSize = 0;
    }
}

// Serialize the current LED configuration to MessagePack (same shape the BLE LED_CONFIG_GET
// read returns). Caller owns the returned buffer (free it); returns nullptr on failure.
uint8_t* serializeLedConfigMpack(size_t* outLen) {
    LedConfig::FullLedConfiguration cfg = configMgr.getCurrentConfigurationFromManager();
    mpack_writer_t writer;
    char* buf = nullptr; size_t sz = 0;
    mpack_writer_init_growable(&writer, &buf, &sz);
    mpack_start_map(&writer, 2);
    mpack_write_cstr(&writer, "gb"); mpack_write_u8(&writer, cfg.globalBrightness);
    mpack_write_cstr(&writer, "strips");
    mpack_start_array(&writer, cfg.strips.size());
    for (const auto& strip : cfg.strips) {
        mpack_start_map(&writer, 9);
        mpack_write_cstr(&writer, "cs");  mpack_write_u8(&writer, static_cast<uint8_t>(strip.chipset));
        mpack_write_cstr(&writer, "pin"); mpack_write_u8(&writer, strip.pin);
        mpack_write_cstr(&writer, "clk"); mpack_write_u8(&writer, strip.clockPin);
        mpack_write_cstr(&writer, "num"); mpack_write_u16(&writer, strip.numLeds);
        mpack_write_cstr(&writer, "co");  mpack_write_u8(&writer, static_cast<uint8_t>(strip.colorOrder));
        mpack_write_cstr(&writer, "rmt"); mpack_write_u8(&writer, strip.rmtChannel);
        mpack_write_cstr(&writer, "w");   mpack_write_u16(&writer, strip.width);
        mpack_write_cstr(&writer, "h");   mpack_write_u16(&writer, strip.height);
        mpack_write_cstr(&writer, "ort"); mpack_write_u8(&writer, strip.orientation);
        mpack_finish_map(&writer);
    }
    mpack_finish_array(&writer);
    mpack_finish_map(&writer);
    if (mpack_writer_destroy(&writer) != mpack_ok || !buf) { if (buf) free(buf); return nullptr; }
    if (outLen) *outLen = sz;
    return (uint8_t*)buf;
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
        noteActivity();
        SentryReporting::setBleConnected(true);  // a route for any buffered crash report
        Serial.println("BLE Client Connected");
        logPatternState("connect");
        // Update device info characteristic as heap might have changed or client needs fresh info
        updateDeviceInfoCharacteristic();
        // Note: Mobile app will send timestamp sync after connection is established
    };

    void onDisconnect(NimBLEServer* pServer) {
        currentConnHandle = 0xFFFF;
        deviceConnected = false;
        SentryReporting::setBleConnected(false);
        Serial.println("BLE Client Disconnected");
        logPatternState("disconnect");
        // If OTA was in progress and client disconnects, abort it to free resources
        if (ota_in_progress) {
            Serial.println("Client disconnected during OTA. Aborting OTA.");
            SentryReporting::otaFinish(false);
            if (ota_handle != 0) { 
                 esp_ota_abort(ota_handle); 
            }
            ota_in_progress = false;
            ota_handle = 0;
            signature_received = false; // Reset signature status
            ota_skip_signature = false;
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
                SentryReporting::otaSet("image_bytes", (int64_t)ota_received_size);
                SentryReporting::otaPhase("ota.verify");
                // See finalizeOtaIfReady().
                ota_finalizing = true;
                ota_finalize_start_ms = millis();
                return;

            } else if (strcmp(value, "END_OTA_UNSIGNED") == 0) {
                // Finalize WITHOUT signature verification. Only ever sent by the app's
                // explicit "install from file" path (arbitrary/unsigned images, e.g.
                // reverting to WLED). Signed END_OTA above stays the path for registry
                // updates. Requires an active OTA just like END_OTA; no signature needed.
                if (!ota_in_progress || ota_handle == 0) {
                    Serial.println("OTA Error: END_OTA_UNSIGNED received but no OTA process was active or handle invalid.");
                    if (pOTAStatusCharacteristic) {
                        const char* msg = "OTA_ERR_NO_ACTIVE_OTA";
                        pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                        pOTAStatusCharacteristic->notify();
                    }
                    signature_received = false;
                    ota_skip_signature = false;
                    return;
                }

                Serial.println("OTA: END_OTA_UNSIGNED received — finalizing without signature verification.");
                if (pOTAStatusCharacteristic) {
                    const char* msg = "OTA_UNSIGNED_ACCEPTED";
                    pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                    pOTAStatusCharacteristic->notify();
                }
                // Defer the finalize to loop() (same as END_OTA) but flagged to skip
                // signature verification — see finalizeOtaIfReady().
                ota_skip_signature = true;
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
                    ota_skip_signature = false;
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
            ota_skip_signature = false; // Default to signed; only END_OTA_UNSIGNED opts out
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

            // Ask for a link that can survive the transfer, BEFORE touching flash. The
            // previous request (6, 12, 0, 400) asked for a 7.5 ms interval, which violates
            // Apple's rules twice over — interval min must be >= 15 ms, and max must be at
            // least min + 15 ms — and an illegal request is rejected WHOLE. So the 4 s
            // supervision timeout in it never took effect either, and we kept whatever
            // macOS defaults to. 15-30 ms with a 6 s timeout is the fastest legal ask.
            if (pServer && currentConnHandle != 0xFFFF) {
                pServer->updateConnParams(currentConnHandle, 12, 24, 0, 600);
            }

            // The one operation on this device long enough to be worth measuring, and the
            // one that keeps failing. Phases: erase, transfer, verify, finalize.
            SentryReporting::otaBegin();
            SentryReporting::otaPhase("ota.erase");

            // OTA_WITH_SEQUENTIAL_WRITES, not OTA_SIZE_UNKNOWN. NOR flash does have to be
            // erased before it can be rewritten — that part is unavoidable — but the size
            // constant decides WHEN. OTA_SIZE_UNKNOWN erases the whole 1.75 MB slot up
            // front: 1.30 s measured on a PICO-D4, with the flash cache disabled, so the
            // BLE host cannot run and the central hangs up mid-erase. That is the OTA
            // failure. This mode erases each sector inside esp_ota_write() instead, as the
            // data arrives, spreading the same total work into ~40 ms slices between
            // chunks. It requires writes in a continuous sequence, which is exactly how the
            // app streams them.
            const uint32_t otaBeginStart = millis();
            esp_err_t err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &ota_handle);
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
            
            // Logged because this number is the whole story: it used to be 1300 ms, and
            // anything above a second means the link is being asked to survive a stall
            // again.
            Serial.printf("OTA: esp_ota_begin succeeded in %lu ms. Ready for firmware data.\n",
                          (unsigned long)(millis() - otaBeginStart));
            SentryReporting::otaPhase("ota.transfer");
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
        size_t sz = 0;
        uint8_t* buf = serializeLedConfigMpack(&sz);
        if (buf) {
            pCharacteristic->setValue(buf, sz);
            Serial.printf("LED Config sent: %d bytes\n", (int)sz);
            free(buf);
        } else {
            Serial.println("Failed to serialize LED config");
        }
    }
};

// LED Config Set Callbacks - for writing LED strip configuration
class LedConfigSetCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        // Stage the raw MessagePack for the render loop to apply (never apply here — this
        // runs on the BLE host task and would race update()/render()). See stageLedConfigBytes.
        std::string value = pCharacteristic->getValue();
        if (value.length() > 0) {
            Serial.printf("LED Config update received: %d bytes\n", (int)value.length());
            stageLedConfigBytes((const uint8_t*)value.data(), value.length());
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

// Library Dump Callbacks - app writes any byte; loop() notifies the whole stored library back.
class LibraryDumpCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* /*pCharacteristic*/) { libraryDumpRequest = true; }
};

// Library Command Callbacks - stage a [op][payload] command; processLibraryCommand() (loop
// task) does the flash work so we never touch LittleFS from the BLE host task.
class LibraryCmdCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.empty()) return;
        size_t n = value.length();
        if (n > sizeof(libCmdBuf)) n = sizeof(libCmdBuf);
        memcpy(libCmdBuf, value.data(), n);
        libCmdLen = n;
        newLibCmdAvailable = true;
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
        std::string value = pCharacteristic->getValue();
        if (value.length() < 4) return; // need [u16 totalLen][u16 offset]
        const uint8_t* d = (const uint8_t*)value.data();
        uint16_t totalLen = (uint16_t)(d[0] | (d[1] << 8));
        uint16_t offset   = (uint16_t)(d[2] | (d[3] << 8));
        size_t dataLen = value.length() - 4;
        if (totalLen == 0 || totalLen > 16384) return; // sanity

        // Reassemble chunks (malloc/free here run OUTSIDE the spinlock, on the BLE task).
        if (offset == 0) { // first chunk: (re)allocate the reassembly buffer
            if (patternRxBuf) { free(patternRxBuf); patternRxBuf = nullptr; }
            patternRxBuf = (uint8_t*)malloc(totalLen);
            patternRxSize = patternRxBuf ? totalLen : 0;
            patternRxAccum = 0;
            if (!patternRxBuf) { Serial.println("Pattern Sync: alloc failed"); return; }
        }
        if (!patternRxBuf || (size_t)offset + dataLen > patternRxSize) return; // out of order / overrun
        memcpy(patternRxBuf + offset, d + 4, dataLen);
        patternRxAccum = (size_t)offset + dataLen; // writes are serialized + in order
        if (patternRxAccum < patternRxSize) return; // more chunks still coming

        // Complete pattern reassembled — hand the buffer to the loop task.
        uint8_t* full = patternRxBuf;
        size_t fullLen = patternRxSize;
        patternRxBuf = nullptr; patternRxSize = 0; patternRxAccum = 0;
        stageCompletePattern(full, fullLen);
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
        noteActivity();
    }
};

// Timestamp Sync Callbacks - for receiving timestamp synchronization from mobile app
class TimestampSyncCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        // Bytes 0-7 = the frame-sync clock (monotonic ms, matches the browser preview) → drives
        // animation timing. Bytes 8-15 (optional) = the Unix epoch ms → the WALL clock for the
        // Clock node + on/off schedule. These are DIFFERENT clocks: the frame clock is
        // performance.now() (not a real date), so only the epoch may seed time().
        if (value.length() >= 8) {
            uint64_t frameMs = 0;
            memcpy(&frameMs, value.data(), 8);
            unsigned long localTime = millis();
            syncedTimestampMs = (unsigned long)frameMs;
            syncedLocalTime = localTime;
            timestampSynced = true;
            if (patternRenderer) {
                patternRenderer->setSynchronizedTime(syncedTimestampMs, syncedLocalTime);
            }
            if (value.length() >= 16) {
                uint64_t epochMs = 0;
                memcpy(&epochMs, value.data() + 8, 8);
                if (epochMs > 1704067200000ULL) { // sane epoch (after 2024-01-01) only
                    syncedEpochMs = epochMs;
                    syncedEpochLocalMs = (uint32_t)localTime;
                    struct timeval tv = { (time_t)(epochMs / 1000ULL), (suseconds_t)((epochMs % 1000ULL) * 1000ULL) };
                    settimeofday(&tv, nullptr); // seed the system clock for time()/schedule
                }
            }
            Serial.printf("Timestamp sync: frame=%lu ms, wall-epoch=%s\n", syncedTimestampMs,
                          value.length() >= 16 ? String((uint32_t)(syncedEpochMs / 1000ULL)).c_str() : "(none)");
        } else {
            Serial.printf("Invalid timestamp sync length: %d bytes\n", value.length());
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
            noteActivity();
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
// The last pattern SHOWN (raw msgpack), regardless of whether it's a library/cycle member.
// A Live ("current only") pattern lands here so the device resumes it on power-on without it
// joining the cycle. Written on every applied pattern; read at boot when not cycling.
static const char* BOOT_CURRENT_FILE = "/current.mpack";
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
    for (size_t i = 0; i < libNames.size(); i++) Serial.printf("  [lib %u] %s\n", (unsigned)i, libNames[i].c_str());
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

// Delete a pattern by name. Files are kept contiguous, so shift every higher-indexed file
// down by one (LittleFS.rename) after removing the target. The live/displayed pattern is
// untouched. Loop task only (flash I/O).
static bool libDelete(const String& name) {
    if (name.length() == 0) return false;
    int idx = -1;
    for (size_t i = 0; i < libNames.size(); i++) if (libNames[i] == name) { idx = (int)i; break; }
    if (idx < 0) return false;
    LittleFS.remove(libPath(idx));
    for (size_t j = (size_t)idx + 1; j < libNames.size(); j++) {
        LittleFS.rename(libPath((int)j), libPath((int)j - 1));
    }
    libNames.erase(libNames.begin() + idx);
    libRebuildOrder();
    Serial.printf("Library delete '%s' — %u remaining\n", name.c_str(), (unsigned)libNames.size());
    return true;
}

// Remove every stored pattern (the live/displayed pattern keeps running). Scans the full
// index range so it also sweeps up any straggler left by a partial delete. Loop task only.
static void libClear() {
    for (size_t i = 0; i < LIB_SCAN_MAX; i++) {
        String p = libPath((int)i);
        if (LittleFS.exists(p)) LittleFS.remove(p);
    }
    LittleFS.remove(LIB_CURRENT_FILE);
    libNames.clear();
    libRebuildOrder();
    Serial.println("Library cleared");
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

// Persist the raw msgpack of the last-shown pattern as the power-on pattern (see
// BOOT_CURRENT_FILE). Not part of the library/cycle.
static void saveBootCurrent(const uint8_t* msgpack, size_t size) {
    if (msgpack == nullptr || size == 0) return;
    File f = LittleFS.open(BOOT_CURRENT_FILE, FILE_WRITE);
    if (!f) return;
    f.write(msgpack, size);
    f.close();
}
static bool loadBootCurrent() {
    if (patternRenderer == nullptr || !LittleFS.exists(BOOT_CURRENT_FILE)) return false;
    File f = LittleFS.open(BOOT_CURRENT_FILE, FILE_READ);
    if (!f) return false;
    size_t total = f.size();
    if (total == 0) { f.close(); return false; }
    uint8_t* buf = (uint8_t*)malloc(total);
    if (!buf) { f.close(); return false; }
    size_t r = f.read(buf, total);
    f.close();
    bool ok = (r == total) && patternRenderer->loadPatternFromMessagePack(buf, total);
    free(buf);
    return ok;
}

// Read the top-level `lib` bool from a pattern msgpack (true = add-to-library/cycle,
// false = current-only). Absent (old app) → defaultVal.
static bool readPatternLibFlag(const uint8_t* buf, size_t size, bool defaultVal) {
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char*)buf, size);
    mpack_tree_parse(&tree);
    bool result = defaultVal;
    mpack_node_t root = mpack_tree_root(&tree);
    if (mpack_tree_error(&tree) == mpack_ok && mpack_node_map_contains_cstr(root, "lib")) {
        mpack_node_t n = mpack_node_map_cstr(root, "lib");
        if (mpack_node_type(n) == mpack_type_bool) result = mpack_node_bool(n);
    }
    mpack_tree_destroy(&tree);
    return result;
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
    // Deliberately NOT traced: a slider drag applies several patterns a second, and
    // finishing a transaction sends — which blocks this task. See SentryReporting::Operation.
    bool success = patternRenderer->loadPatternFromMessagePack(buf, size);
    if (success) {
        if (cyclingActive && cycleIntervalMs > 0 && !libOrder.empty()) {
            // Don't let the next tick instantly override the manual pick.
            lastCycleIndex = (int)((getSynchronizedTime() / cycleIntervalMs) % (unsigned long)libOrder.size());
        }
        patternSaveIsLib = readPatternLibFlag(buf, size, true); // read before ownership transfer
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
        if (patternSaveBuf && patternSaveSize > 0) {
            // Always persist the last-shown pattern as the boot/current pattern (survives
            // power-off), whether or not it's cycled.
            saveBootCurrent(patternSaveBuf, patternSaveSize);
            // Only a deliberate "sync" (lib=true) adds it to the cycled library. A Live push
            // (lib=false) stays current-only, so trying a pattern never pollutes the cycle.
            if (patternSaveIsLib && patternSaveName.length() > 0) {
                if (libUpsert(patternSaveName, patternSaveBuf, patternSaveSize)) {
                    libSaveCurrentName(patternSaveName);
                }
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

    // Rare, user-initiated, and it rebuilds every strip and every render buffer — exactly
    // the shape Operation is for. Closes (and sends) when this function returns.
    SentryReporting::Operation trace("led config", "device.config.led");
    auto *apply = trace.child("ledconfig.apply");
    trace.set(apply, "payload_bytes", (int64_t)ledConfigBufferSize);
    trace.set(apply, "free_heap", (int64_t)ESP.getFreeHeap());

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
                        } else if (strcmp(strip_key, "clk") == 0) {
                            stripConfig.clockPin = mpack_expect_u8(&reader);
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
                        } else if (strcmp(strip_key, "de") == 0) {
                            stripConfig.ditherEnable = mpack_expect_bool(&reader);
                        } else if (strcmp(strip_key, "aw") == 0) {
                            stripConfig.autoWhiteMode = mpack_expect_u8(&reader);
                        } else if (strcmp(strip_key, "wc") == 0) {
                            uint32_t wc = mpack_expect_u32(&reader);
                            stripConfig.wLedR = (wc >> 16) & 0xFF;
                            stripConfig.wLedG = (wc >> 8) & 0xFF;
                            stripConfig.wLedB = wc & 0xFF;
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

// Respond to a LIBRARY_DUMP request: NOTIFY every stored pattern's MessagePack back to the app,
// framed [u8 idx][u16 totalLen LE][u16 offset LE][bytes], then a done sentinel idx=0xFF. Runs
// from loop() (file IO off the BLE task). The msgpack already carries meta.name, so the file's
// name header is skipped.
void processLibraryDumpRequest() {
    if (!libraryDumpRequest || !pLibraryDumpCharacteristic) return;
    libraryDumpRequest = false;
    const size_t CH = 180;
    size_t sent = 0;
    for (size_t i = 0; i < libNames.size() && i < 255; i++) {
        File f = LittleFS.open(libPath((int)i), FILE_READ);
        if (!f) continue;
        if (f.available() < 2) { f.close(); continue; }
        uint8_t lo = (uint8_t)f.read(), hi = (uint8_t)f.read();
        uint16_t nameLen = (uint16_t)lo | ((uint16_t)hi << 8);
        size_t total = f.size();
        if (total <= (size_t)(2 + nameLen)) { f.close(); continue; }
        size_t mpLen = total - (2 + nameLen);
        if (mpLen > 16384) { f.close(); continue; }
        f.seek(2 + nameLen);
        uint8_t* data = (uint8_t*)malloc(mpLen);
        if (!data) { f.close(); continue; }
        bool ok = (f.readBytes((char*)data, mpLen) == mpLen);
        f.close();
        if (!ok) { free(data); continue; }
        for (size_t off = 0; off < mpLen; off += CH) {
            size_t n = (mpLen - off < CH) ? (mpLen - off) : CH;
            uint8_t frame[5 + 180];
            frame[0] = (uint8_t)i;
            frame[1] = mpLen & 0xFF; frame[2] = (mpLen >> 8) & 0xFF;
            frame[3] = off & 0xFF;   frame[4] = (off >> 8) & 0xFF;
            memcpy(frame + 5, data + off, n);
            pLibraryDumpCharacteristic->setValue(frame, 5 + n);
            pLibraryDumpCharacteristic->notify();
            delay(8);
        }
        free(data);
        sent++;
    }
    uint8_t done[5] = {0xFF, 0, 0, 0, 0};
    pLibraryDumpCharacteristic->setValue(done, 5);
    pLibraryDumpCharacteristic->notify();
    Serial.printf("[LibDump] sent %u/%u patterns\n", (unsigned)sent, (unsigned)libNames.size());
}

// Apply a staged library command (clear / delete-by-name) on the loop task.
void processLibraryCommand() {
    if (!newLibCmdAvailable) return;
    newLibCmdAvailable = false;
    size_t n = libCmdLen;
    if (n < 1) return;
    uint8_t op = libCmdBuf[0];
    if (op == 0x00) {
        libClear();
    } else if (op == 0x01 && n > 1) {
        String name;
        for (size_t i = 1; i < n; i++) name += (char)libCmdBuf[i];
        libDelete(name);
    }
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
            else if (calibMode == 2) on = true;         // steady ALL-ON (detection: tune exposure)
            else if (calibMode == 0) on = (frame == 1); // strobe: 0=off, 1=on
            else if (frame == 0) on = true;             // full: ALL-ON reference + sync anchor
            else on = ((i >> (frame - 1)) & 1u) != 0;   // full: bit (frame-1) of the LED index
            uint8_t b = calibBrightness;
            st->setPixelColor(i, on ? CRGB(b, b, b) : CRGB(0, 0, 0));
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

    // Still verifying: enforce the 30s timeout, otherwise keep waiting. An unsigned
    // finalize has no verification task, so there's nothing to wait on — fall straight through.
    if (!ota_skip_signature && !signature_verification_complete) {
        if (millis() - ota_finalize_start_ms >= 30000) {
            Serial.println("OTA Error: Signature verification timed out!");
            if (pOTAStatusCharacteristic) {
                const char* msg = "OTA_ERR_SIG_TIMEOUT";
                pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
                pOTAStatusCharacteristic->notify();
            }
            SentryReporting::otaFinish(false);
            esp_ota_abort(ota_handle);
            ota_finalizing = false;
            ota_in_progress = false;
            ota_handle = 0;
            ota_received_size = 0;
            signature_received = false;
        }
        return;
    }

    // Verification finished (or skipped) — we own the finalize from here.
    ota_finalizing = false;

    if (!ota_skip_signature && !signature_verification_result) {
        Serial.println("OTA Error: Firmware signature verification FAILED!");
        if (pOTAStatusCharacteristic) {
            const char* msg = "OTA_ERR_SIG_INVALID";
            pOTAStatusCharacteristic->setValue((uint8_t*)msg, strlen(msg));
            pOTAStatusCharacteristic->notify();
        }
        SentryReporting::otaFinish(false);
        esp_ota_abort(ota_handle);
        ota_in_progress = false;
        ota_handle = 0;
        ota_received_size = 0;
        signature_received = false;
        ota_skip_signature = false;
        return;
    }

    if (ota_skip_signature) {
        Serial.println("OTA: Finalizing WITHOUT signature verification (unsigned upload).");
    } else {
        Serial.println("OTA: Firmware signature verification PASSED.");
    }
    Serial.printf("OTA End command received. Finalizing update... (Total received: %d bytes)\n", ota_received_size);

    SentryReporting::otaPhase("ota.finalize");
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
            // Before the reboot, not after: a restart is not a flush, and this transaction
            // is the record of the update that just succeeded.
            SentryReporting::otaFinish(true);
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
    SentryReporting::otaFinish(false);
    ota_in_progress = false;
    ota_handle = 0;
    ota_received_size = 0;
    signature_received = false;
    ota_skip_signature = false;
}

// pushCRGBToStrip function removed - pattern renderer handles LED output directly

// ===================================================================================
// Device settings (COMM_CONFIG) + WiFi/TCP transport
// ===================================================================================

// Current settings as JSON (for a COMM_CONFIG read). Password is intentionally omitted.
static String commSettingsJson() {
    String j = "{";
    j += "\"mode\":\"" + String(gSettings.commMode == DeviceSettings::COMM_WIFI ? "wifi" : "ble") + "\",";
    j += "\"ssid\":\"" + gSettings.wifiSsid + "\",";
    j += "\"hasPass\":" + String(gSettings.wifiPass.length() > 0 ? 1 : 0) + ",";
    j += "\"fallback\":" + String(gSettings.wifiFallback) + ",";
    j += "\"sleep\":" + String(gSettings.sleepMinutes) + ",";
    j += "\"rgbtest\":" + String(gSettings.rgbTest ? 1 : 0) + ",";
    j += "\"rtproto\":" + String(gSettings.rtProto) + ",";
    j += "\"rtuni\":" + String(gSettings.rtUniverse) + ",";
    j += "\"rtto\":" + String(gSettings.rtTimeoutSec) + ",";
    j += "\"rtlayout\":" + String(gSettings.rtLayout ? 1 : 0) + ",";
    j += "\"sen\":" + String(gSettings.schedEnable ? 1 : 0) + ",";
    j += "\"son\":" + String(gSettings.schedOnMin) + ",";
    j += "\"sof\":" + String(gSettings.schedOffMin) + ",";
    j += "\"tz\":" + String(gSettings.tzOffsetMin) + ",";
    j += "\"sdw\":" + String(gSettings.schedDays) + ",";
    j += "\"clk\":" + String(gClockValid ? 1 : 0) + ",";  // 1 = device knows the wall-clock time
    j += "\"mode_active\":\"" + String(gWifiMode ? "wifi" : "ble") + "\"";
#if CHROMABAY_WIFI
    if (gWifiMode) j += ",\"ip\":\"" + WiFi.localIP().toString() + "\"";
#endif
    j += "}";
    return j;
}

// Stage a COMM_CONFIG write (msgpack map, keys optional: mode/ssid/pass/fallback/sleep/
// rgbtest) for the loop task. Copies the bytes; loop drains via processCommConfig().
static void stageCommConfig(const uint8_t* data, size_t len) {
    if (!data || len == 0 || len > 512) return;
    noteActivity();
    if (commCfgBuf) { free(commCfgBuf); commCfgBuf = nullptr; commCfgLen = 0; }
    commCfgBuf = (uint8_t*)malloc(len);
    if (!commCfgBuf) return;
    memcpy(commCfgBuf, data, len);
    commCfgLen = len;
    newCommCfgAvailable = true;
}

// Apply a staged COMM_CONFIG patch on the loop task. Updates gSettings, persists to NVS,
// and reboots if the active transport must change (mode or WiFi creds). Live-applies
// sleep/rgbtest without a reboot.
void processCommConfig() {
    if (!newCommCfgAvailable) return;
    newCommCfgAvailable = false;

    // Settings writes: WiFi credentials, transport mode, schedule, sleep. Rare, and some of
    // them reboot the device, so this is the last thing measured before that happens.
    SentryReporting::Operation trace("device settings", "device.config.settings");
    auto *apply = trace.child("settings.apply");
    uint8_t* buf = commCfgBuf; size_t len = commCfgLen;
    commCfgBuf = nullptr; commCfgLen = 0;
    if (!buf) return;

    uint8_t  oldMode = gSettings.commMode;
    String   oldSsid = gSettings.wifiSsid;
    String   oldPass = gSettings.wifiPass;

    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char*)buf, len);
    mpack_tree_parse(&tree);
    mpack_node_t root = mpack_tree_root(&tree);
    if (mpack_tree_error(&tree) == mpack_ok && mpack_node_type(root) == mpack_type_map) {
        size_t n = mpack_node_map_count(root);
        for (size_t i = 0; i < n; i++) {
            char key[16];
            mpack_node_copy_cstr(mpack_node_map_key_at(root, i), key, sizeof(key));
            mpack_node_t v = mpack_node_map_value_at(root, i);
            if (mpack_tree_error(&tree) != mpack_ok) break;
            if (strcmp(key, "mode") == 0) {
                char m[8] = {0}; mpack_node_copy_cstr(v, m, sizeof(m));
                gSettings.commMode = (strcmp(m, "wifi") == 0) ? DeviceSettings::COMM_WIFI : DeviceSettings::COMM_BLE;
            } else if (strcmp(key, "ssid") == 0) {
                char s[48] = {0}; mpack_node_copy_cstr(v, s, sizeof(s)); gSettings.wifiSsid = String(s);
            } else if (strcmp(key, "pass") == 0) {
                char s[72] = {0}; mpack_node_copy_cstr(v, s, sizeof(s)); gSettings.wifiPass = String(s);
            } else if (strcmp(key, "fallback") == 0) {
                gSettings.wifiFallback = (uint8_t)mpack_node_u8(v);
            } else if (strcmp(key, "sleep") == 0) {
                gSettings.sleepMinutes = (uint16_t)mpack_node_u16(v);
            } else if (strcmp(key, "rgbtest") == 0) {
                gSettings.rgbTest = mpack_node_bool(v);
            } else if (strcmp(key, "rtproto") == 0) {
                gSettings.rtProto = (uint8_t)mpack_node_u8(v);
            } else if (strcmp(key, "rtuni") == 0) {
                gSettings.rtUniverse = (uint16_t)mpack_node_u16(v);
            } else if (strcmp(key, "rtto") == 0) {
                gSettings.rtTimeoutSec = (uint16_t)mpack_node_u16(v);
            } else if (strcmp(key, "rtlayout") == 0) {
                gSettings.rtLayout = mpack_node_bool(v);
            } else if (strcmp(key, "sen") == 0) {
                gSettings.schedEnable = mpack_node_bool(v);
            } else if (strcmp(key, "son") == 0) {
                gSettings.schedOnMin = (uint16_t)mpack_node_u16(v);
            } else if (strcmp(key, "sof") == 0) {
                gSettings.schedOffMin = (uint16_t)mpack_node_u16(v);
            } else if (strcmp(key, "tz") == 0) {
                gSettings.tzOffsetMin = (int16_t)mpack_node_i16(v);
            } else if (strcmp(key, "sdw") == 0) {
                gSettings.schedDays = (uint8_t)mpack_node_u8(v);
            }
        }
    } else {
        Serial.println("[CommConfig] bad msgpack patch");
    }
    mpack_tree_destroy(&tree);
    free(buf);

    DeviceSettings::save(gSettings);
    noteActivity(); // settings change wakes/refreshes the sleep timer too

    bool transportChanged = (gSettings.commMode != oldMode) ||
                            (gSettings.commMode == DeviceSettings::COMM_WIFI &&
                             (gSettings.wifiSsid != oldSsid || gSettings.wifiPass != oldPass));
#if CHROMABAY_WIFI
    if (transportChanged) {
        Serial.println("[CommConfig] transport change → rebooting in 400ms");
        delay(400); // give the BLE/TCP ack a moment to flush
        ESP.restart();
    }
#else
    (void)transportChanged; // no WiFi in this build — mode/creds saved but not acted on
#endif
}

// COMM_CONFIG BLE characteristic: read returns settings JSON; write stages an msgpack patch.
class CommConfigCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic) {
        String j = commSettingsJson();
        pCharacteristic->setValue((uint8_t*)j.c_str(), j.length());
    }
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string v = pCharacteristic->getValue();
        if (!v.empty()) stageCommConfig((const uint8_t*)v.data(), v.length());
    }
};

#if CHROMABAY_WIFI
// ---- TCP transport --------------------------------------------------------------------
// Framed protocol: [u8 channel][u32 len LE][payload]. Channels mirror BLE characteristics.
enum TcpChannel : uint8_t {
    CH_DEVICE_INFO    = 1,  // req(empty) → JSON reply
    CH_LED_CONFIG_GET = 2,  // req(empty) → mpack reply
    CH_LED_CONFIG_SET = 3,  // mpack payload
    CH_BRIGHTNESS     = 4,  // 1 byte (write); empty req → 1-byte reply
    CH_PATTERN_SYNC   = 5,  // full pattern msgpack (no chunk header over TCP)
    CH_PLAYLIST_SYNC  = 6,  // [u32 intervalMs LE][u8 enabled]
    CH_TIMESTAMP_SYNC = 7,  // [u64 ms LE]
    CH_LIBRARY_CMD    = 8,  // [op][payload]
    CH_LIBRARY_DUMP   = 9,  // req(empty) → one frame per pattern: [name\0][mpack]; then empty frame = done
    CH_DEVICE_NAME    = 10, // write utf8 name; empty req → name reply
    CH_COMM_CONFIG    = 11, // write mpack patch; empty req → settings JSON reply
    CH_SENTRY_RELAY   = 12, // crash-report relay frames, both directions (see sentry_reporting.h)
    CH_SENTRY_CONFIG  = 13, // write the DSN the device reports to
};

// WebSocket control transport (hand-rolled over WiFiServer — the browser can only speak
// WebSocket, and iOS's webview does too with no native plugin). Each WS binary message is
// [u8 channel][payload]; WS gives message boundaries so there's no length prefix. The channel
// dispatch is identical to the old raw-TCP version.
namespace WifiLink {
    static WiFiServer server(CHROMABAY_TCP_PORT);
    static WiFiClient client;
    static bool wsReady = false;               // HTTP→WS handshake done for `client`
    static std::vector<uint8_t> rx;            // raw inbound bytes (handshake text, then WS frames)
    static std::vector<uint8_t> msg;           // reassembled WS message payload (across fragments)
    static const size_t MAX_FRAME = 64 * 1024;

    // Send a WS binary frame (server→client: unmasked, opcode 0x2).
    static void wsSendBinary(const uint8_t* data, size_t len) {
        if (!client || !client.connected()) return;
        uint8_t hdr[10]; size_t h = 0;
        hdr[0] = 0x82; // FIN + binary
        if (len < 126) { hdr[1] = (uint8_t)len; h = 2; }
        else if (len <= 0xFFFF) { hdr[1] = 126; hdr[2] = (len >> 8) & 0xFF; hdr[3] = len & 0xFF; h = 4; }
        else { hdr[1] = 127; for (int i = 0; i < 8; i++) hdr[2 + i] = (uint8_t)((uint64_t)len >> (8 * (7 - i))); h = 10; }
        client.write(hdr, h);
        if (len && data) client.write(data, len);
    }
    // A control message is [u8 channel][payload]; wrap it in one WS binary frame.
    static void sendFrame(uint8_t channel, const uint8_t* data, uint32_t len) {
        static std::vector<uint8_t> buf;
        buf.clear(); buf.reserve(1 + len);
        buf.push_back(channel);
        if (len && data) buf.insert(buf.end(), data, data + len);
        wsSendBinary(buf.data(), buf.size());
    }
    static void sendStr(uint8_t channel, const String& s) {
        sendFrame(channel, (const uint8_t*)s.c_str(), s.length());
    }
    // True when a WS client is connected + handshaked — safe to push unsolicited frames.
    inline bool clientReady() { return wsReady && client && client.connected(); }
    // Push a brightness update to the connected WS client (mirror of the BLE notify).
    inline void pushBrightness(uint8_t b) { if (clientReady()) sendFrame(CH_BRIGHTNESS, &b, 1); }

    // Hand a crash-relay frame to the app over Wi-Fi — the mirror of notifying the BLE TX
    // characteristic. Registered with SentryReporting as a function pointer at startup;
    // returning false tells the relay the host is gone, which keeps the report buffered.
    static bool sendSentryFrame(const uint8_t* frame, size_t len) {
        if (!clientReady()) return false;
        sendFrame(CH_SENTRY_RELAY, frame, (uint32_t)len);
        return true;
    }

    // Stream the stored library: one frame per pattern on CH_LIBRARY_DUMP, payload =
    // NUL-terminated name followed by the raw pattern msgpack; an empty frame signals done.
    static void dumpLibrary() {
        for (size_t i = 0; i < libNames.size() && i < 255; i++) {
            File f = LittleFS.open(libPath((int)i), FILE_READ);
            if (!f) continue;
            if (f.available() < 2) { f.close(); continue; }
            uint8_t lo = (uint8_t)f.read(), hi = (uint8_t)f.read();
            uint16_t nameLen = (uint16_t)lo | ((uint16_t)hi << 8);
            size_t total = f.size();
            if (total <= (size_t)(2 + nameLen)) { f.close(); continue; }
            size_t mpLen = total - (2 + nameLen);
            if (mpLen > MAX_FRAME) { f.close(); continue; }
            // name
            char nameBuf[64]; size_t nb = nameLen < sizeof(nameBuf) - 1 ? nameLen : sizeof(nameBuf) - 1;
            f.readBytes(nameBuf, nb); nameBuf[nb] = 0;
            if (nameLen > nb) f.seek(2 + nameLen); // skip any overflow
            uint8_t* mp = (uint8_t*)malloc(mpLen);
            if (!mp) { f.close(); continue; }
            bool ok = (f.readBytes((char*)mp, mpLen) == mpLen);
            f.close();
            if (!ok) { free(mp); continue; }
            // frame = name + '\0' + mpack
            size_t frameLen = nb + 1 + mpLen;
            uint8_t* frame = (uint8_t*)malloc(frameLen);
            if (frame) {
                memcpy(frame, nameBuf, nb); frame[nb] = 0; memcpy(frame + nb + 1, mp, mpLen);
                sendFrame(CH_LIBRARY_DUMP, frame, frameLen);
                free(frame);
            }
            free(mp);
        }
        sendFrame(CH_LIBRARY_DUMP, nullptr, 0); // done
    }

    static void dispatch(uint8_t ch, const uint8_t* p, uint32_t len) {
        noteActivity();
        switch (ch) {
            case CH_DEVICE_INFO: sendStr(CH_DEVICE_INFO, buildDeviceInfoJson()); break;
            case CH_LED_CONFIG_GET: {
                size_t sz = 0; uint8_t* b = serializeLedConfigMpack(&sz);
                if (b) { sendFrame(CH_LED_CONFIG_GET, b, sz); free(b); }
                break;
            }
            case CH_LED_CONFIG_SET: stageLedConfigBytes(p, len); break;
            case CH_BRIGHTNESS:
                if (len >= 1) { pendingBrightness = p[0]; newBrightnessAvailable = true; }
                else { uint8_t b = ledMgr.getGlobalBrightness(); sendFrame(CH_BRIGHTNESS, &b, 1); }
                break;
            case CH_PATTERN_SYNC: {
                if (len == 0 || len > MAX_FRAME) break;
                uint8_t* full = (uint8_t*)malloc(len);
                if (full) { memcpy(full, p, len); stageCompletePattern(full, len); }
                break;
            }
            case CH_PLAYLIST_SYNC:
                if (len >= 5) { memcpy(&pendingCycleIntervalMs, p, 4); pendingCycleEnabled = (p[4] != 0); newCycleControlAvailable = true; }
                break;
            case CH_TIMESTAMP_SYNC:
                // [u64 frame-clock ms][u64 wall-epoch ms(optional)] — see the BLE handler.
                if (len >= 8) {
                    uint64_t frameMs = 0; memcpy(&frameMs, p, 8);
                    syncedTimestampMs = (unsigned long)frameMs; syncedLocalTime = millis(); timestampSynced = true;
                    if (patternRenderer) patternRenderer->setSynchronizedTime(syncedTimestampMs, syncedLocalTime);
                    if (len >= 16) {
                        uint64_t epochMs = 0; memcpy(&epochMs, p + 8, 8);
                        if (epochMs > 1704067200000ULL) {
                            syncedEpochMs = epochMs; syncedEpochLocalMs = (uint32_t)syncedLocalTime;
                            struct timeval tv = { (time_t)(epochMs / 1000ULL), (suseconds_t)((epochMs % 1000ULL) * 1000ULL) };
                            settimeofday(&tv, nullptr);
                        }
                    }
                }
                break;
            case CH_LIBRARY_CMD: {
                size_t n = len > sizeof(libCmdBuf) ? sizeof(libCmdBuf) : len;
                memcpy(libCmdBuf, p, n); libCmdLen = n; newLibCmdAvailable = true;
                break;
            }
            case CH_LIBRARY_DUMP: dumpLibrary(); break;
            case CH_DEVICE_NAME:
                if (len > 0) { pendingDeviceName = String(); for (uint32_t i = 0; i < len; i++) pendingDeviceName += (char)p[i]; deviceNamePending = true; }
                else sendStr(CH_DEVICE_NAME, deviceName);
                break;
            case CH_COMM_CONFIG:
                if (len > 0) stageCommConfig(p, len);
                else sendStr(CH_COMM_CONFIG, commSettingsJson());
                break;
            // Same two handlers the BLE characteristics call — the relay protocol and the
            // DSN host check live in sentry_reporting.h and are not reimplemented here.
            case CH_SENTRY_RELAY:  SentryReporting::onHostFrame(p, len); break;
            case CH_SENTRY_CONFIG: SentryReporting::onConfigWrite(p, len); break;
            default: Serial.printf("[TCP] unknown channel %u\n", ch); break;
        }
    }

    // Complete the HTTP→WebSocket upgrade once the request headers are fully buffered in `rx`.
    static void doHandshake() {
        // Find end of headers. (The request is small text; rx has no binary yet.)
        int end = -1;
        for (size_t i = 0; i + 3 < rx.size(); i++)
            if (rx[i]=='\r' && rx[i+1]=='\n' && rx[i+2]=='\r' && rx[i+3]=='\n') { end = (int)i; break; }
        if (end < 0) { if (rx.size() > 4096) { client.stop(); rx.clear(); } return; } // wait / cap
        String req((const char*)rx.data(), end);
        int ki = req.indexOf("Sec-WebSocket-Key:");
        if (ki < 0) ki = req.indexOf("sec-websocket-key:"); // header names are case-insensitive
        if (ki < 0) { Serial.println("[WS] no Sec-WebSocket-Key; closing"); client.stop(); rx.clear(); return; }
        ki += 18; while (ki < (int)req.length() && (req[ki]==' ')) ki++;
        int ke = req.indexOf("\r\n", ki); if (ke < 0) ke = req.length();
        String key = req.substring(ki, ke); key.trim();
        String magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        uint8_t sha[20];
        mbedtls_sha1((const uint8_t*)magic.c_str(), magic.length(), sha);
        unsigned char b64[32]; size_t olen = 0;
        mbedtls_base64_encode(b64, sizeof(b64), &olen, sha, 20);
        String accept = String((const char*)b64).substring(0, olen);
        String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        client.write((const uint8_t*)resp.c_str(), resp.length());
        rx.erase(rx.begin(), rx.begin() + end + 4); // keep any WS bytes already after the headers
        msg.clear(); wsReady = true; deviceConnected = true; noteActivity();
        // The app is reachable: a crash queued from a previous boot can go out now. (It still
        // has to send HELLO before anything is relayed — this only says the pipe exists.)
        SentryReporting::setWifiConnected(true);
        Serial.printf("[WS] handshake OK: %s\n", client.remoteIP().toString().c_str());
    }

    // Parse buffered WS frames; dispatch each complete (FIN) data message. Client→server
    // frames are always masked; we unmask into `msg` and handle continuation/ping/close.
    static void parseFrames() {
        size_t pos = 0;
        while (rx.size() - pos >= 2) {
            uint8_t b0 = rx[pos], b1 = rx[pos + 1];
            bool fin = b0 & 0x80; uint8_t op = b0 & 0x0F; bool masked = b1 & 0x80;
            uint64_t len = b1 & 0x7F; size_t hp = pos + 2;
            if (len == 126) { if (rx.size() - pos < 4) break; len = ((uint64_t)rx[hp] << 8) | rx[hp+1]; hp += 2; }
            else if (len == 127) { if (rx.size() - pos < 10) break; len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | rx[hp+i]; hp += 8; }
            uint8_t mask[4] = {0,0,0,0};
            if (masked) { if (rx.size() < hp + 4) break; for (int i = 0; i < 4; i++) mask[i] = rx[hp+i]; hp += 4; }
            if (len > MAX_FRAME) { client.stop(); rx.clear(); msg.clear(); return; }
            if (rx.size() - hp < len) break; // wait for full payload
            if (op == 0x8) { client.stop(); return; } // close
            if (op == 0x9) { // ping → pong (echo payload, unmasked)
                std::vector<uint8_t> p; for (uint64_t i = 0; i < len; i++) p.push_back(masked ? (rx[hp+i]^mask[i&3]) : rx[hp+i]);
                uint8_t ph[2] = { 0x8A, (uint8_t)p.size() }; client.write(ph, 2); if (p.size()) client.write(p.data(), p.size());
            } else if (op == 0x0 || op == 0x1 || op == 0x2) { // continuation / text / binary
                for (uint64_t i = 0; i < len; i++) msg.push_back(masked ? (rx[hp+i]^mask[i&3]) : rx[hp+i]);
                if (fin) { if (msg.size() >= 1) dispatch(msg[0], msg.data()+1, (uint32_t)(msg.size()-1)); msg.clear(); }
            }
            pos = hp + len;
        }
        if (pos > 0) rx.erase(rx.begin(), rx.begin() + pos);
    }

    // Connect STA (or fall back to SoftAP) and start the WebSocket server + mDNS. Returns true
    // if we are serving over WiFi. On STA failure with FB_BLE, returns false so the caller
    // starts BLE for this boot instead (so the user can always get back in and fix creds).
    static bool startAp() {
        String ap = deviceName.length() ? deviceName : String("ChromaBay");
        Serial.printf("[WiFi] SoftAP '%s' (join it, then reach 192.168.4.1:%d)\n", ap.c_str(), CHROMABAY_TCP_PORT);
        WiFi.mode(WIFI_AP);
        return WiFi.softAP(ap.c_str()); // open network
    }

    static bool begin() {
        // No SSID: only useful as an AP (else fall back to BLE so the user can provision).
        if (gSettings.wifiSsid.length() == 0) {
            if (gSettings.wifiFallback == DeviceSettings::FB_AP) { if (!startAp()) return false; }
            else { Serial.println("[WiFi] no SSID set → BLE fallback"); return false; }
        } else {
            Serial.printf("[WiFi] connecting to '%s' ...\n", gSettings.wifiSsid.c_str());
            WiFi.mode(WIFI_STA);
            WiFi.setSleep(false); // lower latency / fewer stalls for the control link
            WiFi.begin(gSettings.wifiSsid.c_str(), gSettings.wifiPass.c_str());
            uint32_t start = millis();
            while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) { delay(200); Serial.print('.'); }
            Serial.println();
            if (WiFi.status() != WL_CONNECTED) {
                if (gSettings.wifiFallback == DeviceSettings::FB_AP) {
                    Serial.println("[WiFi] STA failed → SoftAP");
                    if (!startAp()) return false;
                } else {
                    Serial.println("[WiFi] STA failed → reverting to BLE this boot");
                    WiFi.mode(WIFI_OFF);
                    return false;
                }
            } else {
                Serial.printf("[WiFi] connected: %s\n", WiFi.localIP().toString().c_str());
                // Start SNTP so the device learns the time on its own (no app needed) — this
                // is what lets a WiFi-only device run the on/off schedule after a power loss.
                // UTC (offset 0); we apply the timezone offset ourselves for the schedule.
                configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");
            }
        }
        server.begin();
        server.setNoDelay(true);
        // mDNS: advertise _chromabay._tcp so the app can discover us without a fixed IP,
        // and resolve <host>.local. Sanitize the name to a valid DNS label (lowercase,
        // [a-z0-9-], no leading/trailing hyphen) so e.g. "ChromaBay ED30" → chromabay-ed30.local.
        String host;
        for (size_t i = 0; i < deviceName.length(); i++) {
            char c = deviceName[i];
            if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) host += c;
            else if (c == ' ' || c == '_' || c == '-') { if (host.length() && host[host.length()-1] != '-') host += '-'; }
        }
        while (host.length() && host[host.length()-1] == '-') host.remove(host.length()-1);
        if (host.length() == 0) host = "chromabay";
        if (MDNS.begin(host.c_str())) {
            MDNS.addService("chromabay", "tcp", CHROMABAY_TCP_PORT);
            MDNS.addServiceTxt("chromabay", "tcp", "name", deviceName.c_str());
            MDNS.addServiceTxt("chromabay", "tcp", "chip", chipModelName());
            Serial.printf("[WiFi] mDNS: %s.local  service _chromabay._tcp:%d\n", host.c_str(), CHROMABAY_TCP_PORT);
        }
        return true;
    }

    // Poll from loop(): accept one client, buffer inbound bytes, then run the WS handshake
    // (once) and dispatch any complete frames.
    static void tick() {
        if (server.hasClient()) {
            WiFiClient nc = server.available();
            if (nc) {
                if (client && client.connected()) { nc.stop(); } // one client at a time
                else { client = nc; client.setNoDelay(true); rx.clear(); msg.clear(); wsReady = false;
                       SentryReporting::setWifiConnected(false);  // not until the handshake
                       Serial.printf("[WS] TCP client %s\n", client.remoteIP().toString().c_str()); }
            }
        }
        if (!client || !client.connected()) {
            if (deviceConnected && gWifiMode) { deviceConnected = false; wsReady = false; }
            SentryReporting::setWifiConnected(false);
            return;
        }
        int av = client.available();
        while (av > 0) {
            uint8_t b[512]; int n = client.read(b, sizeof(b));
            if (n <= 0) break;
            rx.insert(rx.end(), b, b + n);
            if (rx.size() > MAX_FRAME + 64) { client.stop(); rx.clear(); msg.clear(); return; }
            av = client.available();
        }
        if (!wsReady) doHandshake();
        if (wsReady) parseFrames();
    }
} // namespace WifiLink

// ---- Art-Net / sACN realtime pixel streaming ------------------------------------------
// Listens for DMX-over-Ethernet and drives pixels directly, taking over from the pattern
// renderer while packets arrive and reverting after gSettings.rtTimeoutSec of silence.
// Opt-in (rtProto != RT_OFF) and WiFi-only, so it's completely inert by default.
namespace RtStream {
    static WiFiUDP artnet, sacn;
    static bool started = false;
    static uint8_t buf[640]; // sACN max ≈ 126 + 512; Art-Net ≈ 18 + 512
    static const uint32_t PX_PER_UNIVERSE = 170; // 512 DMX channels / 3 (RGB)

    // sACN multicast group for a 1-based universe: 239.255.<hi>.<lo>.
    static IPAddress sacnGroup(uint16_t universe) { return IPAddress(239, 255, (universe >> 8) & 0xFF, universe & 0xFF); }

    static void begin() {
        uint8_t proto = gSettings.rtProto;
        if (proto == DeviceSettings::RT_ARTNET || proto == DeviceSettings::RT_BOTH) artnet.begin(6454);
        if (proto == DeviceSettings::RT_SACN   || proto == DeviceSettings::RT_BOTH) {
            // Join a small window of universes starting at rtUniverse so multi-universe rigs work.
            uint16_t u0 = gSettings.rtUniverse == 0 ? 1 : gSettings.rtUniverse;
            for (uint16_t u = u0; u < u0 + 8; u++) sacn.beginMulticast(sacnGroup(u), 5568);
        }
        started = true;
        Serial.printf("[RtStream] started proto=%u universe=%u timeout=%us layout=%u\n",
                      proto, gSettings.rtUniverse, gSettings.rtTimeoutSec, gSettings.rtLayout);
    }

    // Set one streamed pixel (global index across strips), honoring physical-vs-layout mode.
    static inline void setGlobalPixel(uint32_t g, uint8_t r, uint8_t gc, uint8_t b) {
        for (size_t s = 0; s < ledMgr.getNumStrips(); s++) {
            LedConfig::LedBus* strip = ledMgr.getStrip((uint8_t)s);
            if (!strip) continue;
            bool useLayout = gSettings.rtLayout && strip->hasLayout();
            uint32_t span = useLayout ? (uint32_t)strip->layoutWidth() * strip->layoutHeight() : strip->getLength();
            if (g < span) {
                int phys = useLayout ? strip->layoutLedAt(g) : (int)g;
                if (phys >= 0) ledMgr.setPixelColor((uint8_t)s, (uint16_t)phys, CRGB(r, gc, b));
                return;
            }
            g -= span;
        }
    }

    static void applyDmx(uint16_t universe, const uint8_t* dmx, uint16_t len) {
        if (universe < gSettings.rtUniverse) return;
        uint32_t base = (uint32_t)(universe - gSettings.rtUniverse) * PX_PER_UNIVERSE;
        uint16_t px = len / 3;
        for (uint16_t p = 0; p < px; p++) setGlobalPixel(base + p, dmx[p*3], dmx[p*3+1], dmx[p*3+2]);
    }

    // Poll from loop() (WiFi mode). Lazily opens sockets so enabling streaming via settings
    // takes effect without a reboot. Returns having applied any packets + refreshed the timeout.
    static void tick() {
        if (gSettings.rtProto == DeviceSettings::RT_OFF) return;
        if (!started) begin();
        bool got = false;
        int n;
        while ((n = artnet.parsePacket()) > 0) {
            int r = artnet.read(buf, sizeof(buf));
            if (r >= 18 && memcmp(buf, "Art-Net", 7) == 0) {
                uint16_t op = (uint16_t)buf[8] | ((uint16_t)buf[9] << 8);
                if (op == 0x5000) { // OpDmx
                    uint16_t uni  = (uint16_t)buf[14] | ((uint16_t)buf[15] << 8);
                    uint16_t dlen = ((uint16_t)buf[16] << 8) | buf[17]; // big-endian
                    if (dlen > (uint16_t)(r - 18)) dlen = r - 18;
                    applyDmx(uni, buf + 18, dlen);
                    got = true;
                }
            }
        }
        while ((n = sacn.parsePacket()) > 0) {
            int r = sacn.read(buf, sizeof(buf));
            // E1.31: ACN PID at offset 4; universe at 113-114; DMP property count at 123-124
            // (includes the 1-byte DMX start code at 125); channel data at 126.
            if (r >= 126 && memcmp(buf + 4, "ASC-E1.17", 9) == 0) {
                uint16_t uni  = ((uint16_t)buf[113] << 8) | buf[114];
                uint16_t pcnt = ((uint16_t)buf[123] << 8) | buf[124];
                uint16_t dlen = pcnt > 0 ? pcnt - 1 : 0;
                if (dlen > (uint16_t)(r - 126)) dlen = r - 126;
                applyDmx(uni, buf + 126, dlen);
                got = true;
            }
        }
        if (got) {
            ledMgr.show();
            gRealtimeUntilMs = millis() + (uint32_t)gSettings.rtTimeoutSec * 1000u;
            noteActivity();
        }
    }
} // namespace RtStream
#endif // CHROMABAY_WIFI

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.printf("ChromaBay %s starting (hardware %s)\n", FIRMWARE_VERSION, HARDWARE_VERSION);

    // Load device settings (comm mode / WiFi creds / sleep timer / rgb-test) from NVS.
    gSettings = DeviceSettings::load();
    gLastActivityMs = millis();
    Serial.printf("Settings: mode=%s ssid='%s' sleep=%umin rgbtest=%u\n",
                  gSettings.commMode == DeviceSettings::COMM_WIFI ? "wifi" : "ble",
                  gSettings.wifiSsid.c_str(), gSettings.sleepMinutes, gSettings.rgbTest);

    // --- Boot-time firmware state check ---
    Serial.printf("Firmware version: %s (feat %d)\n", FIRMWARE_VERSION, FIRMWARE_FEATURES);

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

    // Crash reporting. Started here rather than earlier because its offline buffer lives on
    // the filesystem: a device in BLE mode has no route to the internet at boot, so the report
    // of the crash it just came back from waits on flash until the app connects (or WiFi
    // associates) and tick() can deliver it. Inert unless a DSN has been provisioned.
    SentryReporting::begin();
    SentryReporting::reportLastBoot();

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

    // Never boot dark: a device that was switched off — which is brightness 0 — would come
    // back from a power cut looking broken rather than off. Restore the last level it was
    // actually on at, exactly as the schedule's auto-on does, and fall back to the floor only
    // when there has never been one.
    //
    // Only 0 counts as dark. This used to floor anything below 16, which meant a deliberate
    // dim setting did not survive a power cycle: set 7, come back at 16, and it read as the
    // device forgetting rather than overriding. 7 is a level someone chose; 0 is the device
    // being off.
    if (ledMgr.getNumStrips() > 0 && ledMgr.getGlobalBrightness() == 0) {
        const uint8_t restored = gSettings.lastNonZeroBright ? gSettings.lastNonZeroBright
                                                             : BOOT_MIN_BRIGHTNESS;
        Serial.printf("[Boot] was off (brightness 0) → %u\n", restored);
        ledMgr.setGlobalBrightness(restored);
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
                bool loaded = false;
                // Not cycling → resume EXACTLY the last-shown pattern (which may be a Live /
                // current-only pattern that isn't a cycle member). Cycling → fall through to
                // the library; updateCycle() then drives the playlist off the synced clock.
                if (!cyclingActive) loaded = loadBootCurrent();
                if (!loaded) {
                    String cur = libReadCurrentName();
                    if (cur.length() > 0) {
                        for (size_t p = 0; p < libOrder.size(); p++) {
                            if (libNames[libOrder[p]] == cur) { loaded = libSetActiveByOrderPos((int)p); break; }
                        }
                    }
                    if (!loaded && !libOrder.empty()) libSetActiveByOrderPos(0);
                }
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
    // The R/G/B flash is toggleable per device (gSettings.rgbTest) — some installs
    // don't want it — but a total absence of strips is still a fatal error.
    if (ledMgr.getNumStrips() > 0) {
        if (gSettings.rgbTest) {
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
        }
    } else {
        Serial.println("ERROR: Cannot test LED functionality!");
        criticalSystemsOK = false;
    }
    
    // Load identity + button regardless of transport (used by both BLE and WiFi/mDNS).
    loadDeviceName();
    Serial.printf("Device name: %s\n", deviceName.c_str());
    loadButtonPin(); // configure the physical button GPIO (if any)

    // --- Transport selection -----------------------------------------------------------
    // WiFi mode: try to bring up the TCP transport. If it succeeds we run WiFi-only (BLE
    // stays off to avoid sharing the radio and to save RAM). If STA connect fails with the
    // revert-to-BLE fallback, WifiLink::begin() returns false and we start BLE below so the
    // user can always reconnect and fix credentials.
#if CHROMABAY_WIFI
    if (gSettings.commMode == DeviceSettings::COMM_WIFI) {
        gWifiMode = WifiLink::begin();
        Serial.println(gWifiMode ? "Transport: WiFi/TCP (BLE disabled this boot)"
                                 : "Transport: BLE (WiFi requested but unavailable)");
        // Crash reports go out over whichever link the app is on. Without this a device in
        // WiFi mode has no BLE and no route, and buffers panics it can never deliver.
        // The pump matters as much as the writer: a relayed report blocks the loop task, and
        // WifiLink::tick() is what would otherwise deliver the app's answer.
        if (gWifiMode) SentryReporting::setWifiLink(&WifiLink::sendSentryFrame, &WifiLink::tick);
    }
#endif

    // Initialize BLE unless we're serving over WiFi (mutually exclusive per boot). The
    // health-check / OTA-validate block after this runs for BOTH transports.
    if (!gWifiMode) {
    NimBLEDevice::init(deviceName.c_str());
    // Transmit at max power (+9dBm). NimBLE's default is much lower, which showed up as a
    // weak RSSI (~-80dBm) even at close range and made the link drop-prone. Applies to the
    // whole radio — advertising, connections, AND OTA transfers — so it also makes firmware
    // updates more reliable. Set once at boot; costs negligible extra current.
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);
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

            NimBLECharacteristic* pLibraryCmdCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LIBRARY_CMD, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
            pLibraryCmdCharacteristic->setCallbacks(new LibraryCmdCallbacks());

            pLibraryDumpCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_LIBRARY_DUMP, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pLibraryDumpCharacteristic->setCallbacks(new LibraryDumpCallbacks());
            NimBLECharacteristic* pCalibrationCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_CALIBRATION, NIMBLE_PROPERTY::WRITE);
            pCalibrationCharacteristic->setCallbacks(new CalibrationCallbacks());
            
            // Timestamp Sync Characteristic
            pTimestampSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_TIMESTAMP_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pTimestampSyncCharacteristic->setCallbacks(new TimestampSyncCallbacks());

            pPlaylistSyncCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_PLAYLIST_SYNC, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
            pPlaylistSyncCharacteristic->setCallbacks(new CycleControlCallbacks());

            // Brightness Characteristic (live global brightness, single byte)
            pBrightnessCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_BRIGHTNESS, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
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

            // Comm/Device settings (read JSON / write msgpack patch) — WiFi provisioning + mode switch.
            pCommConfigCharacteristic = pService->createCharacteristic(CHARACTERISTIC_UUID_COMM_CONFIG, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
            pCommConfigCharacteristic->setCallbacks(new CommConfigCallbacks());

            // Crash-report relay: the device hands the app a fully-formed HTTP request and the
            // app performs it. No-op in a build without sentry-micro.
            SentryReporting::attachBleService(pService);

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
    } // end if (!gWifiMode)

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

    Serial.printf("Cores: %d (%s). ", ESP.getChipCores(),
                  SINGLE_CORE ? "single — WS2812 flicker mitigations ON: dithering off, slower frame cadence; prefer APA102"
                              : "multi — render on core 1, BLE on core 0");
    Serial.println("Setup complete");
    SentryReporting::noteSetupComplete(millis());
}

unsigned long lastHeapUpdateTime = 0;
const unsigned long heapUpdateInterval = 5000; // Update heap in device info every 5 seconds

void loop() {
    unsigned long currentTime = millis();

    // Keep the wall clock current for the Clock node + on/off schedule (Unix seconds).
    // Prefer the free-running system clock (seeded by app TIMESTAMP_SYNC via settimeofday,
    // and/or kept in sync by NTP on WiFi); fall back to the app-synced snapshot + elapsed
    // millis. Valid once we've heard a plausible time (after 2024-01-01).
    uint32_t nowEpoch = 0;
    time_t sysNow = time(nullptr);
    if (sysNow > 1704067200) { nowEpoch = (uint32_t)sysNow; gClockValid = true; }
    else if (syncedEpochMs > 1704067200000ULL) { nowEpoch = (uint32_t)((syncedEpochMs + (uint64_t)(currentTime - syncedEpochLocalMs)) / 1000ULL); gClockValid = true; }
    else                     { gClockValid = false; }
    if (nowEpoch) WallClock::set(nowEpoch);

    // Daily on/off schedule: blank output outside the on-window. Re-evaluated each loop so a
    // settings change or a clock arriving takes effect immediately. Inert without a valid
    // clock (e.g. right after a power loss) — output stays on until the time is known.
    if (gSettings.schedEnable && gClockValid && gSettings.schedOnMin != gSettings.schedOffMin) {
        long localEpoch = (long)nowEpoch + (long)gSettings.tzOffsetMin * 60;
        long localDay = localEpoch / 86400;                 // days since 1970 in local time
        long localSec = localEpoch % 86400; if (localSec < 0) { localSec += 86400; localDay--; }
        uint16_t minOfDay = (uint16_t)(localSec / 60);
        int wday = (int)(((localDay % 7) + 7 + 4) % 7);      // 0=Sun..6=Sat (1970-01-01 was Thu)
        int yday = (wday + 6) % 7;                           // the prior day (for midnight-wrap mornings)
        auto dayOn = [&](int d) { return (gSettings.schedDays >> d) & 1; };
        bool inOn;
        if (gSettings.schedOnMin < gSettings.schedOffMin) {  // same-day window
            inOn = (minOfDay >= gSettings.schedOnMin && minOfDay < gSettings.schedOffMin) && dayOn(wday);
        } else {                                             // wraps midnight
            // Evening (>= on) is triggered by TODAY; the morning tail (< off) belongs to the
            // day that turned it on last night (yesterday) — so a Mon-only 20:00→06:00 stays
            // on into Tuesday morning regardless of Tuesday's toggle.
            if (minOfDay >= gSettings.schedOnMin)      inOn = dayOn(wday);
            else if (minOfDay < gSettings.schedOffMin) inOn = dayOn(yday);
            else                                       inOn = false;
        }
        // Fire only on a transition (so a manual change between transitions sticks):
        //  → OFF window: turn brightness to 0.
        //  → ON  window: if currently off (0), restore the last-on level (never on at 0).
        bool off = !inOn;
        if (off != gSchedInOffWindow) {
            gSchedInOffWindow = off;
            if (off) { ledMgr.setGlobalBrightness(0); Serial.println("[Sched] auto-off (brightness 0)"); }
            else {
                if (ledMgr.getGlobalBrightness() == 0)
                    ledMgr.setGlobalBrightness(gSettings.lastNonZeroBright ? gSettings.lastNonZeroBright : BOOT_MIN_BRIGHTNESS);
                gLastActivityMs = currentTime;
                Serial.printf("[Sched] auto-on (brightness %u)\n", ledMgr.getGlobalBrightness());
            }
        }
    } else if (gSchedInOffWindow) {
        // Schedule turned off (or the clock was lost) while we had it dark → bring it back on.
        gSchedInOffWindow = false;
        if (ledMgr.getGlobalBrightness() == 0)
            ledMgr.setGlobalBrightness(gSettings.lastNonZeroBright ? gSettings.lastNonZeroBright : BOOT_MIN_BRIGHTNESS);
        gLastActivityMs = currentTime;
    }

    // Remember the last "settled" non-zero brightness (held ~10s), so turning back on never
    // means 0. Watches the actual global brightness, whatever set it (slider, button,
    // schedule) — but a quick drag down through low values never settles, so it captures the
    // level the user was AT before turning down, not a transient.
    {
        static uint8_t sBriObs = 255; static uint32_t sBriSince = 0;
        uint8_t cur = ledMgr.getGlobalBrightness();
        if (cur != sBriObs) { sBriObs = cur; sBriSince = currentTime; }
        else if (cur > 0 && cur != gSettings.lastNonZeroBright && (currentTime - sBriSince) >= LNZB_DEBOUNCE_MS) {
            gSettings.lastNonZeroBright = cur;
            DeviceSettings::saveLastNonZero(cur);
            Serial.printf("[Bri] last-on level = %u\n", cur);
        }
    }

    // Off ≡ brightness 0: blank once and let the render guard skip work while dark.
    {
        uint8_t cur = ledMgr.getGlobalBrightness();
        if (cur == 0 && !gBriDark) { gBriDark = true; blankAllStrips(); }
        else if (cur > 0 && gBriDark) { gBriDark = false; }
    }

    // Report brightness to the app whenever it changes for ANY reason — button press, the
    // on/off schedule (→ 0 or restore), boot floor — so the slider/readout stays in sync.
    // (App writes come back too; the app just displays the value, never echoes, so no loop.)
    {
        static uint8_t lastNotifiedBri = 0xFE; // impossible-first so the first real value sends
        uint8_t cur = ledMgr.getGlobalBrightness();
        if (cur != lastNotifiedBri) {
            lastNotifiedBri = cur;
            if (deviceConnected && pBrightnessCharacteristic) {
                pBrightnessCharacteristic->setValue(&cur, 1);
                pBrightnessCharacteristic->notify();
            }
#if CHROMABAY_WIFI
            WifiLink::pushBrightness(cur);
#endif
        }
    }

    // Update pattern rendering
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
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
        } else if (patternRenderer != nullptr && !ota_in_progress && !gAsleep && !gBriDark
                   && (uint32_t)(currentTime) >= gRealtimeUntilMs) {
            // Not streaming (or the stream lapsed) → run the pattern/cycle. While realtime
            // packets are arriving (gRealtimeUntilMs in the future) we hold the streamed
            // frame and skip this, reverting automatically once packets stop.
            updateCycle();   // pick the synced playlist pattern before rendering
            patternRenderer->update();
            patternRenderer->render();
            fpsFrames++;
        }
    }

    // Render FPS to the serial console every 5s (counts actual rendered frames).
    if (currentTime - fpsLastReport >= 5000) {
        float secs = (currentTime - fpsLastReport) / 1000.0f;
        Serial.printf("[FPS] %.1f fps (%lu frames / %.1fs)\n", fpsFrames / secs, (unsigned long)fpsFrames, secs);
        fpsFrames = 0;
        fpsLastReport = currentTime;
    }

    // Process received patterns and LED configuration changes on the loop task,
    // so they never race with update()/render() above.
    processReceivedPattern();
    processPatternFlashSave();
    processReceivedCycleControl();
    processReceivedLedConfig();
    processReceivedLayout();
    processLayoutGetRequest();
    processLibraryDumpRequest();
    processLibraryCommand();
    processReceivedBrightness();
    processButton();
    processDeviceName();
    processButtonPinUpdate();
    processCommConfig();

    // WiFi/TCP transport: accept + read + dispatch framed messages (no-op in BLE mode).
#if CHROMABAY_WIFI
    if (gWifiMode) { WifiLink::tick(); RtStream::tick(); }
#endif

    // Retry any buffered crash report. Returns immediately unless something is queued AND
    // the flush interval has elapsed, so a healthy device never pays for this.
    SentryReporting::tick(currentTime);

    // Sleep timer: after gSettings.sleepMinutes of no activity, blank the output and pause
    // rendering. Any inbound command / button press calls noteActivity() → wakes. 0 = off.
    if (gSettings.sleepMinutes > 0) {
        uint32_t idleMs = currentTime - gLastActivityMs;
        if (!gAsleep && idleMs >= (uint32_t)gSettings.sleepMinutes * 60000UL) {
            gAsleep = true;
            Serial.printf("[Sleep] idle %us → sleeping (LEDs off)\n", (unsigned)(idleMs / 1000));
            blankAllStrips();
        }
    }

    // Finalize a pending OTA off the BLE host task (verify result, end, reboot)
    finalizeOtaIfReady();

    // Periodically update device info characteristic (for heap value)
    if (currentTime - lastHeapUpdateTime >= heapUpdateInterval) {
        lastHeapUpdateTime = currentTime;
        if (deviceConnected) {
            updateDeviceInfoCharacteristic();
        }
    }
    
    // Temporal dithering: between animation frames, emit high-rate sub-frames for any
    // strips small/fast enough to dither (no-op otherwise). This is what makes low
    // brightness smooth instead of banded.
    // Skipped on single-core: dithering fires 100+ extra show()s/sec, and on a single core
    // each is a fresh window for a BLE ISR to jitter WS2812 timing → the dithering meant to
    // smooth output was itself a top flicker source. (Trade-off: low brightness may band a
    // little on single-core one-wire strips; use APA102 to get both smooth AND flicker-free.)
    // Must also stop while the output is meant to be OFF (schedule/brightness-0 = gBriDark, or
    // sleep = gAsleep): otherwise the dither loop keeps re-emitting the LAST target and the
    // LEDs stay lit/frozen on top of the blank (render is skipped, so the target never updates
    // to black). Gate it on the same "output on" condition as rendering.
    if (!ota_in_progress && !SINGLE_CORE && !gBriDark && !gAsleep) {
        ledMgr.ditherTick();
    }

    delay(1);
}
