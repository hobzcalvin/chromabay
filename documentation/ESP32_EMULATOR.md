# Running the firmware in esp32sim

[esp32sim](https://github.com/mikroverk/esp32sim) is an ESP32 emulator written in Rust. It boots the
mask ROM, the real second-stage bootloader and an unmodified application image, and it models the
board around the chip. It runs well ahead of real time (a 10 s scenario takes about 3 s on a
laptop) and has no hardware in the loop, so CI uses it for firmware tests:
`.github/workflows/firmware-emu.yml`, with the test logic in `esp32/test/emu/`.

Started from fwv0.1.149 (Arduino 2.0.17 / IDF 4.4.7, NimBLE-Arduino 1.4.3, NeoPixelBus 2.8.4),
esp32sim pinned at `f535f3b42293a76ab64c231a0425f35857ab6cf1`.

## Running the tests

```sh
esp32/test/emu/setup-esp32sim.sh                          # clone + patch + build esp32sim, fetch ROMs
(cd esp32 && pio run -e esp32-s3-emu -e esp32-c3-emu -e esp32dev)
npm ci                                                    # the tests use the app's msgpack + WASM
node esp32/test/emu/run.mjs                               # all scenarios, ~30 s
node esp32/test/emu/run.mjs selftest roundtrip            # some; --list names them
```

`setup-esp32sim.sh` needs git, cargo and curl and puts the emulator in `esp32/test/emu/.esp32sim`
(`ESP32SIM_DIR` points elsewhere). Each emulator run's complete output (console, `[ble]` events,
`[leds]` frames, exit report) is saved to `esp32/test/emu/out/<scenario>.log`, next to the script
it ran. CI uploads that directory when a run fails. A failure message says what was expected and
what happened, including the ring's colours over time for LED checks.

## What each scenario guards

| Scenario | Guards |
|---|---|
| `boot-smoke` | S3 reaches `Setup complete` with no panic, Guru Meditation, abort, assert, watchdog or unexpected reset; advertises service `a0be83e4-…` and the name `ChromaBay_XXXX`; accepts a connection |
| `fresh-flash` | Blank flash: LittleFS formats and a default config is created. A library pattern is stored, then a software reset reboots on the same flash: it mounts without reformatting, loads the config and still has the pattern, which plays. This is the "core bump silently loses patterns" risk in `platformio.ini` |
| `gatt` | Every row of `ENDPOINTS` in `main.cpp` is served with the table's properties, every notifying one has a CCC, and nothing else is in the service. The expectations are parsed from the source, so the test fails when the table and the GATT server drift apart |
| `roundtrip` | Brightness write/read (default 20); device info JSON (`fw_ver`, `chip`, `name`, `feat`, via Read Blob); comm config JSON; button pin write/read; device name write/read, renaming long→short→long→short, with each new advert carrying exactly one name (**bug 2 regression**). Then a reboot: name, brightness and button pin persist and the boot advert uses the new name |
| `selftest` | The power-on R, G, B frames reach a dithered 64-LED strip in order, ~0.5 s each at the default brightness, then black (**bug 1 regression**). The expected wire colours encode the current colour order (see finding 3) |
| `pattern` | Patterns pushed in the app's wire format (`@msgpack/msgpack`, `[u16 total][u16 offset]` chunks of 20 bytes) play, and the ring matches the app's WASM engine (`static/native/`) pixel for pixel: a solid colour and a hue/saturation/value ramp |
| `brightness` | Brightness changes mid-pattern scale the ring: 255 → 64 → 8 → 0 (black, then no more frames) |
| `playlist` | Two library pushes (both acknowledged on PATTERN_SYNC), a TIMESTAMP_SYNC and a 2 s PLAYLIST_SYNC: the ring goes A, B, A, B with each switch within 150 ms of the synced clock's boundary |
| `blink-calibration` | Blink Pins drives the LED pin by GPIO for 10 s (≥ 9 edges, no RMT frames meanwhile) and restores the pattern. Calibration mode 2 holds every LED at the requested level, mode 1 shows the all-on frame and the bit-plane frames (LED *i* lit iff bit *b* of *i*), and STOP restores the pattern |
| `c3-boot` | ESP32-C3 (single core) boots with BLE, advertises, connects and serves device info with `chip: esp32c3` |
| `esp32-boot` | Classic ESP32 (`esp32dev`, the release env) boots through LittleFS, config, LEDs and the renderer to `NimBLEDevice::init`, cleanly. See the limits below for what happens next |
| `release-images` | The factory images listed in the published manifest (`https://chromabay.app/firmware/esp32/chromabay-manifest.json`, i.e. gh-pages) boot to the NimBLE init on S3, C3 and ESP32, and report the manifest's version. No ELF, so no BLE |
| `lane-repack` | `esp32/test/lane_repack_test.cpp`, the host test of the lane re-packer, compiled with the host C++ compiler and run |

Both bug regressions were checked against the unfixed code. With the old `led_manager.h`,
`selftest` fails with "expected 3 coloured test frames, saw 0" and the ring is black throughout.
With the old `processDeviceName()`, `roundtrip` fails with
`advert … carries 2 name(s) "EmuLight", "EmuLight\u0000_1B44"`.

## How the tests see the device

### Builds

`[env:esp32-s3-emu]` and `[env:esp32-c3-emu]` in `platformio.ini` extend the release envs with
`-D CHROMABAY_EMU=1`. That compiles in `src/emu_bt_shim.c`, which on a release build is an empty
translation unit: the release images were compared before and after and are byte-for-byte
identical. The S3 emu env also moves the default LED pin to 8. The release workflow skips both
envs (`skip-environments` in `esp32-release.yml`), so they are never built for release,
published or uploaded to Sentry.

- **The BLE shim.** `--ble` needs the unstripped ELF and a
  `_bt_controller_bss_start`/`_bt_controller_bss_end` pair over at least 512 bytes of DRAM, as
  scratch for the controller task esp32sim injects. IDF 5 defines these; IDF 4.4 doesn't (its
  `_bt_bss` range is empty), and esp32sim refuses to start. The shim reserves 1 KB and names it.
  A constructor stops `--gc-sections` from dropping it.
- **LED pin 8.** esp32sim decodes WS2812 output only on its `atech14` board model: the 12-LED
  ring on GPIO 8 (and two 3×3 grids on 6 and 43). The default 64-LED strip on pin 8 therefore
  shows its first 12 LEDs on the ring. The ring reports LEDs in physical order
  (`KNOB_RING_PHYSICAL` in `esp32s3/src/board/atech14.rs`); the tests undo that map. The C3 has
  no LED board in esp32sim, so its emu env keeps the released pin.

### Patches to esp32sim

`esp32/test/emu/patches/` holds a small patch applied on top of the pin by
`setup-esp32sim.sh`. Both parts are general and could go upstream:

- `ESP32SIM_LED_LOG=1` prints every decoded ring update as
  `[leds] t=<s> n=<update> [[r,g,b],...]`, at emulated time. `--web` would also stream frames,
  but it paces the emulator to real time and samples them, so per-frame assertions would be
  slow and miss dither sub-frames.
- `ble read-long HANDLE` does a Read, then Read Blob requests until a reply is shorter than
  MTU − 1, and logs one `read` line with the whole value. Without it, device info, comm config
  and other JSON values come back truncated at 22 bytes.

### Scripts, handles and reboots

A run is driven by an esp32sim `--script` in emulated seconds (`ble connect`, `ble write
HANDLE HEX`, `ble subscribe CCC`, …). BLE commands queue and run one at a time. Handles are
never hard-coded: a discovery run of each build maps UUIDs to value and CCC handles, and the
other scenarios use that map.

A reboot is the script line `poke 60008000 80000000`, which sets `RTC_CNTL_OPTIONS0.SW_SYS_RST`
as `esp_restart()` would. esp32sim reboots through the ROM with flash intact, and the virtual
BLE controller comes back. esp32sim has no option to dump flash at exit, so a second boot of
the same flash happens inside one run rather than via `--flash-image` from a dump.

### Console checks

Every scenario fails on `Guru Meditation`, `panic'ed`, `abort() was called`, `assert failed:`,
`Backtrace:`, task-watchdog and heap-corruption messages, watchdog or CPU-reset boot causes, a
chip reset the scenario didn't cause, an ATT error, or a scripted BLE command that never ran.

## Findings

These came out of the first session in the emulator. Each was traced to the firmware source.

1. **Fixed: on dithered strips, colours written through `LedManager::setPixelColor(strip, i,
   CRGB)` never reached the LEDs.** That overload packed the colour into a `uint32_t` and called
   the raw `LedBus::setPixelColor(uint16_t, uint32_t)`, which wrote straight to NeoPixelBus.
   With dithering on (the default whenever the estimated show rate allows it, e.g. 64 WS2812s),
   `LedManager::show()` calls `ditherShow()`, which rewrites every pixel from `_ditherTarget`,
   which the raw path never set, so the strip went out black. Victims: the boot R/G/B
   self-test, realtime streaming (`setGlobalPixel()`: Art-Net, sACN, DDP), and the "LEDs off" at
   OTA start.

   The overload now goes to a new `LedBus::setPixelColorRaw()`, and the `uint32_t` overload is
   dither-aware too. **Raw** means: the strip's gamma and white-point LUT is *not* applied
   (streaming senders do their own colour correction; this is WLED's default too), while global
   brightness, colour order and RGBW auto-white still are. On a dithering strip the value
   becomes the dither target through an identity curve, at the same brightness scaling a render
   gets. Rendered patterns are unchanged and still use the LUT.

2. **Fixed: renaming to 10 characters or fewer left a dangling name in the scan response.**
   At boot, `ChromaBay_XXXX` doesn't fit next to the 128-bit service UUID, so NimBLE-Arduino 1.4.3
   moves it into the scan response (`m_scanData.name`, a pointer to the GAP name buffer plus a
   length). `setName()` never clears that. After a short rename the new name fits in the
   advertisement, while the scan response still points at the GAP buffer with the old length:
   esp32sim showed `"EmuLight\0_1B44"`, and iOS prefers the scan-response name. The rename now
   calls `configureAdvertising()`, the same function setup uses. It does `reset()` (which
   re-reads the GAP name and empties the scan response) and `removeServices()` (`reset()`
   keeps the UUID list), then adds the service again. NimBLE is not upgraded.

3. **Open: colour order may be applied twice.** With the default `colorOrder` GRB,
   `LedWrapper::setPixelColor` swaps R and G, and the bus is `NeoGrbFeature`, which already
   sends G first. On the wire, red goes out as green: esp32sim decodes the stream as a WS2812
   does (G first) and the self-test's red frame arrives as `[0,20,0]`, green (FastLED's
   `0x008000`) as `[10,0,0]`. History before `d2d4e8d` is squashed, so it isn't clear whether
   the app's GRB default compensates for strips that are actually RGB. **Not changed: this
   needs a check on a real WS2812 strip.** The tests encode today's behaviour in one place,
   `onWire()` / `WIRE_SWAPS_RG` in `esp32/test/emu/lib/leds.mjs`. If the colour order is changed
   on purpose, flip that, and `selftest` and `pattern` check the new order.

## Limits and future work

- **Wi-Fi.** esp32sim joins a virtual AP and NATs outbound traffic, but has no inbound port
  forwarding, so a host process can't reach the device's WebSocket server or send it
  Art-Net/sACN/DDP. Wi-Fi transport tests and streaming tests (which would cover bug 1's other
  victim end to end) wait for inbound forwarding or mDNS upstream.
- **MTU 23.** The virtual link never negotiates the firmware's MTU 517. Writes carry at most
  20 bytes, so pattern pushes are chunked to 16 payload bytes (they work), and notifications are
  truncated to 20 bytes, so LIBRARY_DUMP isn't tested. The virtual central only sends Write
  Requests, and OTA_DATA is write-without-response only, so BLE OTA can't be driven either.
  Both need MTU exchange and Write Command support upstream.
- **Classic ESP32 BLE.** esp32sim's virtual controller covers S3, C3 and C6. On the classic chip
  the firmware runs cleanly up to `NimBLEDevice::init` and then faults inside the BT controller's
  ROM init (`btdm_rom_ref_init`, `StoreProhibited`). `esp32-boot` checks that the run gets that
  far (with `--trace-fn`) and is clean before it. Stubbing `esp_bt_controller_init`/`_enable`
  and `esp_nimble_hci_init` only moves the fault into the NimBLE host (`os_msys_init`), so the
  classic smoke stops at the init rather than pretending to cover BLE.
- **LEDs.** Only the first 12 LEDs of the strip are visible (the atech14 ring), only on the S3,
  and only WS2812. The WASM comparison covers one-node static patterns; a time-varying pattern
  would also need the device's frame clock aligned to the WASM timestamp.
- **Release smoke needs the network** (chromabay.app). It fails rather than skips when the
  manifest or an image can't be fetched.

## Manual runs

Everything the tests do can be done by hand. For example, booting the S3 emu build with BLE and
watching the ring:

```sh
SIM=esp32/test/emu/.esp32sim; B=esp32/.pio/build/esp32-s3-emu
cat > /tmp/ble.txt <<'EOF'
3.0 ble connect
3.2 ble discover
4.0 ble read 0x002c
4.1 ble write 0x002c 80
4.5 ble read-long 0x0011
EOF
ESP32SIM_LED_LOG=1 $SIM/target/release/esp32sim --boot rom --rom $SIM/web/wasm/fw/esp32s3_rev0_rom.elf \
    --bootloader $B/bootloader.bin --ptable $B/partitions.bin --app $B/firmware.bin \
    --elf $B/firmware.elf --ble --script /tmp/ble.txt --board atech14 --console all --max-seconds 6 --no-dump
```

The handles above are this build's (brightness `0x002c`, device name `0x002f`, device info
`0x0011`); `ble discover` prints them. `--web PORT` serves esp32sim's browser UI with the ring
live. `--elf` gives symbolised traces, and `--break`, `--watch`, `--peek` and `--trace-fn` work on
the real firmware; that's how findings 1 and 2 were tracked down. A release image boots with
`--flash-image chromabay-factory.bin` in place of the four image flags (no BLE without the ELF).
