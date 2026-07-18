#!/usr/bin/env bash
# Build merged ESP32 flash images (one per chip) + an esp-web-tools manifest for the in-app
# USB flasher (the "Flash over USB" button, à la install.wled.me). esp-web-tools auto-detects
# the connected chip and picks the matching build from the manifest. Output goes to
# static/firmware/ so the web app serves it same-origin. Run after firmware changes.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=static/firmware
PIOPY="$HOME/.platformio/penv/bin/python"   # has pyserial / esptool deps
ESPTOOL="$(ls "$HOME"/.platformio/packages/tool-esptoolpy/esptool.py)"
# boot_app0.bin (initial otadata) is the same for every ESP32 variant.
BOOT_APP0="$(ls "$HOME"/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin)"

echo "▶ building firmware (all chips)…"
( cd esp32 && pio run )

mkdir -p "$OUT"

# One row per chip:  pio env | esptool --chip | esp-web-tools chipFamily | bootloader offset | flash size
# Classic ESP32 keeps its bootloader at 0x1000; ESP32-S3/C3 (and other newer parts) at 0x0.
# S3 boards here are N8 (8MB) and use the 8MB partition table — the merged image must match.
VARIANTS=(
  "esp32dev|esp32|ESP32|0x1000|4MB"
  "esp32-s3|esp32s3|ESP32-S3|0x0|8MB"
  "esp32-c3|esp32c3|ESP32-C3|0x0|4MB"
)

BUILDS_JSON=""
for row in "${VARIANTS[@]}"; do
  IFS='|' read -r ENV CHIP FAMILY BOOTOFF FLASHSZ <<< "$row"
  B="esp32/.pio/build/$ENV"
  IMG="chromabay-$CHIP.bin"
  echo "▶ merging $FAMILY image ($IMG)…"
  # USB flashing a blank board needs bootloader + partition table + boot_app0 + app in one
  # image at offset 0. Merge them from THIS build so the USB flasher and OTA are always the
  # same firmware — no separately-committed .bin anywhere.
  "$PIOPY" "$ESPTOOL" --chip "$CHIP" merge_bin -o "$OUT/$IMG" \
    --flash_mode dio --flash_freq 80m --flash_size "$FLASHSZ" \
    "$BOOTOFF" "$B/bootloader.bin" \
    0x8000 "$B/partitions.bin" \
    0xe000 "$BOOT_APP0" \
    0x10000 "$B/firmware.bin"
  BUILDS_JSON="${BUILDS_JSON}{ \"chipFamily\": \"$FAMILY\", \"parts\": [ { \"path\": \"$IMG\", \"offset\": 0 } ] },"
done
BUILDS_JSON="${BUILDS_JSON%,}"   # strip trailing comma

VER="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
cat > "$OUT/chromabay-manifest.json" <<JSON
{
  "name": "ChromaBay",
  "version": "$VER",
  "new_install_prompt_erase": true,
  "builds": [ $BUILDS_JSON ]
}
JSON

echo "✅ wrote per-chip images + chromabay-manifest.json (version $VER) to $OUT/"
