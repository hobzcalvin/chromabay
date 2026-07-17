// The ESP32 chip families ChromaBay builds for, in the order we present them. This is the
// single source of truth shared by the firmware CI (which publishes one build per `chip`),
// the OTA registry/selection logic (DeviceInfo.chip / FirmwareRegistryEntry.chip), and the
// download UI. `chip` matches esptool's --chip name and the device-reported chip; `family`
// matches esp-web-tools' chipFamily in the manifest.
//
// Only BLE-capable variants are here: ESP32-S2 and ESP8266 have no Bluetooth, so ChromaBay
// (BLE-first) can't run on them even though WLED does.

export interface ChipVariant {
  chip: string;      // esptool --chip / device-reported / registry `chip`
  family: string;    // esp-web-tools chipFamily
  label: string;     // human name
  examples: string;  // representative boards
  which: string;     // "which one do I need" guidance
  recommended?: boolean;
}

export const CHIP_VARIANTS: ChipVariant[] = [
  {
    chip: 'esp32',
    family: 'ESP32',
    label: 'ESP32 (classic)',
    examples: 'Most WLED controllers, ESP32-WROOM/WROVER, ESP32-PICO-D4, M5 Atom Lite/Matrix',
    which: 'The original dual-core ESP32 — by far the most common. If your board doesn’t clearly say “S3” or “C3”, pick this.',
    recommended: true,
  },
  {
    chip: 'esp32s3',
    family: 'ESP32-S3',
    label: 'ESP32-S3',
    examples: 'M5 AtomS3 / AtomS3-Lite, Seeed XIAO ESP32-S3, ESP32-S3 devkits',
    which: 'Newer dual-core with native USB. Choose this only if the board is explicitly labelled “S3”.',
  },
  {
    chip: 'esp32c3',
    family: 'ESP32-C3',
    label: 'ESP32-C3',
    examples: 'Seeed XIAO ESP32-C3, ESP32-C3 super-mini',
    which: 'Small single-core RISC-V board. Choose this only if the board is explicitly labelled “C3”.',
  },
];

/** Where a given version's images live on gh-pages (mirrors the firmware CI layout). */
export function firmwareUrls(version: string, chip: string) {
  const base = `https://chromabay.app/firmware/esp32/${version}/${chip}`;
  return {
    factory: `${base}/chromabay-factory.bin`, // full merged image (USB / esptool)
    app: `${base}/firmware.bin`,              // app image (BLE OTA / WLED manual upload)
    sig: `${base}/firmware.sig`,              // ECDSA signature for the app image
  };
}
