# Hands-free BLE connection for automated testing — findings

Goal: let an automated test connect the web app to the real ESP32 over BLE without a human clicking the browser's Bluetooth chooser.

## The core constraint
Web Bluetooth `navigator.bluetooth.requestDevice()` **requires a user gesture and shows a native device chooser**. There is no in-page API to bypass it. So automation has to drive the chooser from *outside* the page.

## Recommended: Playwright + Chrome DevTools Protocol `DeviceAccess`
Chrome exposes the chooser to CDP. The flow:
1. Launch **headed Google Chrome** (real Chrome, not old-headless — host Bluetooth must be available; macOS will also prompt once to grant Chrome Bluetooth permission).
2. Open a CDP session and enable the device-access domain.
3. When the page calls `requestDevice()`, CDP fires `DeviceAccess.deviceRequestPrompted` with the discovered devices; respond with `DeviceAccess.selectPrompt` to pick the ESP32 by name.

Sketch (Playwright):
```js
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('DeviceAccess.enable');
cdp.on('DeviceAccess.deviceRequestPrompted', async (e) => {
  const esp = e.devices.find(d => /chromabay|esp32|m5/i.test(d.name));
  if (esp) await cdp.send('DeviceAccess.selectPrompt', { id: e.id, deviceId: esp.id });
  else await cdp.send('DeviceAccess.cancelPrompt', { id: e.id });
});
// then trigger the app's "connect" button (which calls requestDevice() under a gesture)
await page.getByRole('button', { name: /connect/i }).click();
```
Notes/caveats:
- Local dev machine only; **not CI-friendly** (needs real radio + a powered ESP32 nearby + macOS BT permission). Good for a "press play and it connects" local E2E loop.
- App must be served over https or `localhost` (Web Bluetooth requirement). The dev server on localhost qualifies.
- Playwright bundles Chromium; for Web Bluetooth use channel `chrome` (`channel: 'chrome'`) so it drives the installed Google Chrome.

## Alternative A: skip the browser, talk to the device with Node `noble`
Use `@abandonware/noble` in a Node script to connect to the ESP32 GATT directly and exercise characteristics (LED config, OTA, timestamp sync). Tests the **firmware/protocol** without the app's Web Bluetooth path. Best for firmware regression tests; does not cover app UI.

## Alternative B: mock `navigator.bluetooth` for UI tests
Inject a fake `navigator.bluetooth` in Playwright to test app logic/rendering deterministically with no hardware. Doesn't validate the real BLE stack but is the only CI-safe option.

## Suggestion
- For the "watch the preview vs hardware in sync" workflow: Playwright + CDP `DeviceAccess` (Alternative recommended), headed `channel: 'chrome'`, local.
- For repeatable firmware checks: a small `noble` harness.
- Don't attempt this in GitHub Actions — no radio.
