# ChromaBay battery LED controller: board + case design

Status: **design spec only.** There is no schematic or layout yet. This is the brief to build
the KiCad project (and the case) from.

A small ESP32-S3 board meant to work as a Swiss Army knife. It:

- charges a single-cell LiPo/Li-ion over USB-C and runs while plugged in
- has a real off switch and a user button
- makes a 5 V LED rail
- has 4 level-shifted clock+data outputs (one on a screwless terminal)
- has an I2S microphone (plus pads for an external one) and a 6-axis motion sensor

Every external interface sits on **one business end**, so it drops into a 3D-printed
clamshell case where nothing needs the case opened in normal use.

Revision history:
- **Rev 2:** dropped 12 V; 5 V / 2 A rail; 4 × clock+data; mic + IMU.
- **Rev 3:** ~1:2 board shape (~30 × 62 mm), single-sided; one business end; push-in terminal
  for output 1; dedicated user button; external-mic pads; front-facing indicator LEDs; case
  spec; itemized BOM.

---

## 1. Does this exist off the shelf?

Not as one board. The near misses:

| Board | Has | Missing |
|---|---|---|
| Adafruit QT Py ESP32-S3 + LiPo BFF | S3, LiPo charging | 5 V boost at LED currents, level shifting, mic, IMU |
| Unexpected Maker FeatherS3 / TinyS3, PowerFeather S3, Olimex S3-DevKit-LiPo | S3, charging, power path | Boost, level shifting |
| Adafruit Sparkle Motion, QuinLED Dig-Uno/Quad | Level-shifted outputs | Battery, charger |
| ESP32-S3 Super Mini + TP4056 + boost module + shifter | All the functions, cheap | It's four boards, and the TP4056 has no power path |

**Prototype path until boards arrive:** QT Py ESP32-S3 + LiPo BFF → Pololu 5 V 2 A+ step-up →
74AHCT125 breakout, plus ICS-43434 and LSM6DS3TR-C breakouts on STEMMA QT.

---

## 2. Requirements: what was kept, cut or relaxed

| Requirement | Verdict | Why |
|---|---|---|
| 12 V LED rail | **Cut** (rev 2) | Clock+data strips are 5 V parts. 12 V added parts and ruled out the cheaper 5 V-only boost chips. **External LED power mode** (section 7) covers big or 12 V strips. |
| 5 V @ 3 A continuous | **2 A continuous, ~3 A peaks** (rev 2) | 3 A meant ~5 A from the battery near empty. The 200 LEDs / 4 h / low target (≈ 1 A) still has 2× headroom. |
| Battery ~500 mAh to ~10 Ah, 1S | Kept | Charge-current jumpers and big pads. |
| Charge while running | Kept | NVDC charger. |
| 4 × clock+data outputs | Kept | One 8-channel buffer. Output 1 on a push-in terminal, 2–4 on pads. |
| 0.75" × long | **Replaced by ~1:2, ~30 × 62 mm** (rev 3) | Same parts, better shape (section 3). |
| Single-sided assembly | Kept | Cheaper PCBA. Fits at ~30 × 62. |
| One business end for all ports | Kept | It sets the layout order (section 10). |

### Sizing reference

| Scenario | Avg mA/LED (incl. ~0.5–1 mA idle) | LED power | Battery-side W | 4 h energy | 1S capacity |
|---|---|---|---|---|---|
| Very dim | 2 | 2 W | ~2.7 W | ~11 Wh | ~3 Ah (one 18650) |
| **"Low" (target, 200 LEDs)** | 5 | 5 W | ~6 W | ~24 Wh | **~6.5 Ah (two 18650s in parallel)** |
| Board max (2 A cont.) | — | 10 W | ~11.5 W | — | 6.5 Ah lasts ~2 h |

---

## 3. Where the board area goes

It isn't a lot of chips. It's **connectors, user-facing parts, and two switching power stages**,
each of which needs an inductor and big capacitors. Footprint estimates, including courtyard:

| Block | ≈ mm² | Share |
|---|---|---|
| ESP32-S3-MINI-1 (antenna overhangs the edge, so no extra keep-out) | 320 | 19% |
| Wire connections: push-in terminal (O1), pad rows O2–O4, battery pads + strain-relief holes, ext-mic pads | 330 | 20% |
| Charger power stage (BQ25606 is a *switching* charger: IC + inductor + caps + NTC) | 100 | 6% |
| Boost power stage (IC + inductor + caps) + load switch + polyfuse | 150 | 9% |
| Business-end parts: USB-C, slide switch, button, mic, 2 LEDs | 150 | 9% |
| Level shifter + series resistors | 80 | 5% |
| IMU, fuel gauge, LDO, ESD, JST-PH, Qwiic, reset/boot, ~60 passives | 240 | 14% |
| Routing, clearances, 2 mounting holes | ~300 | 18% |
| **Total** | **~1,700–1,900 mm²** | **≈ 30 × 62 mm** |

In rev 2, the 19 mm width forced everything into one long file, so routing got worse and the
board got to ~90 mm. At 1:2 it packs properly.

Easy ways to shrink further, if wanted:

- Drop Qwiic (−30 mm²).
- Use a smaller generic push-in terminal instead of a WAGO (−50 mm²).
- Pads only for O2–O4 at 2.0 mm pitch (−40 mm²).

That gets to about **28 × 56 mm**.

---

## 4. Block diagram

```
USB-C ─ ESD, 5.1k CC ─VBUS─► BQ25606 charger (NVDC) ─VSYS 3.0–4.4 V─┬─► 3.3 V LDO (EN=SW_ON) ─► ESP32-S3-MINI-1
  │ D+/D- ─► S3 native USB          ▲ BAT                           │                         ├─ I2C: MAX17048, LSM6DS3TR-C, Qwiic
  │ CC1/CC2 ─► ADC                  │                               │                         ├─ I2S bus: ICS-43434 (L) + ext-mic pads (R)
                 1S battery (JST-PH + big pads, NTC)                │                         ├─ user button, status LED, touch pads
SLIDE SWITCH (+ ext pads) ─► SW_ON                                  │                         └─ 8 GPIO ─► SN74AHCT245 ─33Ω─► O1..O4 (CLK, DAT)
                                                                    └─► 5 V boost (EN=LED_EN) ─┬─► P-FET load switch ─► polyfuse ─► [EXT jumper] ─► O1..O4 5V/GND
                                                                                               └─► AHCT245 VCC
```

---

## 5. Part choices

### ESP32-S3 module: **ESP32-S3-MINI-1-N8** (or -N4R2 for PSRAM)
- Pads underneath, so the boards get assembled (JLCPCB PCBA). Native USB straight to USB-C.
- **Antenna overhangs the far end** (opposite the business end), away from the wires, the
  battery and the boost.

### Charger + power path: **TI BQ25606** (standalone, switching)
- NVDC: runs from USB when plugged in, charges with what's left, and adds battery current when
  the LEDs need more.
- **Charge current by solder jumper, default 500 mA**; bridge for 1 A or 2 A. Firmware can't
  override it.
- ILIM 3 A; VINDPM protects weak USB ports. Onboard NTC by default, or the pack's own
  thermistor on a 3rd pad.
- ⚠️ **Verify** `IBATFET_OCP` comfortably exceeds ~3.5 A. TI E2E reports BATFET turn-off when
  BAT sags at ~3.0 V under heavy load. Keep the BAT path fat and have firmware cut LEDs first.

### Fuel gauge: **MAX17048** (I2C 0x36)
- Real battery % and a low-battery alert pin. Optional cost cut: replace it with a $0.02 ADC
  divider and a voltage→% curve. That saves ~$1 + one PCBA extended-part fee, but % is less
  accurate under LED load.

### LED boost: **TI TPS61022** (fallback TPS61088), 5.1 V
- Pick via WEBENCH at 3.0 V in → 5.1 V @ 2 A continuous / 3 A peak. ~1 µH shielded inductor,
  ≥ 6–8 A saturation.
- No load disconnect in either part, hence the load switch. Boost EN = LED_EN.

### LED load switch: P-FET high side + RC soft start, then a polyfuse
- When it's off, the strip is fully unpowered (no ~1 mA/LED idle drain). The polyfuse means a
  shorted strip can't kill the board.

### 3.3 V: 600 mA+ LDO with EN (AP2112K-3.3 / TLV75733 class)

### Level shifter: **SN74AHCT245** (TSSOP-20)
- 8 lines = 4 × (CLK, DAT), or 8 single-wire lines. 33 Ω series each. VCC from boost output.
  /OE pulled up until firmware enables it; data held low while LED power is off.

### Microphone: **TDK ICS-43434** (I2S, bottom-port) + external-mic pads
- **At the business end**, about 2–3 mm from the edge. Its bottom port opens through a ~0.8 mm
  PCB hole into a short acoustic channel molded into the case bottom, which exits at the end
  face (section 9).
- Keep it on the opposite side of the end from the charger inductor, with its own ferrite + cap
  on 3.3 V.
- **External mic:** a 5-pad row (3V3, GND, BCLK, WS, SD) shares the onboard mic's I2S bus. The
  ICS-43434's SELECT pin is tied to the left channel, so an external I2S mic set to the right
  channel (any INMP441/ICS-43434 breakout has an L/R pin) works **alongside** it: stereo, or
  pick one in firmware. A cut-jumper turns the onboard mic off if you only want the external
  one. Use the external mic when the board is buried somewhere acoustically dead.

### Motion: **ST LSM6DS3TR-C** (accel + gyro, I2C 0x6A)
- Tap/double-tap, tilt and wake-on-motion. INT1 is on an RTC GPIO, so a shake wakes the board
  from deep sleep. Cheaper option: LIS2DH12 (accel only, about −$0.80).

### User-facing parts (all on the business end)
- **Slide switch** (side-actuated, right-angle) for power. It's a logic-level switch, so it's
  tiny and cheap; see section 8.
- **User button**: side-actuated tact switch on a dedicated GPIO. Click = next pattern, double
  click = brightness, per documentation/BUTTON_CONTROL_PLAN.md. It's deliberately **not**
  GPIO0: holding a GPIO0 button while switching on drops the S3 into download mode, which would
  confuse people. A small BOOT + RESET pair sits inside the case for recovery only (normal USB
  flashing doesn't need them).
- **Charge LED + status LED**, side-emitting or right-angle, at the end edge so they show
  through light-pipe holes in the case. Cut-jumper disables both.
- **USB-C** 16-pin, mid-mount if the case height allows (lower profile), with ESD array + VBUS
  TVS. CC lines also go to ADC pins to detect source capability.

### Wire connections
- **O1: 4-position push-in (screwless) terminal, G / V / C / D**, vertical (top) entry. The
  wire comes in through the case seam, over the business-end parts, and drops straight into
  the terminal, so it doesn't compete with USB-C for edge space. Candidates:
  - **WAGO 2060 series** (SMD, reflowable, 0.2–0.75 mm² / 24–18 AWG, push-button release).
    Pick the vertical-entry variant; check the current rating.
  - A generic SMD push-in block. About a quarter of the price; check JLC stock.
  - Rated well over 2 A either way.
- **O2–O4:** each a 4-pad row (G/V/C/D) at 2.54 mm pitch. Solder wires, or fit a pin header or
  JST-XH.
- **Battery:** two big pads for 16–18 AWG with strain-relief holes (wire up through the hole,
  fold, solder), plus an NTC pad, for big external packs. Also **JST-PH** (Adafruit/SparkFun
  polarity, big +/− silk, optional reverse-polarity indicator LED) for a small pouch cell
  inside the case.
- **Qwiic/STEMMA QT**, external switch pads, 4 touch/spare pads.

---

## 6. Jumper/config summary (all default to the safe choice)

| Jumper | Default | Options |
|---|---|---|
| CHG | 500 mA | 1 A, 2 A |
| NTC | Onboard NTC | Pack thermistor on 3rd pad |
| SW | Onboard slide switch | Cut → external switch on SW pads |
| EXT | Outputs powered by onboard 5 V | Cut → external LED supply |
| MIC | Onboard mic on | Cut → external mic only |
| LEDS | Indicators on | Cut to disable |

---

## 7. External LED power mode

Cut **EXT** and the output 5 V pads no longer connect to the onboard boost. Power the strip from
its own supply (5 V, or 12 V for WS2815-type), share GND, and the board just sends clean 5 V
data. The battery then only runs the ESP32.

---

## 8. Power switch behavior

- Logic-level: SW_ON enables the 3.3 V LDO. With the ESP off, LED_EN is pulled low, so the
  boost and load switch are off too.
- Off draw is tens of µA, which is years on a 3 Ah cell. **Charging works with it off**, and
  the charge LED still shows.
- External switch or reed switch on the SW pads. Optional cut-trace pads in series with BAT for
  a true zero-current storage disconnect.

---

## 9. Case (3D printed clamshell)

**Concept:** two halves split horizontally at the PCB top surface. The PCB sits on a ledge in
the bottom half, and the top half clamps it.

- **Outer size (estimate):** ~34 × 66 × 12 mm without an internal battery. With an under-board
  pouch bay (e.g. 1000–1500 mAh, ≤ 50 × 30 × 6 mm), it's ~34 × 66 × 19 mm.
- The battery bay stops short of the antenna end so the cell doesn't detune it.

### Business end face (left → right, all usable with the case closed)

| Feature | How |
|---|---|
| User button | Printed flexure tab or captive plunger in the wall, over the side-actuated tact switch |
| Mic port | ~1 mm hole → molded channel in the bottom half → under the PCB mic hole. Mesh/fabric patch inside optional (wind/dust). |
| Charge + status LEDs | Small holes or light pipes (clear filament, or a 1.75 mm clear PLA stub) |
| USB-C | Cutout sized for a cable overmold (~12.5 × 7 mm), not just the receptacle |
| Power slide switch | Recessed slot so it doesn't get bumped on accidentally |
| Wire exits | Half-round notches in **both** halves that form holes when closed, so wires are laid in rather than threaded. 2–3 notch sizes: battery 16–18 AWG pair, strip 4-wire, thin (ext mic / sensors). Unused notches are break-out tabs. |

### Inside
- Zip-tie anchors / a comb just inside the wire notches: strain relief so a yank pulls on the
  case, not on the terminal or solder pads.
- Open the case: the push-in terminal levers, battery JST-PH, pads, BOOT/RESET and jumpers are
  all reachable.
- Closure: 2 × M2 self-tapping screws into printed bosses (survives repeated opening better
  than snap-fits). The PCB has 2 matching holes near the far end.
- External mounting: zip-tie slots / strap loops on the bottom half; optional belt-clip or
  magnet pocket variant.

### Build method
- **Parametric OpenSCAD (or build123d)** in `hardware/controller-board/case/`, driven by the
  KiCad board outline and connector coordinates (exported STEP + a small JSON of feature
  positions). If the PCB moves, the cutouts follow.
- Parameters: battery bay (none / pouch L×W×H / external), notch set, mounting variant, wall
  thickness.
- Prints without supports: both halves print open-side-up, and the mic channel is a groove
  closed off by the PCB.
- Later fab methods (SLS/MJF nylon, injection mold) use the same geometry with draft added.
- Wands and other embedded builds skip the case and mount the bare board. All interfaces on
  one end makes that easy too: the end faces the wand's handle cap.

---

## 10. Layout (single-sided, ~30 × 62 mm, 4 layers)

From the business end back:

1. **Edge row (~8 mm):** button · mic (+ PCB port hole) · charge/status LEDs · **USB-C** (center)
   · slide switch.
2. **Wiring zone (~14 mm):** O1 push-in terminal (vertical entry), O2–O4 pad rows, battery pads
   with strain-relief holes, ext-mic pads, external switch pads. Everything that takes a wire is
   right behind the end face, so wires reach the seam notches in a few mm.
3. **Power zone (~14 mm):** charger + inductor (on the side away from the mic), boost + inductor,
   load switch, polyfuse, JST-PH (facing inward toward the battery bay). This keeps the
   high-current loop short: battery pads → charger → boost → output pads.
4. **Logic zone (~10 mm):** AHCT245, MAX17048, LSM6DS3TR-C (near the middle), LDO, Qwiic,
   touch pads, BOOT/RESET, jumpers.
5. **ESP32-S3-MINI-1 (~20 mm)** with the **antenna overhanging the far edge**; 2 × M2 holes
   beside it.

---

## 11. BOM estimate (qty ~10, LCSC-ish unit prices, rough)

| Part | Est. $ |
|---|---|
| ESP32-S3-MINI-1-N8 | 3.00 |
| BQ25606 + inductor | 1.40 |
| TPS61022 + inductor (TPS61088 ≈ +$0.70) | 1.05 |
| MAX17048 | 1.00 |
| LSM6DS3TR-C | 1.20 |
| ICS-43434 | 1.20 |
| Push-in terminal 4P (WAGO; generic ≈ $0.40) | 1.50 |
| SN74AHCT245, LDO, 3 FETs, polyfuse | 0.50 |
| USB-C, ESD, TVS | 0.30 |
| Slide switch, 3 tact switches, JST-PH, JST-SH | 0.45 |
| ~60 passives, NTC, LEDs | 0.60 |
| 4-layer PCB, ~30 × 62 mm | 0.80 |
| **Parts total** | **≈ $13** |
| Case (PLA) | ≈ $0.30 |

**What actually inflates the cost: assembly fees, not parts.** JLC charges a per-order setup
fee, a stencil, and about **$3 per unique "extended" part per order**. This board has roughly
10 of those (module, charger, boost, gauge, IMU, mic, shifter, USB-C, terminal, switches), so
call it **~$40 fixed per order**:

| Order size | All-in per board (est.) |
|---|---|
| 5 | ~$21 |
| 10 | ~$17 |
| 30 | ~$14–15 |

Under $20 from about 10 boards up. (JLC's fee structure changes; re-check when ordering.)

If cost needs to drop:

- Generic terminal (−$1.10).
- ADC divider instead of the fuel gauge (−$1 and one fee).
- LIS2DH12 instead of the LSM6DS3TR-C (−$0.80).
- Swap parts for JLC "basic" equivalents where possible (no fee).

---

## 12. Firmware work this board implies (ChromaBay `esp32/`)

Today the firmware has no battery, power-limit, mic or IMU code.

1. **Power limiting** (incl. per-LED idle current), lowered on weak USB / low battery.
2. **Battery telemetry:** MAX17048 % + voltage, STAT/PG, shown on the app's Devices tab.
3. **Low battery:** dim at ~15%, cut LED_EN at ~3.3 V, deep sleep before empty.
4. **LED_EN / /OE sequencing.**
5. **Clock+data outputs:** the current APA102/SK9822 driver (`led_wrapper.h`) bit-bangs on any
   pins, so all 4 outputs work today, but it blocks the CPU while sending. Upgrade: 2 outputs on
   the S3's hardware SPI hosts; all 4 in hardware needs an LCD-peripheral parallel driver.
6. **Mic:** I2S RX (L, R or stereo) → level/FFT bands as pattern-engine inputs (needs new input
   nodes, faked in the WASM preview).
7. **IMU:** accel/gyro as pattern inputs, taps as button events, wake-on-motion.
8. **User button:** implement BUTTON_CONTROL_PLAN.md on the dedicated button GPIO.
9. **Board profile:** "ChromaBay Controller" preset (pins, outputs, sensors).

---

## 13. Pin map (draft, ESP32-S3-MINI-1)

| Function | GPIO | Notes |
|---|---|---|
| USB D− / D+ | 19 / 20 | Native USB |
| BOOT (internal, recovery) | 0 | Strapping |
| CC1 / CC2 sense | 1 / 2 | ADC1 |
| Touch/spare T1–T4 | 4, 5, 6, 7 | Touch + ADC1 |
| I2C SDA / SCL | 8 / 9 | Gauge, IMU, Qwiic |
| IMU INT1 (wake) / INT2 | 10 / 13 | RTC-capable |
| Charger STAT / /PG | 11 / 12 | Open-drain |
| Gauge ALRT | 14 | |
| O1 CLK / DAT | 15 / 16 | → AHCT245 |
| O2 CLK / DAT | 17 / 18 | |
| O3 CLK / DAT | 21 / 33 | |
| O4 CLK / DAT | 34 / 35 | |
| Shifter /OE | 36 | Pull-up = off |
| LED_EN | 37 | Pull-down = off |
| I2S BCLK / WS / SD (onboard + ext mic) | 38 / 39 / 40 | |
| Status LED | 41 | |
| User button | 42 | Pull-up, active low |
| Spare | 47, 48 | |

Avoid strapping pins 3, 45, 46. Verify against the MINI-1 variant chosen (33–37 must be free).

---

## 14. Open questions / next steps

1. BQ25606 `IBATFET_OCP`; WEBENCH TPS61022 vs TPS61088.
2. JLC stock + basic/extended status: ICS-43434, LSM6DS3TR-C, BQ25606, boost, push-in terminal.
3. Internal battery bay: which pouch size should the default case target?
4. KiCad schematic → layout → export outline/feature JSON → parametric case → PCBA order (~10).
