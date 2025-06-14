#include <Arduino.h>
#include <FastLED.h>
#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include <NimBLEUtils.h>

// LED Configuration
#define LED_PIN     13
#define NUM_LEDS    131
#define LED_TYPE    WS2812B
#define COLOR_ORDER GRB
#define BRIGHTNESS  20

// LED Array
CRGB leds[NUM_LEDS];

// NimBLE UART Service (Nordic UART Service UUID)
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

NimBLEServer* pServer = nullptr;
NimBLECharacteristic* pTxCharacteristic = nullptr;
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

// NimBLE Characteristic Callbacks (for receiving data)
class CharacteristicCallbacks: public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) {
        std::string rxValue = pCharacteristic->getValue();
        
        if (rxValue.length() > 0) {
            receivedData = "";
            for (int i = 0; i < rxValue.length(); i++) {
                receivedData += rxValue[i];
            }
            Serial.println("BLE Received: " + receivedData);
            
            // Process BLE commands here
            if (receivedData == "status") {
                String response = "LEDs: " + String(NUM_LEDS) + 
                                ", Brightness: " + String(BRIGHTNESS) + 
                                ", Free Heap: " + String(ESP.getFreeHeap());
                pTxCharacteristic->setValue(response.c_str());
                pTxCharacteristic->notify();
            } else if (receivedData == "info") {
                String response = "BluMon ESP32 - FastLED Rainbow Demo (NimBLE)";
                pTxCharacteristic->setValue(response.c_str());
                pTxCharacteristic->notify();
            }
        }
    }
};

void setup() {
    // Initialize serial communication
    Serial.begin(115200);
    delay(1000); // Give serial time to initialize
    Serial.println("ESP32 FastLED Rainbow Test Starting...");
    
    // Initialize FastLED first (most critical)
    Serial.println("Initializing FastLED...");
    FastLED.addLeds<LED_TYPE, LED_PIN, COLOR_ORDER>(leds, NUM_LEDS);
    FastLED.setBrightness(BRIGHTNESS);
    FastLED.clear();
    FastLED.show();
    Serial.println("FastLED Initialized");
    
    // Test with a simple pattern first
    Serial.println("Testing LEDs with red pattern...");
    for(int i = 0; i < NUM_LEDS; i++) {
        leds[i] = CRGB::Red;
    }
    FastLED.show();
    delay(1000);
    
    // Clear LEDs
    FastLED.clear();
    FastLED.show();
    
    // Initialize LittleFS
    Serial.println("Initializing LittleFS...");
    if (!LittleFS.begin(true)) {
        Serial.println("LittleFS Mount Failed - continuing without filesystem");
    } else {
        Serial.println("LittleFS Mounted Successfully");
        
        // Print filesystem info
        size_t totalBytes = LittleFS.totalBytes();
        size_t usedBytes = LittleFS.usedBytes();
        Serial.printf("LittleFS Total: %d bytes, Used: %d bytes\n", totalBytes, usedBytes);
    }
    
    // Initialize NimBLE
    Serial.println("Initializing NimBLE...");
    NimBLEDevice::init("BluMon_ESP32");
    
    // Create BLE Server
    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());
    
    // Create BLE Service
    NimBLEService *pService = pServer->createService(SERVICE_UUID);
    
    // Create TX Characteristic (for sending data to client)
    pTxCharacteristic = pService->createCharacteristic(
                        CHARACTERISTIC_UUID_TX,
                        NIMBLE_PROPERTY::NOTIFY
                      );
    
    // Create RX Characteristic (for receiving data from client)
    NimBLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
                                               CHARACTERISTIC_UUID_RX,
                                               NIMBLE_PROPERTY::WRITE
                                             );
    pRxCharacteristic->setCallbacks(new CharacteristicCallbacks());
    
    // Start the service
    pService->start();
    
    // Start advertising
    NimBLEAdvertising *pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(false);
    pAdvertising->setMinPreferred(0x0);  // set value to 0x00 to not advertise this parameter
    NimBLEDevice::startAdvertising();
    
    Serial.println("NimBLE UART Service started - waiting for connections...");
    Serial.println("Device name: BluMon_ESP32");
    
    Serial.println("Setup complete - Starting rainbow animation");
    Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
}

void loop() {
    unsigned long currentTime = millis();
    
    // Update rainbow animation
    if (currentTime - lastUpdate >= updateInterval) {
        lastUpdate = currentTime;
        
        // Fill rainbow
        fill_rainbow(leds, NUM_LEDS, hue, 7);
        
        // Show the LEDs
        FastLED.show();
        
        // Increment hue for next frame
        hue++;
        
        // Print status every 5 seconds
        static unsigned long lastStatus = 0;
        if (currentTime - lastStatus >= 5000) {
            lastStatus = currentTime;
            Serial.printf("Rainbow running - Hue: %d, Brightness: %d, Free heap: %d bytes, BLE: %s\n", 
                         hue, BRIGHTNESS, ESP.getFreeHeap(), deviceConnected ? "Connected" : "Disconnected");
        }
    }
    
    // Handle BLE connection changes
    if (!deviceConnected && oldDeviceConnected) {
        delay(500); // give the bluetooth stack the chance to get things ready
        pServer->startAdvertising(); // restart advertising
        Serial.println("Start advertising");
        oldDeviceConnected = deviceConnected;
    }
    // connecting
    if (deviceConnected && !oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
    }
    
    // Small delay to prevent watchdog issues
    delay(1);
} 