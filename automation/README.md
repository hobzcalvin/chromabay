# ESP32 + app driving harness

`drive.mjs` runs the whole loop in one shot: reflash the USB-connected ESP32 →
tail its serial console → launch Chrome → auto-accept the Web Bluetooth chooser
via CDP → drive the app UI → watch the device react on serial.

## Run

```bash
# 1. In one terminal, the app dev server must be running:
npm run dev

# 2. In another terminal:
npm run drive                 # reflash + drive
npm run drive -- --no-flash   # skip reflash, just drive the browser
```

Env overrides: `APP_URL` (default `http://localhost:5173/devices`), `ESP32_DIR`
(default `./esp32`), `PIO` (default `~/.platformio/penv/bin/pio`).

Output is colour-tagged: `[drive]` orchestration, `[esp32]` serial, `[browser]`
page console.

## How the hands-free BLE connect works

Web Bluetooth's `navigator.bluetooth.requestDevice()` requires a user gesture and
shows a native chooser you can't dismiss from the page. The harness sidesteps it
with the Chrome DevTools Protocol `DeviceAccess` domain:

- `DeviceAccess.enable` on a **browser-level** CDP session.
- On `DeviceAccess.deviceRequestPrompted`, pick the device whose name matches
  `DEVICE_NAME_RE` (`/chromabay|esp32|m5/i`) and answer with
  `DeviceAccess.selectPrompt`.
- The harness clicks the app's **"Select ESP32 Device"** button — that click is
  the required user gesture; the CDP handler answers the chooser. The app
  auto-connects on selection.

## First-run friction (expected)

- **macOS Bluetooth permission:** the first time, macOS prompts to grant *Google
  Chrome* Bluetooth access (System Settings → Privacy & Security → Bluetooth).
  Until granted, the chooser finds nothing — grant it and re-run.
- Uses real Google Chrome (`channel: 'chrome'`), headed — Web Bluetooth needs a
  real radio, so this is **local-only**, not CI.
- The ESP32 must be powered, USB-connected, and advertising as `ChromaBay_ESP32`.

## Extending the flow

Edit the `DRIVE` section at the bottom of `drive.mjs`. Pattern:

```js
await page.getByRole('button', { name: /Show Settings/i }).first().click();
// ...change a slider, pick a pattern, etc...
const line = await serial.waitFor(/your expected firmware log/i, 10000);
```

`serial.waitFor(regex, timeoutMs)` resolves when a matching line appears on the
ESP32 console (history is checked first), so you can assert that a UI action
actually reached the device.
