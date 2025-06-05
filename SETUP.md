# 🔵 Blumon - GitHub Pages Setup Guide

## ✅ **Setup Complete!**

Your Blumon project is now fully configured with automatic GitHub Pages deployment via the `docs/` folder and pre-commit hooks.

## 📋 **What's Already Configured:**

✅ **SvelteKit** - Building to `build/` folder  
✅ **Capacitor** - Ready for iOS & Android  
✅ **Bluetooth LE** - Cross-platform BLE support  
✅ **Pre-commit Hook** - Auto-builds and stages `docs/` on commit  
✅ **TypeScript** - Full type safety  
✅ **Modern UI** - Beautiful responsive design  

## 🚀 **Next Steps:**

### 1. **Push to GitHub**
```bash
git push origin main
```

### 2. **Enable GitHub Pages**
1. Go to your repository settings on GitHub
2. Navigate to **Pages** in the sidebar
3. Under **Source**, select "Deploy from a branch"
4. Choose **main** branch and **/ (root)** folder
5. Click **Save**

Your site will be available at: `https://hobzcalvin.github.io/blumon/`

### 3. **Development Workflow**
```bash
# Web development
npm run dev

# iOS development (requires Xcode)
npm run ios

# Android development (requires Android Studio)
npm run android

# Manual build (auto happens on commit)
npm run build
```

## 📱 **iOS Development Guide**

### **Quick Start**
```bash
# Build and run on simulator
npx cap run ios --target=D536BB64-26EF-47C4-8EDC-66E5BA06CD7C

# Or open in Xcode for device deployment
npx cap open ios
```

### **🏢 Corporate Security Workaround**

If you encounter **"Operation not permitted"** errors on corporate laptops:

1. **Clean rebuild approach:**
   ```bash
   rm -rf ios
   npx cap add ios
   npx cap run ios
   ```

2. **Use Xcode directly** (most reliable):
   ```bash
   npx cap open ios
   # Then build and run from Xcode (Cmd+R)
   ```

3. **If CocoaPods scripts are blocked:**
   - The project auto-regenerates clean CocoaPods configuration
   - Fresh `npx cap add ios` bypasses corrupted permissions
   - Xcode builds have different security permissions than CLI

### **Device Testing**
- **Simulator**: Use any available iPhone simulator
- **Physical Device**: 
  1. Connect iPhone via USB
  2. Open `ios/App/App.xcworkspace` in Xcode
  3. Select your device in the dropdown
  4. Set up code signing (use your Apple ID)
  5. Press `Cmd+R` to build and run

## 🔄 **How Auto-Deployment Works:**

1. Make changes to your code
2. `git add .` and `git commit -m "Your message"`
3. Pre-commit hook automatically:
   - Builds the project to `docs/`
   - Stages the built files
   - Includes them in your commit
4. `git push` to deploy to GitHub Pages

## 🎯 **Ready to Use Features:**

- **BLE Scanning** - Discover nearby Bluetooth devices
- **Real-time Updates** - Live device list updates  
- **Cross-platform** - Works on web, iOS, and Android
- **Hot Reload** - Sub-second updates during development
- **Modern UI** - Glassmorphism design with animations

## 🏢 **Project Structure:**
```
blumon/
├── src/routes/+page.svelte    # Main app UI
├── src/lib/ble.ts            # BLE helper functions
├── build/                    # Built files (auto-generated)
├── docs/                     # GitHub Pages deployment
├── android/                  # Android native project
├── ios/                      # iOS native project
└── .husky/pre-commit        # Auto-build hook
```

## 🛠 **Troubleshooting**

### **iOS Build Issues**
- **CocoaPods permission denied**: Delete `ios/` folder and run `npx cap add ios`
- **iOS 18.5 not installed**: Build in Xcode directly, it handles SDK versions automatically
- **Device not recognized**: Use Xcode device selector instead of CLI target IDs
- **Corporate security blocking**: Always use `npx cap open ios` and build from Xcode

### **Web Development**
- **Port conflicts**: Vite auto-finds available ports (5173, 5174, etc.)
- **File watching errors**: Temporary issue with iOS build files, restart dev server

## 🎉 **You're All Set!**

Your Blumon app is production-ready with zero-config deployment. Just commit your changes and they'll automatically appear on GitHub Pages!

---
Built with ⚡ by **ReVolt Labs** 