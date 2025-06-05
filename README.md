# 🔵 Blumon

ESP32 Bluetooth Low Energy Monitor built with SvelteKit + Capacitor.

## 🚀 Features

- **Universal BLE Client**: Connect to and interact with ESP32 devices
- **Cross-Platform**: Web (Chrome/Edge), iOS, and Android support
- **Real-time Communication**: Read, write, and receive notifications from ESP32
- **Service Discovery**: Automatically discover all BLE services and characteristics
- **Modern UI**: Beautiful, responsive interface with real-time status indicators

## 📱 Deployment

The app is deployed to GitHub Pages at: https://hobzcalvin.github.io/blumon

### Release Process

This project uses **tag-based deployments** for production releases. Deployments are triggered only when you create version tags, not on every push to main.

#### Creating a Release

Use the release script for easy version management:

```bash
# Patch release (1.0.0 -> 1.0.1)
./scripts/release.sh patch

# Minor release (1.0.0 -> 1.1.0)
./scripts/release.sh minor

# Major release (1.0.0 -> 2.0.0)
./scripts/release.sh major

# Specific version
./scripts/release.sh v1.2.3
```

#### Manual Release

If you prefer to create tags manually:

```bash
# Create and push a version tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

#### Manual Deployment

You can also trigger deployments manually from the GitHub Actions tab without creating a tag.

### Build Information

The deployed app displays build information in the footer:
- **Version**: Git tag or "manual-deploy"
- **Commit Hash**: Short git commit hash
- **Build Date**: UTC timestamp when deployed
- **Commit Message**: Latest commit message

## 🛠️ Development

### Prerequisites

- Node.js 20+
- npm

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Mobile Development

```bash
# iOS
npm run build
npx cap sync ios
npx cap open ios

# Android
npm run build
npx cap sync android
npx cap open android
```

## 🔌 ESP32 Integration

This app can connect to any ESP32 device running BLE server code. The app will automatically discover and display all available services and characteristics.

### Example ESP32 BLE Server

The app works with standard ESP32 BLE libraries. Here's a minimal example:

```cpp
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Create BLE service and characteristics
BLEService *pService = pServer->createService("12345678-1234-1234-1234-123456789abc");
BLECharacteristic *pCharacteristic = pService->createCharacteristic(
  "87654321-4321-4321-4321-cba987654321",
  BLECharacteristic::PROPERTY_READ |
  BLECharacteristic::PROPERTY_WRITE |
  BLECharacteristic::PROPERTY_NOTIFY
);

// Start advertising
pService->start();
pServer->getAdvertising()->start();
```

## 📖 Tech Stack

- **Frontend**: SvelteKit, TypeScript, Vite
- **Mobile**: Capacitor
- **BLE**: Capacitor Community Bluetooth LE plugin + Web Bluetooth API
- **Deployment**: GitHub Actions → GitHub Pages
- **Styling**: Modern CSS with glassmorphism effects

## 🎯 Use Cases

- **IoT Development**: Test and debug ESP32 BLE communication
- **Sensor Monitoring**: Read real-time data from ESP32 sensors
- **Device Control**: Send commands to ESP32-controlled devices
- **Prototyping**: Rapid ESP32 BLE app development and testing

---

Built with ❤️ by ReVolt Labs
