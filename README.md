# 🔵 Blumon

ESP32 Bluetooth Low Energy Monitor built with SvelteKit + Capacitor.

## 🚀 Features

- **Universal BLE Client**: Connect to and interact with ESP32 devices
- **Cross-Platform**: Web (Chrome/Edge), iOS, and Android support
- **Real-time Communication**: Read, write, and receive notifications from ESP32
- **Service Discovery**: Automatically discover all BLE services and characteristics
- **LED Pattern Engine**: Real-time WebAssembly-powered LED effects
- **Modern UI**: Beautiful, responsive interface with real-time status indicators
- **Live Updates** - Push updates to mobile apps without app store releases

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
# Install dependencies (automatically sets up Emscripten)
npm install

# Start development server (auto-builds WebAssembly modules)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### LED Operator Development

Blumon includes a powerful LED pattern engine with C++ operators compiled to WebAssembly:

```bash
# Test all operators (catches crashes, infinite loops, parameter issues)
npm run operators:test

# Add a new operator - just create a .cpp file in src/native/operators/
npm run operators:add

# Generate bindings after adding operators
npm run wasm:generate
```

**Available Operators:**
- `rainbow` - Animated rainbow colors
- `gradient` - Color gradients  
- `sparkle` - Random sparkles
- `strobe` - Strobe effects
- `moving_blob` - Moving color blobs
- `perlin_noise` - Perlin noise patterns

**Adding New Operators:**
1. Create `src/native/operators/my_operator.cpp`:
```cpp
#include "../fastled_operators.h"

void my_operator(OperatorContext& ctx) {
    float speed = ctx.getParam("speed", 1.0f);
    
    for (int i = 0; i < ctx.num_leds; i++) {
        ctx.leds[i] = CHSV(ctx.time * speed, 255, 255);
    }
}
```
2. Run `npm run wasm:generate` - automatically generates registry and TypeScript bindings
3. Operator is immediately available in the browser with hot reload

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

**📱 iOS Setup**: See [IOS_SETUP.md](./IOS_SETUP.md) for detailed iOS development guide including corporate security workarounds.

**📋 Full Setup**: See [SETUP.md](./SETUP.md) for complete project setup and deployment instructions.

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
- **LED Engine**: C++ operators compiled to WebAssembly with Emscripten
- **Mobile**: Capacitor
- **BLE**: Capacitor Community Bluetooth LE plugin + Web Bluetooth API
- **Deployment**: GitHub Actions → GitHub Pages
- **Styling**: Modern CSS with glassmorphism effects

## 🎯 Use Cases

- **IoT Development**: Test and debug ESP32 BLE communication
- **Sensor Monitoring**: Read real-time data from ESP32 sensors
- **Device Control**: Send commands to ESP32-controlled devices
- **Prototyping**: Rapid ESP32 BLE app development and testing

## Live Updates

This app supports live updates for the mobile versions, allowing you to push updates directly to users' devices without going through app store reviews.

### How it works

1. **GitHub Pages Deployment**: The web app is built and deployed to GitHub Pages
2. **Bundle Creation**: Each deployment creates a ZIP bundle of the web assets
3. **Version Manifest**: A `version.json` file tracks the latest available version
4. **Mobile Check**: Mobile apps periodically check for updates from GitHub Pages
5. **Background Download**: When an update is available, it downloads in the background
6. **Next Restart**: Updates are applied when the app is restarted

### Technical Details

- Uses [Capawesome Live Updates](https://capawesome.io/plugins/live-update/) plugin
- Self-hosted on GitHub Pages (no external service required)
- Updates are downloaded as ZIP bundles
- Automatic rollback if updates fail
- Only web layer updates (HTML/CSS/JS) - native changes still require app store

### Update Process

1. Make changes to your app
2. Push a version tag: `git tag v1.0.1 && git push origin v1.0.1`
3. GitHub Actions builds and deploys to Pages
4. Mobile apps automatically detect and download the update
5. Users get the update on next app restart

### Development

For live update testing:

```bash
# Create a test bundle
npm run bundle:create

# Build and create live update
npm run bundle:live
```

### Configuration

Live updates are configured in `capacitor.config.ts`:

```typescript
plugins: {
  LiveUpdate: {
    serverDomain: 'https://hobzcalvin.github.io',
    autoDeleteBundles: true,
    readyTimeout: 10000,
    httpTimeout: 60000
  }
}
```

The system checks for updates by fetching `/blumon/version.json` from GitHub Pages and comparing versions.

---

Built with ❤️ by ReVolt Labs
