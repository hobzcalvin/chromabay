#!/usr/bin/env bash
# Dev flash+monitor for whatever ESP32 is actually plugged in. Now that the project builds
# three chip envs (esp32dev / esp32-s3 / esp32-c3), a bare `pio run --target upload` tries to
# flash ALL of them and fails on the boards that aren't connected. This detects the connected
# chip, uploads only the matching env to that exact port, then opens the serial monitor there.
#
#   bash esp32/scripts/flash-dev.sh              # auto-detect the one connected board
#   bash esp32/scripts/flash-dev.sh esp32-c3     # force an env when several are connected
set -euo pipefail
cd "$(dirname "$0")/.."   # -> esp32/

PIOPY="$HOME/.platformio/penv/bin/python"
ESPTOOL="$(ls "$HOME"/.platformio/packages/tool-esptoolpy/esptool.py 2>/dev/null | head -1 || true)"
FORCE_ENV="${1:-}"

chip_to_env() { case "$1" in ESP32-S3) echo esp32-s3;; ESP32-C3) echo esp32-c3;; ESP32) echo esp32dev;; *) echo "";; esac; }

PORT=""; ENV=""
shopt -s nullglob
for p in /dev/cu.usbmodem* /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/ttyUSB* /dev/ttyACM*; do
  [ -e "$p" ] || continue
  chip="$("$PIOPY" "$ESPTOOL" --port "$p" --connect-attempts 1 chip_id 2>/dev/null | grep 'Chip is' | grep -oE 'ESP32(-[SC][0-9])?' | head -1 || true)"
  env="$(chip_to_env "$chip")"
  [ -z "$env" ] && continue
  echo "  found $chip ($env) on $p"
  if [ -n "$FORCE_ENV" ]; then
    [ "$env" = "$FORCE_ENV" ] && { PORT="$p"; ENV="$env"; break; }
  elif [ -n "$ENV" ] && [ "$ENV" != "$env" ]; then
    echo "✋ Multiple ESP32s connected. Pick one, e.g.:  npm run esp32:full -- esp32-c3" >&2; exit 1
  else
    PORT="$p"; ENV="$env"
  fi
done

[ -z "$ENV" ] && { echo "✋ No matching ESP32 found on USB${FORCE_ENV:+ for env $FORCE_ENV}." >&2; exit 1; }

echo "▶ flashing $ENV on $PORT"
pio run -e "$ENV" --target upload --upload-port "$PORT"
printf '\a'
if [ -n "${NO_MONITOR:-}" ]; then exit 0; fi
echo "▶ monitoring $PORT (Ctrl-C to exit)"
exec pio device monitor -p "$PORT" --baud 115200
