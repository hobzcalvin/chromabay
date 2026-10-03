# ChromaBay

**Design LED light patterns on your phone or in the browser, and play them on ESP32-powered
lights over Bluetooth or Wi-Fi.**

ChromaBay has three parts:

- **An app** (web and iOS, from one SvelteKit + Capacitor codebase) for building patterns,
  previewing them live, and driving your devices. On Android, use the web app in Chrome.
- **Firmware** for ESP32 LED controllers.
- **A pattern engine** in C++ that runs in both places. The firmware compiles it natively and
  the app runs it as WebAssembly, so the preview on your screen matches what the LEDs show.

👉 **Try it now at [chromabay.app](https://chromabay.app).** You don't need hardware or an
account. Browse, preview and edit patterns right away; connect lights when you have them. On
iPhone or iPad, get it from the [App Store](https://apps.apple.com/us/app/chromabay/id6781765952).

---

## Features

- **Node-based pattern editor.** Wire generators (plasma, fire, noise, rainbows, text, SVG
  shapes, raindrops…) into modifiers (blur, mirror, tile, feedback, hue rotate…). About 35
  operators, each with a live thumbnail.
- **Interact mode.** Big knobs and colour wheels for whichever parameters a pattern exposes, with
  optional automation (LFO-style modulation) per control.
- **Multi-device control.** Every connected device mirrors the pattern you're editing. In
  **Cycle** mode, devices play through their own on-device libraries in sync on a shared clock,
  with a crossfade between patterns.
- **Bluetooth LE and Wi-Fi.** Use the same protocol over either transport. Wi-Fi devices are
  discovered automatically (Bonjour/mDNS) on iOS.
- **Arbitrary LED layouts.** Use strips, matrices and multiple outputs. Auto-layout can build a
  2D map of your LEDs from a camera capture.
- **Realtime streaming.** Wi-Fi devices can take Art-Net, sACN (E1.31) and DDP from lighting
  software such as xLights.
- **Firmware management.** Flash a blank ESP32 from the browser over USB, convert an existing
  WLED device, or update over the air (OTA images are signed with ECDSA P-256).
- **Sharing.** Share any pattern as a self-contained link, or publish it to the online gallery.
  An optional account syncs your library across devices.

## Hardware

| | |
|---|---|
| **Controllers** | ESP32, ESP32-S3, ESP32-C3 (4 MB flash or more) |
| **LED chipsets** | WS2812/WS2813/WS2815/SK6812 (RGB), SK6812/WS2814 (RGBW), WS2811 (400 kHz), TM1814, TM1829, APA102/SK9822 (DotStar) |

Any common ESP32 dev board plus an addressable LED strip works. The simplest way to get started:

1. Open [chromabay.app](https://chromabay.app) in desktop Chrome or Edge and plug the board in
   over USB.
2. On the **Devices** tab, go to **Install on a device → Flash a new board over USB**.
3. Once it reboots, connect over Bluetooth, set your LED count, data pin and chipset under
   **Show Settings**, and pick a pattern.

Already running [WLED](https://kno.wled.ge/)? Use **Convert a WLED device** instead. No cable
needed.

> **Browser support:** Bluetooth uses Web Bluetooth, which works in Chrome and Edge on desktop and
> in Chrome on Android. There's no native Android app; Chrome on Android runs the full web app,
> Bluetooth included. USB flashing uses Web Serial and needs desktop Chrome or Edge. On iOS, use
> the [native app](https://apps.apple.com/us/app/chromabay/id6781765952).

## Repository layout

```
src/                 SvelteKit app (routes/ = pages, lib/ = transports, stores, components)
native/              C++ pattern engine and operators (compiled into firmware and to WASM)
esp32/               PlatformIO firmware project
static/native/       Prebuilt WASM build of the pattern engine used by the app
ios/                 Capacitor native shell (android/ is an unsupported leftover)
supabase/            Database migrations for accounts, library sync and the gallery
automation/          Scripts for driving the app and devices in tests
scripts/             Release, signing and asset-generation scripts
documentation/       Design notes and setup guides
```

## Development

### App

Requires Node.js 22 or later.

```bash
npm ci
npm run dev        # dev server on http://localhost:5173
npm test           # unit tests (vitest)
npm run check      # type-check (svelte-check)
npm run build      # static build into build/
```

The app runs without any configuration. Cloud features (accounts, library sync, the gallery) are
switched off unless Supabase is configured; copy `.env.example` to `.env` to set it up. If you
run a fork publicly, point `VITE_SUPABASE_*` and `VITE_SENTRY_DSN` at your own projects.

### Mobile

```bash
npm run build && npx cap sync ios && npx cap open ios   # Xcode
```

See [`documentation/IOS_SETUP.md`](documentation/IOS_SETUP.md) for signing and device setup.

### Firmware

Requires [PlatformIO](https://platformio.org/).

```bash
npm run esp32:build                  # build (cd esp32 && pio run)
npm run esp32:upload                 # flash over USB
npm run esp32:monitor                # serial monitor
```

Build targets are defined in [`esp32/platformio.ini`](esp32/platformio.ini): `esp32dev`,
`esp32-s3` and `esp32-c3`, each with a `-nowifi` variant small enough to update over the air
on older devices that have smaller app partitions. Official OTA images are signed. If you want
your own OTA channel, see [`scripts/signing/README.md`](scripts/signing/README.md). Flashing over
USB never needs a signature.

### Pattern engine (WASM)

Operators live in `native/*Operator.h`. After changing them, rebuild the browser copy with
[Emscripten](https://emscripten.org/):

```bash
npm run wasm:compile                 # native/build-wasm.sh → static/native/fastled.{js,wasm}
```

## Deployment

Pushes to `main` build the app and publish it to GitHub Pages (`chromabay.app`), along with a
live-update bundle for the mobile apps. Firmware changes under `esp32/` or `native/` trigger a
separate workflow that builds, signs and publishes firmware for every chip. Both workflows are in
[`.github/workflows/`](.github/workflows/); the external setup (domain, auth email, deep links)
is described in [`documentation/SETUP_GUIDE.md`](documentation/SETUP_GUIDE.md).

## Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run check` before opening
a PR, and describe how you tested anything that touches hardware (board, chipset, transport).

## License

Copyright © 2025–2026 Grant Patterson.

ChromaBay is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE) as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY
WARRANTY; see the license for details.

ChromaBay builds on open-source components such as FastLED, NimBLE-Arduino, NeoPixelBus,
Svelte, Capacitor and the Spleen font. Their licenses and attributions are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
