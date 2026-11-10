# Building in a cloud (Claude Code / CI-like) session

Both native toolchains install from package managers in a fresh Ubuntu 24.04 container, with no
hand-cloned SDKs:

```sh
# Firmware: PlatformIO from PyPI. Its first run downloads the espressif32 platform and the
# Xtensa/RISC-V toolchains (~1–2 min per env after that).
pip install platformio
(cd esp32 && pio run -e esp32-s3)          # or -e esp32dev -e esp32-c3, or plain `pio run`

# Pattern engine (WASM): the distro's emscripten. native/build-wasm.sh uses ~/emsdk when it is
# there and otherwise any emcc on PATH.
apt-get install -y emscripten               # emcc 3.1.6 on Ubuntu 24.04
bash native/build-wasm.sh                   # clones the pinned FastLED, writes static/native/
```

Behind a TLS-intercepting proxy, point Python at its CA bundle before the first `pio run`
(`export REQUESTS_CA_BUNDLE=... SSL_CERT_FILE=...`); PlatformIO's downloader does not read the
system store on its own in every version.

The distro emcc (3.1.6) is older than the emsdk the committed build used, but its output renders
identically: every operator was compared frame by frame across five timestamps against the
emsdk build (`fire`, `movingblob` and `raindrops` differ only in their random sequences).
Rendering checks that need no browser: `node esp32/test/emu/...` loads the WASM straight into
Node (see `wasmEngine()` in `esp32/test/emu/lib/leds.mjs`), and so does
`src/lib/tests/operators.test.ts`.
