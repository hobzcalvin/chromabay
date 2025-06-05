# 📱 iOS Development Setup - Blumon

## 🚀 Quick Start

```bash
# Build and run on simulator
npx cap run ios

# Open in Xcode for device deployment
npx cap open ios
```

## 🏢 Corporate Security Issues

### Problem: "Operation not permitted" with CocoaPods

**Symptoms:**
- `PhaseScriptExecution failed with a nonzero exit code`
- `/bin/sh: Operation not permitted`
- Sandbox restrictions blocking framework scripts

**Solution:**
```bash
# 1. Clean rebuild (recommended)
rm -rf ios
npx cap add ios
npx cap run ios

# 2. Use Xcode directly
npx cap open ios
# Then build with Cmd+R in Xcode
```

## 🔧 Configuration Notes

### Working Capacitor Config
- **webDir**: `'build'` (matches SvelteKit output)
- **appId**: `'com.revoltlabs.blumon'`
- **Deployment Target**: iOS 14.0+ (compatible with most devices)

### Fresh iOS Project Benefits
- Clean CocoaPods installation
- No corrupted permission files
- Corporate security bypass through project regeneration

## 🎯 Testing Targets

### Simulators (Working)
- iPhone 16 Pro: `D536BB64-26EF-47C4-8EDC-66E5BA06CD7C`
- All iOS 18.4+ simulators supported

### Physical Devices
- Use Xcode device selector (most reliable)
- Set up Apple ID code signing
- USB connection required

## 📋 Prerequisites

- **Xcode 16.4+** with iOS 18.4+ SDK
- **Node.js 18+** 
- **CocoaPods** (auto-managed by Capacitor)
- **Apple ID** for device testing

## 🐛 Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| iOS 18.5 required | Use Xcode directly, it handles SDK versions |
| CocoaPods blocked | `rm -rf ios && npx cap add ios` |
| Device not found | Use Xcode device dropdown, not CLI target IDs |
| Framework scripts fail | Fresh project regeneration bypasses corruption |
| Vite file watching errors | Temporary, restart dev server |

## ✅ Success Checklist

- [ ] App builds and runs in simulator
- [ ] Xcode opens project without errors  
- [ ] Physical device appears in Xcode
- [ ] Code signing configured
- [ ] BLE permissions configured for device testing

---

**Pro Tip:** When in doubt, regenerate the iOS project. It's fast and fixes most corporate security issues. 