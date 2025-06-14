# BluMon ESP32 Project

This is the ESP32 firmware for the BluMon LED controller project.

## Quick Start (from project root)

```bash
# Build the firmware
npm run esp32:build

# Upload to ESP32 (auto-detects USB device)
npm run esp32:upload

# Monitor serial output
npm run esp32:monitor

# Build and upload in one command
npm run esp32:build-upload

# Build, upload, and start monitoring
npm run esp32:full
```

## Hardware Requirements

- ESP32 Development Board (4MB or 8MB flash)
- WS2812B LED Strip (131 LEDs)
- Connection: LED strip data pin to GPIO 13

## Features

- **FastLED Rainbow Animation**: Smooth rainbow pattern across 131 LEDs
- **NimBLE UART Service**: Efficient BLE communication for commands and status
- **LittleFS Filesystem**: 1MB partition for data storage
- **OTA Ready**: Dual partition setup for over-the-air updates
- **Power Optimized**: WiFi disabled, minimal power consumption
- **Custom Partitioning**: Optimized memory layout for 4MB flash

## Memory Layout (4MB Flash)

| Partition | Type | Size | Usage |
|-----------|------|------|-------|
| nvs | data | 20KB | Non-volatile storage |
| otadata | data | 8KB | OTA metadata |
| app0 | app | 1.3MB | Application partition 0 |
| app1 | app | 1.3MB | Application partition 1 |
| littlefs | data | 1MB | LittleFS filesystem |
| coredump | data | 320KB | Core dump storage |

## BLE UART Service

The ESP32 advertises as **"BluMon_ESP32"** with custom LED Service:

- **Service UUID**: `a0be83e4-8dc9-47f0-ab40-b19721d20ed1`
- **RX Characteristic**: `a0be83e5-8dc9-47f0-ab40-b19721d20ed1` (receive commands)
- **TX Characteristic**: `a0be83e6-8dc9-47f0-ab40-b19721d20ed1` (send responses)

### Available Commands
- `status` - Get LED count, brightness, and memory info
- `info` - Get device information

## Development

### Manual PlatformIO Commands (from esp32/ directory)

```bash
# Build only
pio run

# Upload with specific port
pio run --target upload --upload-port /dev/cu.usbserial-XXXXXXXX

# Monitor with specific port  
pio device monitor --port /dev/cu.usbserial-XXXXXXXX --baud 115200

# List available devices
pio device list
```

### Configuration

- **Platform**: ESP32 Arduino Framework
- **Board**: ESP32 Dev Module
- **Upload Speed**: 115200 baud (reliable)
- **Monitor Speed**: 115200 baud
- **Libraries**: FastLED 3.9.20, NimBLE-Arduino 1.4.3, LittleFS 2.0.0

## Troubleshooting

### Boot Loop Issues
- Check power supply (USB should be sufficient for development)
- Verify LED strip connections
- Try different upload speeds in `platformio.ini`

### BLE Connection Issues
- Ensure device is advertising (check serial output)
- Use BLE scanner app to verify service UUIDs
- Check that NimBLE stack initialized properly

### Memory Issues
- Current usage: 11.3% RAM, 49.7% Flash
- If running low, disable debug output or reduce LED count

## Next Steps

1. **Mobile App Integration**: Connect via BLE UART service
2. **Pattern Language**: Implement LED pattern commands
3. **OTA Updates**: Set up over-the-air firmware updates
4. **File System**: Store patterns and configurations in LittleFS

## Build Configuration

The project uses custom build flags to:
- Enable Bluetooth Classic and disable BLE mesh
- Disable WiFi components for power saving
- Enable LittleFS filesystem support
- Set optimal performance settings

## Commands

Connect via Bluetooth Serial (device name: "BluMon_ESP32") and send:
- `status` - Get LED and system status
- `info` - Get chip and memory information

## Upload Instructions

1. Connect ESP32 via USB
2. Run: `pio run --target upload`
3. Monitor: `pio device monitor`

## Future OTA Setup

For OTA updates over BLE:
1. Implement BLE OTA service
2. Update platformio.ini upload_protocol to custom BLE OTA
3. Use dual partition system for safe updates 