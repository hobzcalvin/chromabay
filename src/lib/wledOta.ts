// Convert a WLED device to ChromaBay over its own Wi-Fi access point.
//
// WLED exposes POST /update (multipart/form-data, file field "update"). Sending
// `skipValidation=1` bypasses WLED's firmware-metadata gate, so a ChromaBay image can be
// flashed onto a device currently running WLED — the same trick as uploading a .bin in
// the WLED web UI, but driven by the app. Intended for use over the device's own AP
// (WLED-AP → http://4.3.2.1), so you can convert a device you can't easily USB-flash.
//
// NATIVE ONLY. A secure web page (https://chromabay.app) is hard-blocked from making
// cleartext http requests ("mixed content"), so this cannot run in the browser — only in
// the iOS app, which reaches 4.3.2.1 via the NSAppTransportSecurity exception in
// ios/App/App/Info.plist. Pair it with the offline firmware cache (firmwareCache.ts):
// prefetch the image while online, then convert while joined to WLED-AP (no internet).
//
// Constraints:
//  - The phone must already be joined to the device's Wi-Fi AP. iOS can't auto-join an
//    arbitrary network without the Hotspot-Configuration entitlement, so the user joins
//    "WLED-AP" (password wled1234) in Settings first; the UI hand-holds this.
//  - WLED sends no CORS headers and reboots on success, so the POST response is usually
//    unreadable — success is best-effort (the device rebooting / its LEDs changing is the
//    real confirmation). NEEDS validation on real hardware, incl. that ChromaBay's app
//    image is partition-compatible with the WLED install it overwrites.

// WLED's default access-point gateway / captive-portal IP + credentials.
export const WLED_AP_HOST = '4.3.2.1';
export const WLED_AP_SSID = 'WLED-AP';
export const WLED_AP_PASS = 'wled1234';

export interface WledFlashResult {
  // True only if we positively read a 2xx from the device. When false but no error was
  // thrown, the upload was sent but the response couldn't be read (CORS/reboot) — it most
  // likely still worked; confirm by watching the device.
  confirmed: boolean;
}

/**
 * Upload a firmware image to a WLED-style HTTP /update endpoint.
 * @param bin   raw firmware .bin bytes (the OTA app image, e.g. from the offline cache)
 * @param host  device IP/host (default WLED-AP gateway 4.3.2.1)
 */
export async function flashFirmwareViaWledHttp(
  bin: ArrayBuffer,
  host: string = WLED_AP_HOST,
  onProgress?: (msg: string) => void
): Promise<WledFlashResult> {
  const url = `http://${host}/update`;
  onProgress?.(`Uploading ${Math.round(bin.byteLength / 1024)} KB to ${host}…`);

  // multipart/form-data with the exact field names WLED expects. FormData sets the
  // boundary and Content-Length automatically.
  const form = new FormData();
  form.append('skipValidation', '1'); // bypass WLED's firmware-metadata/version check
  form.append('update', new Blob([bin], { type: 'application/octet-stream' }), 'firmware.bin');

  try {
    const resp = await fetch(url, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`Device returned HTTP ${resp.status}`);
    onProgress?.('Upload complete — device is rebooting.');
    return { confirmed: true };
  } catch (e) {
    // A POST to a no-CORS endpoint that then reboots typically rejects here even on
    // success, so we surface it as inconclusive rather than a hard failure.
    onProgress?.('Upload sent. If the device reboots / its LEDs change, it worked.');
    console.warn('[WLED OTA] POST response unreadable (expected on success/reboot):', e);
    return { confirmed: false };
  }
}
