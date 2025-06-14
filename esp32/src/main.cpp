#include <Arduino.h>
#include <FastLED.h> // Still needed for CRGB struct and color math (fill_rainbow)
#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>

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


NimBLEServer* pServer = nullptr;
// Original RX/TX Characteristics
NimBLECharacteristic* pTxCharacteristic = nullptr;
// OTA Characteristics
NimBLECharacteristic* pDeviceInfoCharacteristic = nullptr;
NimBLECharacteristic* pOTAControlCharacteristic = nullptr;
NimBLECharacteristic* pOTADataCharacteristic = nullptr;
NimBLECharacteristic* pOTAStatusCharacteristic = nullptr;


bool deviceConnected = false;
bool oldDeviceConnected = false;
String receivedData = "";

// Rainbow variables
uint8_t hue = 0;
unsigned long lastUpdate = 0;
const unsigned long updateInterval = 20; // Update every 20ms for smooth animation

// NimBLE Server Callbacks
class ServerCallbacks: public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) {
        deviceConnected = true;
        Serial.println("BLE Client Connected");
    };

    void onDisconnect(NimBLEServer* pServer) {
        deviceConnected = false;
        Serial.println("BLE Client Disconnected");
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
        // Construct JSON response
        String deviceInfoJson = "{";
        deviceInfoJson += "\"fw_ver\":\"" + String(FIRMWARE_VERSION) + "\",";
        deviceInfoJson += "\"hw_ver\":\"" + String(HARDWARE_VERSION) + "\",";
        deviceInfoJson += "\"heap\":" + String(ESP.getFreeHeap());
        // Add more info if needed, e.g., MAC address, uptime, etc.
        // deviceInfoJson += ",\"mac\":\"" + String(NimBLEDevice::getAddress().toString().c_str()) + "\"";
        deviceInfoJson += "}";
        
        pCharacteristic->setValue(deviceInfoJson.c_str());
        Serial.println("Sent Device Info: " + deviceInfoJson);
    }
};

// Callback for OTA Control Characteristic (Write)
class OTAControlCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        Serial.print("OTA Control Received: ");
        if (value.length() > 0) {
            Serial.println(value.c_str());
            // Basic command handling (placeholder)
            if (value == "START_OTA") {
                Serial.println("OTA Start command received. Placeholder for OTA logic.");
                if (pOTAStatusCharacteristic) {
                    pOTAStatusCharacteristic->setValue("OTA_STARTED");
                    pOTAStatusCharacteristic->notify();
                }
            } else if (value == "END_OTA") {
                Serial.println("OTA End command received. Placeholder.");
                 if (pOTAStatusCharacteristic) {
                    pOTAStatusCharacteristic->setValue("OTA_ENDED_CMD"); // Example status
                    pOTAStatusCharacteristic->notify();
                }
            } else if (value == "ABORT_OTA") {
                Serial.println("OTA Abort command received. Placeholder.");
                if (pOTAStatusCharacteristic) {
                    pOTAStatusCharacteristic->setValue("OTA_ABORTED_CMD"); // Example status
                    pOTAStatusCharacteristic->notify();
                }
            }
        } else {
            Serial.println("(empty)");
        }
    }
};

// Callback for OTA Data Characteristic (Write Without Response)
class OTADataCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        // For WriteWithoutResponse, often just process data directly.
        // Serial output here might be too slow for actual OTA.
        // Serial.printf("OTA Data Chunk Received: %d bytes\n", value.length());
        
        // Placeholder for esp_ota_write(ota_handle, value.data(), value.length());
        // For now, just acknowledge receipt by blinking an LED or similar minimal action if needed for debug.
        // Or send a status update via pOTAStatusCharacteristic after N chunks.
        static int chunkCount = 0;
        chunkCount++;
        if (chunkCount % 10 == 0 && pOTAStatusCharacteristic) { // Example: notify every 10 chunks
             String status = "RX_CHUNK_" + String(chunkCount);
             pOTAStatusCharacteristic->setValue(status.c_str());
             pOTAStatusCharacteristic->notify();
        }
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
    Serial.println("Firmware Version: " + String(FIRMWARE_VERSION));
    Serial.println("Hardware Version: " + String(HARDWARE_VERSION));


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
    // Device Info Characteristic (Read-Only, Notify for potential future dynamic updates)
    pDeviceInfoCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_DEVICE_INFO,
                                NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
                              );
    pDeviceInfoCharacteristic->setCallbacks(new DeviceInfoCallbacks()); // Handles onRead

    // OTA Control Characteristic (Write)
    pOTAControlCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_CONTROL,
                                NIMBLE_PROPERTY::WRITE // Use WRITE for acknowledged commands
                              );
    pOTAControlCharacteristic->setCallbacks(new OTAControlCallbacks());

    // OTA Data Characteristic (Write Without Response for speed)
    pOTADataCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_DATA,
                                NIMBLE_PROPERTY::WRITE_NR // WRITE_NO_RESPONSE
                             );
    pOTADataCharacteristic->setCallbacks(new OTADataCallbacks());

    // OTA Status Characteristic (Notify)
    pOTAStatusCharacteristic = pService->createCharacteristic(
                                CHARACTERISTIC_UUID_OTA_STATUS,
                                NIMBLE_PROPERTY::NOTIFY
                               );
    // No specific callback needed for pOTAStatusCharacteristic as ESP32 writes to it.
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
    // Could print all characteristic UUIDs for debugging if needed
    
    Serial.println("Setup complete - Starting rainbow animation");
    Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
}

void loop() {
    unsigned long currentTime = millis();
    
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
        if (ledMgr.getNumStrips() > 0 && ledMgr.getStrip(0) != nullptr) {
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
            Serial.printf("Rainbow running - Hue: %d, Brightness: %d, Free heap: %d bytes, BLE: %s, Strips: %d\n", 
                         hue, currentBrightness, ESP.getFreeHeap(), deviceConnected ? "Connected" : "Disconnected", ledMgr.getNumStrips());
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
