#!/usr/bin/env bash
# Build a single merged ESP32 flash image + an esp-web-tools manifest for the in-app USB flasher
# (the "Flash over USB" button, à la install.wled.me). Output goes to static/firmware/ so the web
# app serves it same-origin. Run after firmware changes (and as part of the web release).
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=esp32/.pio/build/esp32dev
OUT=static/firmware
PIOPY="$HOME/.platformio/penv/bin/python"   # has pyserial / esptool deps
ESPTOOL="$(ls "$HOME"/.platformio/packages/tool-esptoolpy/esptool.py)"
BOOT_APP0="$(ls "$HOME"/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin)"

echo "▶ building firmware…"
( cd esp32 && pio run )

mkdir -p "$OUT"
echo "▶ merging flash image…"
"$PIOPY" "$ESPTOOL" --chip esp32 merge_bin -o "$OUT/chromabay-esp32.bin" \
  --flash_mode dio --flash_freq 80m --flash_size 4MB \
  0x1000 "$BUILD/bootloader.bin" \
  0x8000 "$BUILD/partitions.bin" \
  0xe000 "$BOOT_APP0" \
  0x10000 "$BUILD/firmware.bin"

VER="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
cat > "$OUT/chromabay-manifest.json" <<JSON
{
  "name": "ChromaBay",
  "version": "$VER",
  "new_install_prompt_erase": true,
  "builds": [
    { "chipFamily": "ESP32", "parts": [ { "path": "chromabay-esp32.bin", "offset": 0 } ] }
  ]
}
JSON

echo "✅ wrote $OUT/chromabay-esp32.bin ($(du -h "$OUT/chromabay-esp32.bin" | cut -f1)) + chromabay-manifest.json (version $VER)"
