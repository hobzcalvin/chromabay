# ESP32 + app driving harness

`drive.mjs` runs the whole loop in one shot: reflash the USB-connected ESP32 →
tail its serial console → launch Chrome → auto-accept the Web Bluetooth chooser
via CDP → drive the app UI → watch the device react on serial.

## Run

```bash
# 1. In one terminal, the app dev server must be running:
npm run dev

# 2. In another terminal:
npm run drive                  # reflash + drive, run the flow, then EXIT (status 0/1)
npm run drive -- --no-flash    # skip reflash, just drive the browser
npm run drive -- --keep-open   # stay open after the flow (browser + serial) to poke
```

By default the harness runs the flow then exits with a status code, so it works as
an automated check (and can be driven by an agent). The serial console is read via
`stty` + `cat` on the port — NOT `pio device monitor`, whose miniterm needs an
interactive TTY and crashes when launched headlessly.

Env overrides: `APP_URL` (default `http://localhost:5173/devices`), `ESP32_DIR`
(default `./esp32`), `PIO` (default `~/.platformio/penv/bin/pio`).

Output is colour-tagged: `[drive]` orchestration, `[esp32]` serial, `[browser]`
page console.

## Which device it drives (read this before running)

Several real ChromaBay installations — **Portal**, **Butterfly** — are usually powered and in
BLE range of this bench. This harness connects to a device and can flash firmware to it, so it
targets **exactly one** device and ignores the rest:

- By default the target is the device on the USB cable, identified by the `Device name: X`
  line it prints on boot. A BLE scan cannot tell which device is on the cable; the banner can.
- `DEVICE_NAME=ChromaBay_ED30` overrides it with an exact name.
- `DEVICE_NAME_RE=...` still takes a pattern, for when you genuinely want one.
- With no name and no serial port it refuses to run rather than pick whichever device answers
  the scan first.

The chooser logs every device it declines, so "it never connected" can never be confused with
"it connected to something else".

## How the hands-free BLE connect works

Web Bluetooth's `navigator.bluetooth.requestDevice()` requires a user gesture and
shows a native chooser you can't dismiss from the page. The harness sidesteps it
with the Chrome DevTools Protocol `DeviceAccess` domain:

- `DeviceAccess.enable` on a **browser-level** CDP session.
- On `DeviceAccess.deviceRequestPrompted`, pick only the exact USB-derived device name
  (unless an explicit `DEVICE_NAME_RE` override was supplied) and answer with
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

## Wi-Fi bulk-transfer checks

After identifying the USB device and its IP from that device's own serial boot banner:

```bash
# Generated sizes avoid needing a saved ledmap. Use a disposable/empty strip and clean up.
node automation/layout-roundtrip.mjs 192.168.x.x --strip=1 --clear-after 8x8 48x22

# Full image transfer + reboot. Exact DEVICE_INFO name is mandatory; unsigned is explicit.
node automation/wifi-ota.mjs 192.168.x.x esp32/.pio/build/esp32-s3/firmware.bin \
  --expect-name=ChromaBay_ED30 --unsigned
```

Neither script discovers or picks a network device. The host must come from the USB target's
serial banner; `wifi-ota.mjs` additionally refuses to write unless `DEVICE_INFO.name` is the
exact expected name.
