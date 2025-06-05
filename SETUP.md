# 🔵 Blumon - GitHub Pages Setup Guide

## ✅ **Setup Complete!**

Your Blumon project is now fully configured with automatic GitHub Pages deployment via the `docs/` folder and pre-commit hooks.

## 📋 **What's Already Configured:**

✅ **SvelteKit** - Building to `docs/` folder  
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

Your site will be available at: `https://yourusername.github.io/blumon/`

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
├── docs/                     # Built files (auto-generated)
├── android/                  # Android native project
├── ios/                      # iOS native project
└── .husky/pre-commit        # Auto-build hook
```

## 🎉 **You're All Set!**

Your Blumon app is production-ready with zero-config deployment. Just commit your changes and they'll automatically appear on GitHub Pages!

---
Built with ⚡ by **ReVolt Labs** 