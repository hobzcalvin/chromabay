# ChromaBay battery LED controller: board design

Status: **design spec only.** There is no schematic or layout yet. This is the brief to build
the KiCad project from.

A small, long and narrow ESP32-S3 board meant to work as a Swiss Army knife. It:

- charges a single-cell LiPo/Li-ion over USB-C and runs while plugged in
- has a real off switch
- makes a 5 V LED rail
- has 4 level-shifted clock+data outputs (or 8 single-wire ones)
- has an I2S microphone and a 6-axis motion sensor onboard

Think "QT Py S3 + LiPo BFF + boost + level shifter + mic + IMU", in a shape that fits in a wand.

Revision 2 changes: dropped 12 V; LED rail resized to 5 V / 2 A continuous; outputs are 4 ×
clock+data; added mic, IMU, touch pads, external-LED-power mode and friendlier battery pads.
Section 2 explains the trade-offs.

---

## 1. Does this exist off the shelf?

Not as one board. The near misses:

| Board | Has | Missing |
|---|---|---|
| Adafruit QT Py ESP32-S3 + LiPo BFF | S3, LiPo charging | 5 V boost at LED currents, level shifting, mic, IMU |
| Unexpected Maker FeatherS3 / TinyS3, PowerFeather S3, Olimex S3-DevKit-LiPo | S3, charging, power path | Boost, level shifting |
| Adafruit Sparkle Motion, QuinLED Dig-Uno/Quad | Level-shifted outputs | Battery, charger |
| ESP32-S3 Super Mini + TP4056 + boost module + shifter | All the functions, cheap | It's four boards. The TP4056 has no power path, so you can't charge and run at the same time properly. |

**Prototype path until boards arrive:** QT Py ESP32-S3 + LiPo BFF (or PowerFeather) → a
Pololu 5 V step-up rated 2 A+ → 74AHCT125 breakout, plus Adafruit's ICS-43434 and LSM6DS3TR-C
breakouts on STEMMA QT.

---

## 2. Requirements: what was kept, cut or relaxed

| Requirement | Verdict | Why |
|---|---|---|
| **12 V LED rail option** | **Cut.** | It made things worse for almost no gain. Clock+data strips (APA102 / SK9822 / HD107S) are 5 V parts, so 12 V only helped single-wire WS2815-type strips. It cost 25 V caps, a second logic-supply regulator, a 3-pad jumper pair, a gate zener, and ruled out the smaller and cheaper 5 V-only boost chips. Boosting 1S → 12 V is also less efficient. In its place, the **external LED power mode** (section 6) runs a 12 V strip from its own supply while this board sends 5 V data. |
| **5 V @ 3 A continuous** | **Relaxed to 2 A continuous (~3 A short peaks).** | 3 A meant ~5 A out of the battery near empty. That's at or past the charger's battery-FET limit, connector ratings and a sealed wand's heat budget. 2 A is ~3.3 A from the battery. The target (200 LEDs, 4 h, low brightness ≈ 1 A) still has 2× headroom. Firmware power limiting holds the line. |
| **Battery ~500 mAh to ~10 Ah** | **Kept.** | Costs one jumper set (charge current) and some pads. |
| **Charge while running** | **Kept.** | The NVDC charger does this properly. It's the reason not to use a TP4056. |
| **4 × clock+data outputs (8 shifted lines)** | **Kept.** | One 8-channel buffer chip. The hardware is easy; firmware details are in section 10. |
| **Slide switch, externally mountable** | **Kept.** | It's a logic-level switch, so it's free. |
| **0.75" (19 mm) width** | **Kept; costs length.** | Mic + IMU + boost inductor + USB-C all fit across 19 mm. The board just gets longer, est. **80–95 mm** single-sided. Two-sided assembly would get back ~15 mm but raises PCBA cost noticeably. **Tell me the max length** if the wand has a hard limit. |

### Sizing reference

WS2812/APA102-class LEDs draw ~0.5–1 mA each even when dark, and ~60 mA at full white.

| Scenario | Avg mA/LED | LED power | Battery-side W | 4 h energy | 1S capacity |
|---|---|---|---|---|---|
| Very dim | 2 | 2 W | ~2.7 W | ~11 Wh | ~3 Ah (one 18650) |
| **"Low" (target, 200 LEDs)** | 5 | 5 W | ~6 W | ~24 Wh | **~6.5 Ah (two 18650s in parallel)** |
| Board max (2 A cont.) | — | 10 W | ~11.5 W | — | 6.5 Ah lasts ~2 h |

---

## 3. Block diagram

```
USB-C ─ ESD, 5.1k CC ─VBUS─► BQ25606 charger (NVDC path) ─VSYS 3.0–4.4 V─┬─► 3.3 V LDO (EN=SW_ON) ─► ESP32-S3-MINI-1
  │ D+/D- ─► native USB on S3                ▲                          │                         ├─ I2C: MAX17048 gauge, LSM6DS3TR-C IMU, Qwiic
  │ CC1/CC2 ─► ADC (source capability)       │ BAT                      │                         ├─ I2S: ICS-43434 mic
                                     1S battery (JST-PH + big pads, NTC) │                         ├─ touch / spare pads
                                                                         │                         └─ 8 GPIO ─► SN74AHCT245 ─33Ω─► 4× (CLK, DAT)
SLIDE SWITCH (+ ext. pads) ─► SW_ON ─► LDO EN                            │                                          ▲ VCC = 5 V boost out
                                                                         └─► 5 V boost (EN=LED_EN) ─┬─► P-FET load switch (LED_EN) ─► [EXT jumper] ─► 5V/GND output pads
                                                                                                    └─► AHCT245 VCC
```

---

## 4. Part choices

### ESP32-S3 module: **ESP32-S3-MINI-1-N8** (or -N4R2 for PSRAM)
- 15.4 × 20.5 mm, fits across a 0.75" board. Pads underneath, so get boards assembled
  (JLCPCB/PCBWay PCBA). The charger and boost QFNs need that anyway.
- Antenna at the far end of the board, with the datasheet copper keep-out (or overhanging the
  edge).
- Native USB straight to USB-C. ChromaBay's browser flasher already handles S3.

### Charger + power path: **TI BQ25606** (standalone)
- NVDC power path: runs from USB when plugged in, charges with what's left, and pulls extra
  from the battery when the LEDs need more than USB gives.
- **Charge current set by solder jumpers, default 500 mA** (safe for any pack ≥ 500 mAh).
  Bridge for 1 A or 2 A. Firmware can't override it. Rule of thumb: ≤ 0.5C.
- ILIM 3 A. VINDPM backs off on weak USB ports instead of browning out.
- Thermistor (TS): onboard 10 kΩ NTC next to the battery pads by default; jumper to use a pack's
  own thermistor on a 3rd pad.
- ⚠️ **Verify:** `IBATFET_OCP` in the datasheet must comfortably exceed ~3.5 A (2 A LED rail +
  ESP at an empty cell). TI E2E reports the BATFET turning off when a heavy load sags BAT
  below the depletion threshold at ~3.0 V. Keep the BAT path fat, and have firmware cut LEDs
  first. If OCP is marginal, feed the boost from BAT through a fuse.
- Rejected: TP4056/MCP73831 (no power path), IP5306-class power-bank SoCs (shut off by
  themselves at light load), BQ24074 (1.5 A total).

### Fuel gauge: **MAX17048** (I2C 0x36)
- Real battery % with no sense resistor, plus a low-battery alert pin.

### LED boost: 5 V-only synchronous boost, ~8–10 A switch
- First pick: **TI TPS61022** (small, cheap, 5 V class). Fallback: **TPS61088** (bigger, proven at
  this power). Run both through WEBENCH at 3.0 V in → 5.1 V @ 2 A continuous / 3 A peak, and
  choose on efficiency and inductor size.
- Inductor ~1 µH, ≥ 6–8 A saturation, shielded, ~4×4 to 5×5 mm. That's smaller than the
  12 V design needed.
- **Neither part disconnects its load** when disabled: battery leaks through the high-side
  body diode. Hence the load switch below.
- Boost EN = LED_EN: when LEDs are off, the boost is off too, with no idle switching losses.

### LED load switch: P-channel MOSFET, high side
- 5 V only, so it's simpler than rev 1 (no zener). A logic N-FET pulls the gate. An RC soft
  start stops a hot-plugged strip's bulk capacitor from tripping the boost.
- Off = strip fully unpowered. That avoids the ~1 mA/LED idle drain and allows firmware
  soft-off.
- Resettable polyfuse after it. A shorted strip shouldn't kill the board.

### 3.3 V regulator: 600 mA+ LDO with EN (AP2112K-3.3 / TLV75733 class)
- Fine down to the ~3.3 V firmware cutoff. Upgrade to the TPS63802 buck-boost only if you want
  a stable 3.3 V to a fully empty cell.

### Level shifter: **SN74AHCT245** (octal, TSSOP-20)
- 8 lines = **4 × (CLK, DAT)**, or 8 single-wire WS2812-type lines. AHCT reads 3.3 V as high
  and drives full 5 V, fast enough for 20+ MHz APA102 clocks. 33 Ω series per line.
- VCC from the boost output (before the load switch). /OE pulled up = disabled until firmware
  has the rail up. Data held low when LED power is off, so strips aren't phantom-powered
  through their inputs.

### Microphone: **TDK ICS-43434** (I2S, bottom-port)
- Same mic as Adafruit's I2S breakout. 24-bit I2S, directly supported by the S3's I2S RX.
- Bottom port needs a **~0.8 mm hole through the PCB** under the mic, and the enclosure needs a
  sound path to it. Place it at the antenna end, far from the boost inductor (switching noise).
  Use a separate filtered 3.3 V feed (ferrite + cap).
- Cheaper alternative: a PDM mic. The S3 converts PDM in hardware, uses 2 pins instead of 3, and
  costs a bit less. Keep I2S unless the part is out of stock.
- Check JLC stock before committing; MEMS mic availability changes.

### Motion: **ST LSM6DS3TR-C** (6-axis accel + gyro, I2C 0x6A)
- You asked for an accelerometer. For a wand, the gyro (rotation rate) is the more useful half:
  swing speed, twist and pointing. It costs ~$1 more than a plain accelerometer and is very
  common on JLC. If cost wins, the **LIS2DH12** (accel only) drops in on the same footprint
  region.
- Built-in tap/double-tap, tilt and wake-on-motion. **INT1 wired to a deep-sleep wake pin:**
  with the switch on and the board asleep, a shake wakes it.
- Place it near the board center, away from the switch (vibration from flicking it).

### Other bits
- **USB-C:** 16-pin receptacle, 5.1 kΩ CC pulldowns, ESD array (USBLC6-2SC6), VBUS TVS. CC lines
  go to ADC pins too, so firmware knows a default/1.5 A/3 A source and budgets LED power while
  plugged in.
- **Buttons:** BOOT (GPIO0, doubles as the ChromaBay pattern button, per
  documentation/BUTTON_CONTROL_PLAN.md) and RESET, side-actuated if they fit.
- **Indicators:** charge LED on STAT (hardware, works with the switch off), one status LED on a
  GPIO. Cut-jumper to disable both for dark builds.
- **Qwiic/STEMMA QT** (JST-SH 4-pin) footprint on the I2C bus, optional.
- **Touch / spare pads:** 4 pads on capacitive-touch-capable GPIOs. A sealed wand can use
  copper tape or a metal band as buttons with no holes in the enclosure. They also work as
  plain GPIO/ADC.

---

## 5. Jumper/config summary (solder jumpers, all default to the safe choice)

| Jumper | Default | Options |
|---|---|---|
| CHG | 500 mA | 1 A, 2 A |
| NTC | Onboard NTC | Pack thermistor on 3rd pad |
| SW | Onboard slide switch | Cut trace → external switch on SW pads |
| EXT | Output pads powered by onboard 5 V | Cut → output 5V pads disconnected from boost (external LED supply, see section 6) |
| LEDS | Indicators on | Cut to disable |

---

## 6. External LED power mode (big or 12 V strips)

Cut **EXT** and the output pads' 5 V net no longer connects to the onboard boost. Power the
strip from its own supply (5 V, or 12 V for WS2815-type), connect **GND** to the board, and the
board just sends data. The level shifter still runs from the onboard boost, so data is always
clean 5 V. The battery then only has to power the ESP32. This covers the "occasionally I want a
huge installation" case without making every board pay for it.

---

## 7. The on/off switch

- **It carries logic, not battery current.** It drives SW_ON, which enables the 3.3 V LDO. With
  the ESP off, LED_EN is pulled low, so the boost and load switch are off too.
  - Any tiny switch works, including external ones on thin wire or a reed switch for sealed
    builds.
  - Off draw is charger + gauge + boost quiescent, tens of µA. Years on a 3 Ah cell.
  - **Charging works with the switch off**, and the charge LED still shows.
- Optional cut-trace pad pair in series with BAT for a true zero-current storage disconnect.

---

## 8. Battery connection

- **JST-PH 2-pin** (Adafruit/SparkFun polarity) for small packs ≤ ~1.5 A. Big **"+" / "−"** on
  silk: many vendors' packs are wired reversed. Consider a reverse-polarity indicator LED
  (cheap) so a backwards pack is obvious before anything is plugged in.
- **Large-pack pads at the board end:** two big pads sized for 16–18 AWG, each with a
  **strain-relief hole** beside it (wire goes up through the hole, folds over, solders to the
  pad, like drone ESCs). Labeled, spaced ≥ 5 mm apart so a blob can't bridge them.
- 3rd small pad for a pack thermistor (NTC jumper).
- Packs must have a protection circuit (PCM). For capacity, parallel cells off-board (1S2P,
  1S3P…); never series.

---

## 9. Mechanical / layout

- **19.05 mm × ~80–95 mm**, single-sided assembly, 4 layers (solid ground, fat pours for the
  battery → boost loop).
- Order along the length:
  1. **Battery pads + JST-PH** at the very end (strain-relief holes), then **USB-C** facing out
     the end beside them, then the charger + NTC.
  2. Fuel gauge, **slide switch** (side-facing) + external switch pads, **boost + inductor +
     load switch + polyfuse**.
  3. **LED output block:** for each of the 4 outputs, a 4-pad group **5V / CLK / DAT / GND**
     along the long edges, plus one heavy 5V/GND pair for a main feed. Silkscreen O1–O4. In
     single-wire mode, CLK pads are just extra data lines (O1a/O1b…).
  4. AHCT245, **IMU** (near center), touch/spare pads, Qwiic.
  5. **Mic** (with PCB port hole), then the **ESP32-S3-MINI-1 with the antenna at the far tip.**
- Mounting: no holes by default (tube/sled fit). Optional M2 holes in the battery end if
  length allows.

---

## 10. Firmware work this board implies (ChromaBay `esp32/`)

Today the firmware has no battery, power-limit, mic or IMU code.

1. **Power limiting:** max mA for the LED rail, including per-LED idle current. Lowered
   automatically on weak USB or low battery.
2. **Battery telemetry:** MAX17048 % + voltage, STAT/PG → shown on the app's Devices tab.
3. **Low battery:** dim at ~15%, cut LED_EN at ~3.3 V, deep sleep before empty.
4. **LED_EN / /OE sequencing:** rail off at brightness 0 or after idle; data low while off; /OE
   released only after the rail settles.
5. **Clock+data outputs:** the current APA102/SK9822 driver (`led_wrapper.h`) bit-bangs on any
   two pins, so **all 4 outputs work today**. It does block the CPU while sending. Speed-up
   path: put 2 outputs on the S3's two general-purpose hardware SPI hosts. Doing all 4 at once
   in hardware means using the LCD peripheral's 8-bit parallel mode with clock edges generated
   as data bits. That's real work, so only do it if 4 long strips at high frame rates are
   needed.
6. **Mic input:** I2S RX → level/FFT bands as inputs to the pattern engine (audio-reactive
   patterns). It needs new input nodes in the pattern language so the WASM preview can fake or
   mirror them.
7. **IMU input:** accel/gyro as pattern inputs (swing → brightness, tilt → hue…), tap
   gestures as button events alongside the BOOT button, and wake-on-motion.
8. **Board profile:** a "ChromaBay Controller" preset (pins, 4 outputs, sensors) so nobody sets
   pins by hand.

---

## 11. Pin map (draft, ESP32-S3-MINI-1)

| Function | GPIO | Notes |
|---|---|---|
| USB D− / D+ | 19 / 20 | Native USB |
| BOOT / pattern button | 0 | Strapping pin |
| CC1 / CC2 sense | 1 / 2 | ADC1 (usable with Wi-Fi on) |
| Touch/spare pads T1–T4 | 4, 5, 6, 7 | Touch + ADC1 |
| I2C SDA / SCL | 8 / 9 | Gauge, IMU, Qwiic |
| IMU INT1 (wake) / INT2 | 10 / 13 | RTC-capable, so they can wake from deep sleep |
| Charger STAT / /PG | 11 / 12 | Open-drain, pull-ups to 3.3 V |
| Gauge ALRT | 14 | |
| O1 CLK / DAT | 15 / 16 | → AHCT245 |
| O2 CLK / DAT | 17 / 18 | |
| O3 CLK / DAT | 21 / 33 | |
| O4 CLK / DAT | 34 / 35 | |
| Shifter /OE | 36 | Pull-up = disabled |
| LED_EN (boost + load switch) | 37 | Pull-down = off |
| Mic BCLK / WS / SD | 38 / 39 / 40 | |
| Status LED | 41 | |
| Spare | 42, 47, 48 | Pads if room |

Avoid strapping pins 3, 45, 46 (a pulled-up 45 at boot switches flash voltage). Check the
final assignment against the MINI-1 datasheet: the N4R2 uses extra internal pins for PSRAM, and
33–37 must be free on the variant chosen.

---

## 12. Rough cost (guess, qty 5–10, excluding PCBA setup/stencil fees)

S3-MINI-1 ~$3 · BQ25606 ~$1.5 · boost + inductor ~$1.5 · MAX17048 ~$1 · LSM6DS3TR-C ~$1.5–2 ·
ICS-43434 ~$1–1.5 · AHCT245, USB-C, ESD, LDO, FETs, passives ~$2–3 · 4-layer PCB ~$1–2 →
**roughly $13–17 per board in parts.** The mic and IMU together are ~$3. Leave them unpopulated
(DNP) on builds that don't need them.

---

## 13. Open questions / next steps

1. Max board length for the wand?
2. BQ25606 `IBATFET_OCP` check; WEBENCH TPS61022 vs TPS61088.
3. Confirm JLC stock: ICS-43434, LSM6DS3TR-C, BQ25606, chosen boost.
4. KiCad schematic in `hardware/controller-board/`, layout, PCBA order for ~5 boards.
