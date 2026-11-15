# ChromaBay battery LED controller: board + case design

Status: **design spec only.** There is no schematic or layout yet. This is the brief to build
the KiCad project (and the case) from.

In product terms, this is a battery-powered, ChromaBay-first take on the GLEDOPTO ESP32 mini
controllers (e.g. GL-C-310WL). It:

- charges a single-cell LiPo over USB-C and runs while plugged in
- has a real off switch and a user button
- makes a 5 V LED rail
- has 4 level-shifted clock+data outputs
- has an I2S microphone (plus external-mic pads) and a 6-axis motion sensor

Every external interface sits on **one business end**. The board is **~3.5 mm thick** in its
slim build, with a flat pouch cell against the underside and a family of 3D-printed cases.

Revision history:
- **Rev 2:** dropped 12 V; 5 V / 2 A rail; 4 × clock+data; mic + IMU.
- **Rev 3:** ~1:2 shape, single-sided, one business end, case spec, BOM.
- **Rev 4:**
  - Qwiic cut; wiring area shrunk ~55%.
  - Lever terminal made optional, with its footprint doubling as solder pads.
  - Low-profile part picks for a ~3.5 mm slim build.
  - Battery against the underside, with safety rules; case variants.
  - Battery reverse-polarity protection and output ESD.
  - Lessons from GLEDOPTO.

---

## 1. Reference products and lessons

### GLEDOPTO GL-C-310WL (the closest commercial analog)
Published specs (manual / retailer listings):

- 5–24 V DC in; 6 A per channel, 10 A total
- push-in terminals for 0.5–1.5 mm² (24–16 AWG) wire, 8–9 mm strip length
- onboard I2S mic; button; two "extended" GPIO pads for user customization
- PC housing, IP20, **42 × 38 × 17 mm**, ~18 g; ships with WLED

Lessons we take:

1. **The mic and spare GPIO pads sell it.** People pick these boards for audio-reactive builds
   and hack the extra pins. Keep both, and label them.
2. **Label wires on the case, not just the PCB silkscreen.** Once the board is in a case, the
   silkscreen is invisible. Our case prints or embosses G / V / C / D next to each exit, plus
   the strip length for the terminal.
3. **Lever terminals are what make these boards fast to use.** But they're **tall** (roughly
   10–15 mm), which is most of why the GLEDOPTO case is 17 mm thick. We keep them optional
   (section 5).
4. **WLED compatibility widens the audience.** Publish a WLED pin config / usermod for this
   board too, so it isn't ChromaBay-only. ChromaBay already converts WLED devices, so it can go
   either way.
5. **Common failure modes in this category to design out:**
   - wiring the supply in backwards (we add **battery reverse-polarity protection**)
   - static and hot-plug damage on data lines (we add **ESD diodes** on all 8 outputs, plus
     33 Ω series resistors)
   - 3.3 V data that's marginal on long runs (we use a real 5 V AHCT buffer, not a MOSFET
     shifter)
   - shorted strips (we add a polyfuse)

### Other near misses
- QT Py S3 + LiPo BFF, FeatherS3, PowerFeather, Olimex S3-LiPo: charging, but no LED rail or
  shifting.
- Sparkle Motion, QuinLED: shifting, but no battery.

---

## 2. Requirements: kept, cut, relaxed

| Requirement | Verdict | Why / cost |
|---|---|---|
| 12 V rail | Cut (rev 2) | 5 V clock+data strips. External LED power mode covers 12 V. |
| 5 V @ 3 A cont. | 2 A cont. / ~3 A peak (rev 2) | Battery current, heat, BATFET. Target (≈1 A) has 2× headroom. |
| Qwiic | **Cut** (rev 4) | I2C still reachable on the spare pads (SDA/SCL/3V3/GND). |
| Lever terminal | **Optional** (rev 4) | Its footprint doubles as solder holes, so it costs zero extra area. It sets the thickness when fitted (section 3). |
| ~3 mm thick (6 mm max) | **~3.5 mm slim build is realistic; ~3 mm is not.** | Floor = ESP32-S3-MINI-1 (2.55 mm) + PCB. See section 3. |
| Flat battery under the board | Kept | Needs a separator layer and an uncovered business-end strip (section 9). |
| Battery-footprint cell vs "200 LEDs for 4 h" | **Can't do both.** | A cell the size of the board (~30 × 50 mm) is ~1–2 Ah. 200 LEDs at low brightness for 4 h needs ~6.5 Ah, so **that's the external-battery variant.** A board-sized cell gives ~1–2 h at 200 LEDs, or ~4 h at ~60 LEDs. |
| Single-sided, one business end | Kept | |

---

## 3. Area and thickness budget

### Area (rev 4)

| Block | ≈ mm² | Share |
|---|---|---|
| ESP32-S3-MINI-1 (antenna overhangs far edge) | 320 | 21% |
| Business-end parts: mid-mount USB-C, slide switch, button, mic, 2 LEDs | 150 | 10% |
| Charger power stage | 100 | 7% |
| Boost stage + load switch + polyfuse + reverse-polarity FET | 160 | 11% |
| **Wire connections** (shared outputs block, battery pads, tiny ext-mic/spare pads) | **150** | **10%** (was 330) |
| Level shifter + series R + output ESD | 90 | 6% |
| IMU, gauge, LDO, ESD, BOOT/RESET, passives | 210 | 14% |
| Routing, clearances, 2 holes | ~320 | 21% |
| **Total** | **~1,500 mm²** | **≈ 28 × 56 mm** |

How wiring shrank:

- Qwiic cut.
- Outputs share their power pads. One **G, V** pair plus **C1 D1 C2 D2 C3 D3 C4 D4**: 10
  holes in one row instead of 16 pads.
- O1's four positions (G V C1 D1) sit at the lever-terminal pitch, so populating the terminal
  is optional.
- Ext-mic and spare pads moved to small 1.27 mm pads.
- The battery keeps its big pads, since it carries the most current.

### Thickness (slim build, no terminal, no battery)

| Item | Height above PCB |
|---|---|
| ESP32-S3-MINI-1 | **2.55 mm (the floor)** |
| USB-C **mid-mount** (sits in a PCB cutout) | ~1.6–2.0 mm |
| Boost + charger inductors, **4 × 4 × 2 mm** class | ~2.1 mm |
| Side-actuated slide switch (MSK-12C02 class) and tact switch | ~1.5–2 mm |
| Mic, IMU, ICs, passives | ≤ 1.2 mm |
| **PCB: 0.8 mm 4-layer** | — |
| **Total** | **≈ 3.4–3.6 mm** |

Things that would push it past ~3.5 mm:

| Part | Added height | Notes |
|---|---|---|
| JST-PH battery connector | ~4–5 mm | Replaced by solder pads in slim builds. A JST-PH footprint stays for thick builds. |
| Top-mount USB-C | ~3.2 mm | Use mid-mount. |
| 5 × 5 × 3 mm inductors | ~3 mm | Cheaper and more current. That's the trade. |
| Lever terminal | ~10–15 mm | Optional build only. |

Low-profile inductors are the one place thinness costs money. Brand-name 4 × 4 × 2 mm parts at
the needed ≥ 6 A saturation (Coilcraft XEL4020 class) are ~$0.80 each, versus ~$0.25 for
generic 5 × 5 × 3 mm. Generic 4 × 4 × 2 mm parts exist at lower current. Verify at the
WEBENCH step.

**So: ~3.5 mm slim, ~6 mm with JST-PH, ~12–15 mm with the lever terminal.**

---

## 4. Block diagram

```
USB-C ─ ESD, 5.1k CC ─VBUS─► BQ25606 charger (NVDC) ─VSYS 3.0–4.4 V─┬─► 3.3 V LDO (EN=SW_ON) ─► ESP32-S3-MINI-1
  │ D+/D- ─► S3 native USB          ▲ BAT                           │                         ├─ I2C: MAX17048, LSM6DS3TR-C, spare pads
  │ CC1/CC2 ─► ADC        [reverse-polarity P-FET]                   │                         ├─ I2S: ICS-43434 (L) + ext-mic pads (R)
                 1S battery (big pads / JST-PH, NTC)                │                         ├─ button, status LED, touch/spare pads
SLIDE SWITCH (+ ext pads) ─► SW_ON                                  │                         └─ 8 GPIO ─► SN74AHCT245 ─33Ω+ESD─► C1 D1 … C4 D4
                                                                    └─► 5 V boost (EN=LED_EN) ─┬─► P-FET load switch ─► polyfuse ─► [EXT] ─► V / G
                                                                                               └─► AHCT245 VCC
```

---

## 5. Part choices

| Function | Part | Notes |
|---|---|---|
| MCU | **ESP32-S3-MINI-1-N8** (or -N4R2) | 2.55 mm tall. Native USB. Antenna overhangs the far edge. |
| Charger + power path | **TI BQ25606** | NVDC (runs + charges at once). Charge current set by jumper, **default 500 mA**, 1 A / 2 A options. ILIM 3 A, VINDPM. ⚠️ Verify `IBATFET_OCP` comfortably exceeds ~3.5 A. |
| Battery reverse protection | Low-Rds P-FET (≤ 10 mΩ, 2 × 2 mm DFN), gate to GND | Works for both charge and discharge once on. Blocks a backwards pack. |
| Fuel gauge | **MAX17048** | Optional cost cut: ADC divider. |
| LED boost | **TPS61022** (fallback TPS61088), 5.1 V | 4 × 4 × 2 mm inductor for slim builds. No load disconnect, hence the load switch. |
| Load switch | P-FET high side + RC soft start, polyfuse after | |
| 3.3 V | 600 mA+ LDO with EN | |
| Level shifter | **SN74AHCT245** | TSSOP-20, or a 2.5 × 4.5 mm QFN to save area. 33 Ω + a low-cap ESD array on the outputs. |
| Mic | **ICS-43434** (bottom port) + external-mic pads on the same I2S bus | Onboard = left channel; set the external mic to right; or cut-jumper the onboard one. Port hole sits in the uncovered business-end strip (section 9). |
| Motion | **LSM6DS3TR-C** | Wake-on-motion on an RTC GPIO. |
| USB-C | 16-pin **mid-mount** | PCB cutout at the edge, for low profile. |
| Power switch | Side-actuated slide switch, ~1.5 mm tall | Logic-level only. |
| User button | Side-actuated tact switch on a dedicated GPIO (not GPIO0) | BOOT + RESET as tiny internal buttons, for recovery only. |
| LEDs | Charge (hardware, on STAT) + status, side-emitting at the end edge | |

### Wire connections (rev 4)
- **Output row: G V C1 D1 C2 D2 C3 D3 C4 D4**, plated through-holes in one row right behind
  the business end:
  - **Solder wires straight in** (slim builds). Holes give better strain relief than surface
    pads.
  - **Or fit a 4-position lever terminal over G V C1 D1** (and a second one over C2–D3 if you
    want). The terminal's pitch sets the hole pitch for those positions. Candidates:
    - WAGO 2601 series (3.5 mm pitch, lever, up to ~1.5 mm²)
    - generic lever PCB terminals at 3.5 mm. That's the GLEDOPTO style: flip the lever, insert
      the wire, close.
  - THT terminal = hand-solder, or JLC THT assembly. It's never under the battery (section 9).
- **Battery:** two big pads + strain-relief holes, NTC pad. JST-PH footprint for thick builds
  only.
- **Small pads (1.27 mm):** ext mic (3V3 GND BCLK WS SD), I2C (SDA SCL), 4 touch/spare, external
  switch.

---

## 6. Jumpers (default = safe)

| Jumper | Default | Options |
|---|---|---|
| CHG | 500 mA | 1 A, 2 A |
| NTC | Onboard NTC (under the battery side, so it senses the cell) | Pack thermistor pad |
| SW | Onboard slide switch | External switch |
| EXT | Outputs on onboard 5 V | External LED supply |
| MIC | Onboard mic on | External only |
| LEDS | On | Off |

## 7. External LED power mode
Cut EXT: the V pad is disconnected from the boost. Power the strip from its own 5 V or 12 V
supply, share G, and the board sends clean 5 V data.

## 8. Power switch
Logic-level: SW_ON enables the LDO. With the ESP off, LED_EN is pulled low, so the boost and
load switch are off. Off draw is tens of µA. **It still charges when switched off.**

---

## 9. Battery-under-board and case variants

### The battery sits flat against the underside
- **Board ~28 × 56 mm; battery footprint ~30 × 50 mm.** The cell stops ~6 mm short of the
  business end. That uncovered strip is where the mic port hole, the mid-mount USB-C cutout and
  any THT terminal leads go.
- Standard pouch sizes that fit (name = thickness·width·length; capacities typical, vary by
  vendor):

  | Cell | Size | Capacity | Energy |
  |---|---|---|---|
  | 603050 | 6 × 30 × 50 mm | ~1000 mAh | 3.7 Wh |
  | 803050 | 8 × 30 × 50 mm | ~1300 mAh | |
  | 103050 | 10 × 30 × 50 mm | ~1800–2000 mAh | ~7 Wh |
  | 2 × 603050 | in parallel, ~12 mm | ~2000 mAh | |

- **Safety rules (non-negotiable for a pouch against a PCB):**
  - **Separator** between board and cell: a 0.5 mm printed plate in the case, or polyimide tape +
    0.2 mm FR4/PET shim for caseless builds. The cell must never touch via edges, solder joints
    or component leads.
  - **No THT parts or sharp leads over the cell.** Trim the leads in the uncovered strip.
  - The charger and boost dissipate ~1 W at full load. The NTC sits on the cell side of the
    board so charging backs off if the stack gets warm.
  - The cell must have a protection circuit (PCM). It gets the case's "swell room": 0.5–1 mm of
    clearance above the cell's rated thickness.

### Case family (parametric, 3D printed clamshell)
One parametric model (OpenSCAD or build123d, `hardware/controller-board/case/`), driven by the
KiCad outline and a feature-position JSON. Variants are parameter sets:

| Variant | Contents | Approx. outer size |
|---|---|---|
| **External battery** | Board only; battery and strip wires both exit the seam | ~32 × 60 × 8 mm |
| **Slim cell** | Board + 603050 (~1000 mAh) | ~32 × 60 × 14 mm |
| **Thick cell** | Board + 103050 or 2 × 603050 (~2000 mAh) | ~32 × 60 × 18 mm |
| **Terminal** (modifier, any of the above) | Adds a raised head at the business end for the lever terminal, with lever access through the lid | +~10 mm at the head only |

All variants share:
- **Business end face**, all usable with the case closed:
  - user button (printed flexure)
  - mic port (channel under the uncovered strip)
  - charge/status LED light holes
  - USB-C (sized for a cable overmold)
  - recessed power slide switch
  - **wire notches at the seam**: half-round notches in both halves, so wires are laid in
    rather than threaded. Battery pair, strip 4-wire and a thin one; break-out tabs for unused
    ones.
- **Wire labels** embossed beside each notch (G V C D, + −). The silkscreen is hidden once the
  board is in the case.
- **Inside:** zip-tie strain-relief comb behind the notches; 0.5 mm battery separator plate;
  2 × M2 self-tapping screws.
- **Outside:** zip-tie slots / strap loops; optional magnet or belt-clip pocket.
- Prints support-free.

---

## 10. Layout (single-sided, ~28 × 56 mm, 0.8 mm 4-layer)

From the business end:

1. **Edge row:** button · mic + port hole · LEDs · **mid-mount USB-C** · slide switch
   (uncovered strip).
2. **Wiring row:** output through-hole row (G V C1 D1 … C4 D4), battery pads + strain-relief
   holes, small pads (uncovered strip / just past it).
3. **Power zone:** reverse-polarity FET, charger + inductor (away from the mic), boost +
   inductor, load switch, polyfuse, NTC.
4. **Logic zone:** AHCT245 + ESD, gauge, IMU, LDO, BOOT/RESET, jumpers.
5. **ESP32-S3-MINI-1** with the antenna overhanging the far edge (the battery stops short of it
   too); 2 × M2 holes.

---

## 11. BOM estimate (qty ~10, rough)

| Part | Est. $ |
|---|---|
| ESP32-S3-MINI-1-N8 | 3.00 |
| BQ25606 | 1.20 |
| TPS61022 | 0.80 |
| 2 inductors, 4 × 4 × 2 mm ≥ 6 A (generic 5 × 5 × 3 mm ≈ $0.50 for both) | 1.60 |
| MAX17048 | 1.00 |
| LSM6DS3TR-C | 1.20 |
| ICS-43434 | 1.20 |
| SN74AHCT245, LDO, 4 FETs, polyfuse, output ESD array | 0.70 |
| Mid-mount USB-C, USB ESD, TVS | 0.35 |
| Slide switch, 3 tact switches | 0.35 |
| ~60 passives, NTC, LEDs | 0.60 |
| 0.8 mm 4-layer PCB, ~28 × 56 mm | 0.80 |
| **Parts total** | **≈ $12.80** |
| Optional lever terminal (WAGO; generic ≈ $0.40) | +1.50 |
| Optional JST-PH | +0.10 |

JLC assembly: ~$40 fixed per order (setup + ~$3 per unique extended part, ~10 of them), so
**~$17/board at 10, ~$14 at 30.** Under $20 from ~10 boards up.

---

## 12. Firmware work this board implies (ChromaBay `esp32/`)

1. Power limiting (incl. idle current), lowered on weak USB / low battery.
2. Battery telemetry (gauge %, STAT/PG) in the app.
3. Low-battery dim → LED cutoff → deep sleep.
4. LED_EN / /OE sequencing.
5. Clock+data: the current bit-bang driver (`led_wrapper.h`) runs all 4 outputs today. Later:
   2 on hardware SPI, or an LCD-parallel driver for all 4.
6. Mic (I2S L/R/stereo) and IMU as pattern-engine inputs; taps as button events;
   wake-on-motion.
7. User button per BUTTON_CONTROL_PLAN.md.
8. Board profile preset; **plus a published WLED config** for this board.

## 13. Pin map (draft, ESP32-S3-MINI-1)

| Function | GPIO |
|---|---|
| USB D− / D+ | 19 / 20 |
| BOOT (internal) | 0 |
| CC1 / CC2 sense | 1 / 2 |
| Touch/spare T1–T4 | 4, 5, 6, 7 |
| I2C SDA / SCL (gauge, IMU, pads) | 8 / 9 |
| IMU INT1 (wake) / INT2 | 10 / 13 |
| Charger STAT / /PG | 11 / 12 |
| Gauge ALRT | 14 |
| C1/D1, C2/D2, C3/D3, C4/D4 | 15/16, 17/18, 21/33, 34/35 |
| Shifter /OE · LED_EN | 36 · 37 |
| I2S BCLK / WS / SD | 38 / 39 / 40 |
| Status LED · User button | 41 · 42 |
| Spare | 47, 48 |

Avoid strapping pins 3, 45, 46. Verify against the chosen MINI-1 variant.

---

## 14. Open questions / next steps

1. **Infinity Scarab fit:** need its internal cavity dimensions (L × W × H) and where the
   USB/switch can poke out. If it's ≥ 28 × 56 × 3.6 mm (slim, no battery), it fits as-is. A
   smaller cavity means cutting optional parts in the order of least value.
2. BQ25606 `IBATFET_OCP`; WEBENCH TPS61022 vs TPS61088 with 4 × 4 × 2 mm inductors.
3. JLC stock / basic-vs-extended: ICS-43434, LSM6DS3TR-C, BQ25606, boost, mid-mount USB-C,
   low-profile inductors.
4. KiCad schematic → layout → outline/feature JSON → parametric case → PCBA order (~10).
