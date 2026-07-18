#!/usr/bin/env bash
# Self-contained WASM build for the ChromaBay operator system.
# NO 3rd-party compile service: just Emscripten (emsdk) + FastLED's stub platform.
#
# Why this exists: FastLED's own wasm playground build (`fastled --web`/Docker)
# pins a fixed -sEXPORTED_FUNCTIONS list that drops our custom C API, and uses
# -pthread (workers/SharedArrayBuffer/WASI) the app can't load. We instead force
# FastLED's STUB platform (-DFASTLED_STUB_IMPL, no hardware), single-threaded,
# and export OUR operator API. Output matches src/app.html's loader
# (MODULARIZE + EXPORT_NAME=fastled).
#
# Prereqs: emsdk at ~/emsdk (https://github.com/emscripten-core/emsdk),
#          FastLED source at $FASTLED_SRC (default /tmp/fastled-src/src).
# Usage:   bash native/build-wasm.sh   (then verify with `npm run verify:wasm`)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Pinned FastLED for reproducible builds. If FASTLED_SRC isn't provided, bootstrap
# a checkout at the pinned commit into native/.fastled-src (gitignored).
FASTLED_COMMIT="${FASTLED_COMMIT:-fe5c638030de}"  # FastLED 3.10.3
if [ -z "${FASTLED_SRC:-}" ]; then
  FLDIR="$(cd "$(dirname "$0")" && pwd)/.fastled-src"
  if [ ! -d "$FLDIR/src" ]; then
    echo "Bootstrapping FastLED @ $FASTLED_COMMIT into $FLDIR ..."
    git clone --filter=blob:none https://github.com/FastLED/FastLED.git "$FLDIR" >/dev/null 2>&1
    git -C "$FLDIR" checkout -q "$FASTLED_COMMIT" || echo "WARN: pinned commit checkout failed; using current default branch"
  fi
  FASTLED_SRC="$FLDIR/src"
fi
OUT="$HERE/fastled_js"
# shellcheck disable=SC1090
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
mkdir -p "$OUT"

DEFINES="-DFASTLED_STUB_IMPL=1 -DFASTLED_FORCE_NAMESPACE=1 -DFASTLED_USE_PROGMEM=0 -DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0"
# -O3 (optimize for SPEED), not -Oz (size): the operators run per-pixel math
# (noise, HSV, sin/cos) every frame; -Oz deoptimizes those tight loops badly
# (~500ms/render -> ~2fps). -O3 inlines/vectorizes them.
CFLAGS="-std=c++20 -fpermissive -fno-exceptions -fno-threadsafe-statics -O3 -I$FASTLED_SRC -I$HERE"

EXPORTS="['_getOperatorCount','_getOperatorName','_getOperatorDisplayName','_getOperatorParameterCount','_getOperatorParameterInfo','_createOperatorInstance','_destroyOperatorInstance','_setOperatorFloatParameter','_setOperatorIntParameter','_setOperatorBoolParameter','_setOperatorColorParameter','_setOperatorStringParameter','_setOperatorModulator','_clearOperatorModulator','_evalModulator','_renderOperator','_setWallClock','_clearBuffer','_malloc','_free']"
RUNTIME="['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','getValue']"

# FastLED unity bundles. Start with the minimum and add as the linker demands.
BUNDLES="${BUNDLES:-fl.gfx fl.math}"
FL_SRCS=""
for b in $BUNDLES; do
  f="$FASTLED_SRC/fl/build/${b}+.cpp"; [ -f "$f" ] || f="$FASTLED_SRC/fl/build/${b}.cpp"
  [ -f "$f" ] && FL_SRCS="$FL_SRCS $f" || echo "WARN: bundle $b not found"
done

cp "$HERE/operator_system.ino" /tmp/operator_system.cpp

emcc $CFLAGS $DEFINES \
  /tmp/operator_system.cpp \
  "$HERE/fastled_min.cpp" \
  $FL_SRCS \
  -sMODULARIZE=1 -sEXPORT_NAME=fastled \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME" \
  -Wl,--gc-sections \
  -o "$OUT/fastled.js"

# Deploy into the app's static dir (what src/app.html loads).
cp "$OUT/fastled.js" "$OUT/fastled.wasm" "$HERE/../static/native/"

# Stamp a content version. app.html appends this as a ?v= cache-buster on the .js/.wasm
# loads, so the browser fetches a freshly-built module instead of serving a stale cached
# fastled.wasm across reloads — but only re-downloads when the content actually changes.
VER="$(shasum "$HERE/../static/native/fastled.wasm" | cut -c1-12)"
printf 'window.__WASM_VERSION="%s";\n' "$VER" > "$HERE/../static/native/wasm-version.js"
echo "✅ built + deployed to static/native -> fastled.{js,wasm} (v$VER)"
ls -la "$HERE/../static/native/fastled.js" "$HERE/../static/native/fastled.wasm"
