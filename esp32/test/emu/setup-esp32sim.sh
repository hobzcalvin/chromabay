#!/usr/bin/env bash
# Fetch, patch and build esp32sim at the pinned commit, plus the mask ROMs it boots from.
# Used by CI (.github/workflows/firmware-emu.yml) and locally; run.mjs finds the result.
#
#   esp32/test/emu/setup-esp32sim.sh [DIR]      # default: esp32/test/emu/.esp32sim
#
# Idempotent: an existing checkout at the pinned commit with the patch applied is reused, and
# cargo only rebuilds what changed. Needs git, cargo and curl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Bump together with the cache key in firmware-emu.yml (it hashes this file, so it follows).
ESP32SIM_REPO="https://github.com/mikroverk/esp32sim"
ESP32SIM_COMMIT="f535f3b42293a76ab64c231a0425f35857ab6cf1"
DIR="${1:-${ESP32SIM_DIR:-$HERE/.esp32sim}}"

if [ ! -d "$DIR/.git" ]; then
  git clone --quiet "$ESP32SIM_REPO" "$DIR"
fi
cd "$DIR"
if [ "$(git rev-parse HEAD)" != "$ESP32SIM_COMMIT" ]; then
  git fetch --quiet origin "$ESP32SIM_COMMIT" 2>/dev/null || git fetch --quiet origin
  git checkout --quiet --force "$ESP32SIM_COMMIT"
fi

# Our additions on top of the pin, both small and upstreamable (documentation/ESP32_EMULATOR.md):
# ESP32SIM_LED_LOG (every decoded LED frame, at emulated time) and `ble read-long` (Read Blob).
for p in "$HERE"/patches/*.patch; do
  if git apply --check "$p" 2>/dev/null; then
    git apply "$p"
    echo "[setup-esp32sim] applied $(basename "$p")"
  elif git apply --reverse --check "$p" 2>/dev/null; then
    echo "[setup-esp32sim] already applied $(basename "$p")"
  else
    echo "[setup-esp32sim] $(basename "$p") does not apply to $ESP32SIM_COMMIT; reset with: git -C $DIR checkout -f ." >&2
    exit 1
  fi
done

cargo build --release --quiet --bin esp32sim --bin esp32sim-c3

# The mask ROMs. tools/fetch-demo-assets.sh --no-linux gets these too, plus web-UI vendor files
# and a MicroPython image the tests don't use; this is the part of it that fetches the ROMs.
ROMS="esp32s3_rev0_rom.elf esp32c3_rev3_rom.elf esp32_rev300_rom.elf"
missing() { for rom in $ROMS; do [ -f "web/wasm/fw/$rom" ] || return 0; done; return 1; }
if missing; then tools/fetch-rom-elfs.sh web/wasm/fw >/dev/null; fi
if missing; then echo "[setup-esp32sim] mask ROMs missing after fetch: want $ROMS in $DIR/web/wasm/fw" >&2; exit 1; fi
echo "[setup-esp32sim] ready: $DIR/target/release/esp32sim"
