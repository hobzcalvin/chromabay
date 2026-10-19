# Running the firmware in esp32sim

[esp32sim](https://github.com/mikroverk/esp32sim) is an ESP32 emulator written in Rust. It boots the
mask ROM, the real second-stage bootloader and an unmodified application image, and it models the
board around the chip. It runs about 30x faster than real time on a laptop and has no hardware in
the loop. That makes it a candidate for firmware tests in CI.

This note records what was tried against ChromaBay (fwv0.1.149, ESP32-S3, Arduino 2.0.17 /
IDF 4.4.7, NimBLE-Arduino 1.4.3, NeoPixelBus 2.8.4) and what came out of it.

## What works

| | Status |
|---|---|
| Boot of the released `chromabay-factory.bin` (`--flash-image`) | works: LittleFS formats, config loads, renderer starts |
| BLE (`--ble --elf firmware.elf`) | works: advertises, accepts a connection, all 26 GATT endpoints discovered |
| GATT read/write from a script | works: brightness, device name and device info round-trip |
| Pattern renderer | runs at ~24 fps of emulated time |
| WS2812 output | decoded from the RMT symbol stream, but only on the `atech14` board's pins (GPIO 8 ring, GPIO 6/43 grids) |
| Wi-Fi | not tried. The emulator joins a virtual AP and NATs *outbound* traffic, but has no inbound port forwarding yet, so a host process can't reach the device's WebSocket server |

Without `--ble` the firmware hangs in `NimBLEDevice::init`, because there's no controller.
Everything up to that point still runs.

### What `--ble` needs from the build

- **The unstripped `firmware.elf`.** Releases ship only `.bin`, so this means a local or CI build.
- **A `_bt_controller_bss_start` / `_bt_controller_bss_end` symbol pair over at least 512 bytes of
  DRAM.** IDF 5 defines these; IDF 4.4 does not (its `_bt_bss` range is empty), and esp32sim
  refuses to start. A test-only source file is enough:

  ```c
  // Emulator-only: IDF 4.4 has no _bt_controller_bss_* range; esp32sim --ble needs 512 bytes of DRAM.
  __attribute__((used, aligned(16), section(".bss.emu_bt_bss"))) static unsigned char emu_bt_bss[1024];
  __asm__(".global _bt_controller_bss_start\n.set _bt_controller_bss_start, emu_bt_bss\n"
          ".global _bt_controller_bss_end\n.set _bt_controller_bss_end, emu_bt_bss + 1024\n");
  __attribute__((constructor)) static void emu_bt_keep(void) { __asm__ volatile("" :: "r"(emu_bt_bss)); }
  ```

  The constructor stops `--gc-sections` from dropping the buffer. It could live behind a
  `CHROMABAY_EMU` build flag in a dedicated `[env:esp32-s3-emu]`. The other option is asking
  upstream to accept a different scratch region on IDF 4.4.

### Recipe

```sh
cargo build --release                        # in an esp32sim checkout
tools/fetch-demo-assets.sh --no-linux        # mask ROMs
B=esp32/.pio/build/esp32-s3
esp32sim --boot rom --rom web/wasm/fw/esp32s3_rev0_rom.elf \
    --bootloader $B/bootloader.bin --ptable $B/partitions.bin --app $B/firmware.bin \
    --elf $B/firmware.elf --ble --script ble.txt --board none --console all --max-seconds 8
```

`ble.txt` is in emulated seconds. Handles come from `ble discover`: brightness is `0x002c`,
device name `0x002f` and device info `0x0011`.

```text
3.0 ble connect
3.2 ble discover
4.0 ble read 0x002c
4.1 ble write 0x002c 80
4.5 ble read 0x002c
```

To see LED colours, build with `-D CHROMABAY_DEFAULT_LED_PIN=8` and run with `--board atech14`.
The exit report prints `[emu] ring: N updates, leds [...]` (the first 12 LEDs). `--web PORT` streams
`{"t":"ring","leds":[...]}` frames on `ws://127.0.0.1:PORT/ws`.

Limits of the virtual BLE link: one unencrypted connection, ATT MTU 23, and writes of 20 bytes or
fewer. The firmware's own MTU 517 is never negotiated. OTA chunks and large pattern syncs would need
splitting, or MTU support upstream.

## Findings from the first session

These came out of a couple of hours of poking. Each one was traced to the firmware source, not
just observed in the emulator.

1. **On dithered strips, colours written through `LedManager::setPixelColor(strip, i, CRGB)` never
   reach the LEDs.** That overload packs the colour into a `uint32_t` and calls the raw
   `LedBus::setPixelColor(uint16_t, uint32_t)`, which writes straight to NeoPixelBus. With
   dithering on (the default whenever the estimated show rate allows it, e.g. 64 WS2812s),
   `LedManager::show()` calls `ditherShow()`. That rewrites every pixel from `_ditherTarget`, which
   the raw path never set, so the strip goes out black. Affected:
   - the boot R/G/B self-test (`main.cpp`, "Power-on test"), which is invisible on such strips;
   - realtime streaming. `setGlobalPixel()` (Art-Net/sACN/DDP) uses the same overload, so streamed
     frames should also come out black on a dithered strip.

   Routing the overload to `LedBus::setPixelColor(uint16_t, const CRGB&)` made the self-test
   frames appear in the emulator. That path also applies the gamma LUT and brightness, which may
   not be wanted for streamed DMX. Decide that before changing it.

2. **Renaming the device to 10 characters or fewer leaves a dangling name in the scan
   response.** At boot, "ChromaBay_XXXX" doesn't fit next to the 128-bit service UUID, so
   NimBLE-Arduino 1.4.3 moves it into the scan response (`m_scanData.name` = pointer into
   `m_name`). `processDeviceName()` → `setName()` replaces `m_name` but never clears
   `m_scanData`. A short new name now fits in the advertisement itself. The scan response still
   points at the freed old buffer, with the old length, and the emulator showed
   `"EmuLight\0_1B44"` there. Scanners that prefer the scan-response name (iOS does) may show
   garbage. Possible fixes: re-create the scan response on rename, or upgrade NimBLE.

3. **Worth a check on a real strip: colour order may be applied twice.** The default
   `ColorOrderValue::GRB` swaps R and G in `LedWrapper::setPixelColor`, and the bus is
   `NeoGrbFeature`, which already sends G first. In the emulator (which decodes the wire as GRB,
   like a WS2812), the self-test's red frame came out green. History before `d2d4e8d` is squashed,
   so it isn't clear whether the app's GRB default was chosen to compensate for this.

## What it could be used for

- **Firmware smoke test in CI**: boot the S3 build, assert "Setup complete" and the advertised
  name, connect, read device info. It takes seconds, and would have caught a boot loop or a
  LittleFS mount regression after a core bump (see the pin comment in `platformio.ini`).
- **GATT protocol tests**: script reads and writes against every endpoint. Assert on the console
  log and on the `[ble]` read values. Notifications are subscribable (`ble subscribe CCC`).
- **Pixel tests**: run a known pattern on the `atech14` ring or grids and compare the decoded
  colours with the WASM build of the same engine (`static/native/`). That's an end-to-end check
  that the device output matches the app's preview, colour order and dithering included.
- **OTA validation**: boot an image, check that rollback is marked valid, and reboot into it.
  Needs MTU or chunking support for the BLE path.
- **Crash triage**: `--elf` gives symbolised traces, and `--break`, `--watch`, `--peek` and
  `--trace-fn` work on the real firmware. That's how findings 1 and 2 were tracked down.
- **Later, when esp32sim gains inbound forwarding or mDNS**: Wi-Fi transport tests, and
  Art-Net/DDP streaming from xLights-style senders.
- **Classic ESP32 and C3**: the factory images for both exist. C3 `--ble` is supported, and the
  classic `--chip esp32` is listed as early. Not tried yet.
