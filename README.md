# 🔵 Blumon

**Bluetooth Low Energy Monitor** by ReVolt Labs

A cross-platform Bluetooth LE scanning and monitoring application built with SvelteKit, Capacitor, and modern web technologies.

## ✨ Features

- **Cross-Platform**: Runs on iOS, Android, and Web
- **Bluetooth LE Scanning**: Discover and monitor nearby BLE devices
- **Real-time Hot Reload**: Sub-second updates on device and in browser
- **Modern UI**: Beautiful, responsive design with glassmorphism effects
- **GitHub Pages Deployment**: Automatic deployment via docs/ folder with pre-commit hooks
- **TypeScript**: Full type safety throughout the application

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or pnpm
- iOS: Xcode (for iOS development)
- Android: Android Studio (for Android development)

### Installation

```bash
git clone <your-repo-url>
cd b2
npm install
```

### Development

#### Web Development
```bash
npm run dev
```
Opens at `http://localhost:5173` with hot reload

#### iOS Development
```bash
npm run ios
```
Builds, syncs, and runs on iOS with live reload

#### Android Development  
```bash
npm run android
```
Builds, syncs, and runs on Android with live reload

### Deployment

#### GitHub Pages (Automatic)
The project is set up with a pre-commit hook that automatically:
1. Builds the project to the `docs/` folder
2. Stages the built files for commit
3. Commits will automatically update the GitHub Pages deployment

Simply commit your changes:
```bash
git add .
git commit -m "Your changes"
git push
```

#### Manual Build
```bash
npm run deploy:docs  # Builds to docs/ folder
npm run sync         # Sync to native platforms
```

## 📱 Platform Support

### Web Browser
- Chrome/Edge: Full BLE support via Web Bluetooth API
- Safari: Limited support (requires user gesture)
- Firefox: Experimental support (flag required)

### iOS
- iOS 13.0+
- Full BLE scanning and connection capabilities
- Native performance with Capacitor wrapper

### Android
- Android 6.0+ (API level 23)
- Full BLE scanning and connection capabilities  
- Requires location permissions for BLE scanning

## 🛠️ Architecture

```
b2/
├── src/
│   ├── lib/
│   │   └── ble.ts              # BLE helper functions
│   └── routes/
│       └── +page.svelte        # Main app interface
├── android/                    # Android native project
├── ios/                        # iOS native project
├── docs/                       # Built files for GitHub Pages
├── capacitor.config.ts         # Capacitor configuration
├── svelte.config.js           # SvelteKit configuration
└── .husky/                    # Git hooks for auto-deployment
```

### Key Technologies

- **SvelteKit 2**: Modern web framework with TypeScript
- **Capacitor 7**: Native app wrapper for iOS/Android
- **@capacitor-community/bluetooth-le**: Cross-platform BLE plugin
- **@sveltejs/adapter-static**: Static site generation for GitHub Pages
- **Husky**: Git hooks for automated deployment

## 🔧 Configuration

### Bluetooth Permissions

The app automatically configures the required permissions:

**Android** (`android/app/src/main/AndroidManifest.xml`):
```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"/>
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"/>
<uses-feature android:name="android.hardware.bluetooth_le" android:required="true"/>
```

**iOS** (`ios/App/App/Info.plist`):
```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app uses BLE to communicate with nearby devices</string>
```

### GitHub Pages Configuration

1. In your GitHub repository settings, go to **Pages**
2. Set **Source** to "Deploy from a branch"
3. Choose **main** branch and **/ (root)** folder
4. The site will be available at `https://yourusername.github.io/b2/`

The pre-commit hook automatically builds to `docs/` and stages the files.

## 🎯 Usage

1. **Initialize**: App automatically initializes BLE on startup
2. **Enable Bluetooth**: Click "Enable Bluetooth" if needed
3. **Start Scanning**: Click "Start Scanning" to discover devices
4. **View Devices**: Discovered devices appear in real-time
5. **Stop Scanning**: Click "Stop Scanning" to conserve battery

## 📋 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build production bundle to docs/ folder |
| `npm run preview` | Preview production build |
| `npm run sync` | Sync web assets to native platforms |
| `npm run ios` | Build and run on iOS with live reload |
| `npm run android` | Build and run on Android with live reload |
| `npm run deploy:docs` | Build to docs/ folder |
| `npm run deploy` | Alias for deploy:docs |

## 🔄 Automated Deployment

The project includes a pre-commit hook (`.husky/pre-commit`) that:

1. Automatically builds the project when you commit
2. Stages the updated `docs/` folder
3. Ensures GitHub Pages always has the latest build

No additional setup required - just commit and push!

## 🐛 Troubleshooting

### BLE Not Working in Browser
- Ensure you're using HTTPS (required for Web Bluetooth)
- Use Chrome/Edge for best compatibility
- Check if Web Bluetooth is enabled in browser flags

### iOS Build Issues
- Ensure Xcode is installed and up to date
- Check iOS deployment target in project settings
- Verify Apple Developer account setup

### Android Build Issues  
- Ensure Android Studio and SDK are installed
- Check Android API level requirements
- Verify USB debugging is enabled on device

### GitHub Pages Not Updating
- Check that the `docs/` folder is committed
- Verify GitHub Pages is set to deploy from main branch / (root)
- Check the pre-commit hook is executable: `chmod +x .husky/pre-commit`

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (pre-commit hook will auto-build)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🏢 About ReVolt Labs

Built with ⚡ by [ReVolt Labs](https://revoltlabs.com) - Powering the future of IoT and mobile applications.

---

**Need help?** Open an issue or contact us at [support@revoltlabs.com](mailto:support@revoltlabs.com)
