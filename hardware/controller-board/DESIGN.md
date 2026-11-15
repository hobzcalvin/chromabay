# ChromaBay battery LED controller: board design

Status: **design spec only.** There is no schematic or layout yet. This is the brief to build
the KiCad project from.

A small, long and narrow ESP32-S3 board. It charges a single-cell LiPo/Li-ion over USB-C,
runs while plugged in, has a real off switch, makes a 5 V or 12 V LED rail, and has up to
8 level-shifted data outputs. Think "QT Py S3 + LiPo BFF + boost + level shifter", in a shape
that fits in a wand.

---

## 1. Does this exist off the shelf?

Not as one board. The near misses:

| Board | Has | Missing |
|---|---|---|
| Adafruit QT Py ESP32-S3 + LiPo BFF | S3, LiPo charging | 5 V/12 V boost at LED currents, level shifting |
| Unexpected Maker FeatherS3 / TinyS3, PowerFeather S3, Olimex S3-DevKit-LiPo | S3, charging, power path | Boost, level shifting |
| Adafruit Sparkle Motion, QuinLED Dig-Uno/Quad | Level-shifted outputs, 5–24 V input | Battery, charger |
| ESP32-S3 Super Mini + TP4056 + boost module + shifter | All the functions, cheap | It's four boards and a rat's nest. The TP4056 has no power path, so you can't charge and run at the same time properly. |

**Prototype path until boards arrive:** QT Py ESP32-S3 + LiPo BFF (or PowerFeather) → a
Pololu 5 V step-up rated 2 A+ → 74AHCT125 breakout. That's enough to start firmware work on
battery telemetry and power limiting (section 8).

---

## 2. Sizing: what "200 LEDs for 4 hours at low brightness" really means

This sets everything else, so here is the math. For WS2812-class LEDs, each one draws about
0.5–1 mA even when black, and up to about 60 mA at full white.

| Scenario | Avg mA/LED (incl. idle) | LED power @5 V | Battery-side W (≈90% boost + ~0.4 W ESP) | Energy for 4 h | 1S capacity needed |
|---|---|---|---|---|---|
| Very dim / sparse | 2 | 2 W | ~2.7 W | ~11 Wh | ~3 Ah (one 18650) |
| **"Low" (target)** | 5 | 5 W | ~6 W | ~24 Wh | **~6.5 Ah (two 18650s in parallel, or a 6 Ah pouch)** |
| Moderate | 10 | 10 W | ~11.5 W | ~46 Wh | ~12.5 Ah (not wand-sized) |

What this means for the design:

- **Single cell (1S) only, from ~500 mAh up to ~10 Ah.** You can't parallel or series cells on
  the board. Use packs that already have a protection circuit (PCM).
- **LED rail target: 5 V @ 3 A continuous** (≈15 W), which draws ~4.5–5 A from the battery near
  empty. That current drives the battery-path, connector and trace choices below.
- **12 V mode:** ~1.2 A continuous (also ≈15 W). That's enough for ~200 WS2815s at moderate
  brightness. 12 V strips draw less current for the same light, so they're the better
  long-strip option.
- Firmware power limiting is part of the design, not an add-on (section 8).

---

## 3. Block diagram

```
 USB-C ──► [ESD + 5.1k CC pulldowns] ──VBUS──► [BQ25606 charger, NVDC power path] ──VSYS (3.0–4.4 V)──┬──► [3.3 V LDO, EN] ──► ESP32-S3-MINI-1
   │  D+/D- ───────────────────────────────────────────────────────────────────────────────────────┐    │                         │
   │  CC1/CC2 ─► ADC (source capability sense) ─────────────────────────────────────────────────┐   │    ├──► [TPS61088 boost, EN] ──► [high-side P-FET load switch] ──► V_LED (5 V or 12 V) ──► LED power pads
                                                                                                  │   │    │           ▲ FB jumper 5V/12V            ▲ gate: SW_ON AND LED_EN
 1S battery (JST-PH + heavy pads) ◄──BAT──► BQ25606 BATFET          MAX17048 fuel gauge (I2C) ◄──┘   │    │
                 │ NTC                                                                               │    └──► [V_LOGIC5: = V_LED in 5 V mode, or 5 V LDO from V_LED in 12 V mode]
                                                                                                     │                          │
 SLIDE SWITCH (+ external switch pads) ─► SW_ON (logic level; enables LDO, boost, load switch)      │                 [SN74AHCT245 octal buffer, /OE] ◄── 8 GPIO
                                                                                                     └── native USB to ESP32-S3 (flash + serial, no USB-UART chip)        │
                                                                                                                                                         33 Ω ──► DATA0..DATA7 pads
```

---

## 4. Part choices (and why)

### ESP32-S3 module: **ESP32-S3-MINI-1-N8** (or -N4R2 if you want PSRAM)
- 15.4 × 20.5 mm, so it fits across a 0.75" (19.05 mm) board with room to spare. The
  castellated WROOM-1 is 18 mm wide, which leaves ~0.5 mm per side at 0.75". Only pick WROOM-1
  if you widen the board to ~0.8" and want to hand-solder it.
- MINI-1 has pads underneath, so plan on getting boards assembled (JLCPCB/PCBWay PCBA). That's
  needed anyway: the charger and boost are QFNs that aren't practical to hand-solder.
- Antenna at one end of the board, overhanging or with the copper keep-out the datasheet
  specifies. Keep LED wiring away from that end.
- Native USB (GPIO19/20) goes straight to USB-C. No CH340/CP2102 needed, and ChromaBay's
  browser flasher already handles S3.

### Charger + power path: **TI BQ25606** (standalone, no I2C needed)
- **NVDC power path:** the system runs from USB when it's plugged in, charges the battery with
  whatever is left over, and pulls the extra from the battery ("supplement mode") when the
  LEDs need more than USB can give. This is the "use it while it's charging" requirement, done
  properly.
- Up to 3 A charge, input rated to 13.5 V with overvoltage protection, D+/D- adapter detection,
  thermistor input (TS), STAT and /PG outputs.
- 19.5 mΩ BATFET. ⚠️ **Verify first:** look up `IBATFET_OCP` (the battery discharge
  overcurrent trip) in the datasheet's Electrical Characteristics. If it's under ~5 A, either
  cap the LED rail at the level it allows, or feed the boost from BAT directly through its own
  fuse and leave only the ESP32 on VSYS. Also note TI's E2E warning: at a 3.0 V battery with
  heavy load, BAT can sag below the depletion threshold and the BATFET shuts off. Keep the
  BAT path low-impedance, and have firmware cut LED power first (section 8).
- **Charge current is set by hardware, with a safe default.** The ICHG resistor network has
  solder jumpers: **default 500 mA** (safe for any pack ≥ 500 mAh), bridge for **1 A**,
  bridge for **2 A**. Firmware can't override this, so a firmware bug can never overcharge a
  small pouch. Rule of thumb: ≤ 0.5C, so a 6.5 Ah pack gets 2 A (~3.5 h).
- Input current limit (ILIM) set to 3 A. If you plug into a weak port, VINDPM backs the
  charger off when VBUS sags, so a 500 mA laptop port doesn't brown out.
- Considered and rejected: TP4056/MCP73831 (no power path), IP5306-class power-bank SoCs (cut
  out by themselves at light load, poorly documented), BQ24074 (1.5 A total input/system
  limit is too low).

### Fuel gauge: **MAX17048** (I2C)
- Reports real state of charge in % (ModelGauge) with no sense resistor. It's the same chip
  Adafruit uses. The app can show battery %, and firmware gets a low-battery alert pin.

### LED boost: **TI TPS61088** (10 A switch, 2.7–12 V in, 4.5–12.6 V out)
- One converter covers **both 5 V and 12 V**. The only difference is the feedback divider, so
  the 5 V/12 V choice is a solder jumper (section 5).
- ⚠️ **It has no load disconnect.** When disabled, battery voltage leaks to VOUT through the
  high-side FET's body diode (confirmed by TI on E2E). That's why the load switch below
  exists. Without it, 200 "off" WS2812s would idle-drain ~150 mA.
- Inductor: ~1–2.2 µH, ≥ 8 A saturation, shielded, ~5×5 to 7×7 mm. This is the biggest part on
  the board and sets the minimum width.
- All V_LED-side capacitors rated **25 V** so the same BOM works for 12 V.
- Alternatives: TPS61288 (15 A switch, more headroom), TPS61178 (has load disconnect built in,
  check its current rating). Run the final pick through TI WEBENCH at 3.0 V in → 5 V @ 3 A and
  → 12 V @ 1.2 A.

### LED load switch: P-channel MOSFET, high side
- Sits after the boost and switches V_LED on and off. An N-FET from logic pulls the gate down.
  Use a gate resistor plus a 10 V zener so a 12 V rail doesn't exceed Vgs. The gate is driven
  low only when **SW_ON AND LED_EN (GPIO)**.
- Lets firmware fully cut strip power (soft-off, low-battery cutoff, "all black" for a long
  time) without the user touching the switch.
- Include a soft-start RC on the gate. Hot-connecting a strip with 1000 µF+ of capacitance
  will trip the boost otherwise.

### 3.3 V regulator: 600 mA+ LDO with EN (AP2112K-3.3 / TLV75733 class) from VSYS
- At a battery cutoff of ~3.3 V the LDO is only slightly in dropout, and the ESP32-S3 runs
  fine down to ~3.0 V. If you want a rock-solid 3.3 V right down to empty, upgrade to the
  TPS63802 buck-boost.

### Level shifter: **SN74AHCT245** (octal, TSSOP-20)
- 8 channels in one chip, with /OE. HCT/AHCT inputs read 3.3 V as high (VIH = 2.0 V) and drive
  full 5 V outputs. Don't use the single-MOSFET "I2C level shifter" boards: they're too slow and
  soft for WS2812 timing.
- 33 Ω series resistor on each output (ringing / ESD). Data is always 5 V logic, even in 12 V
  mode (WS2815 etc. take 5 V data).
- /OE has a pull-up so outputs stay off until firmware has brought the rail up. Firmware holds
  data pins low when LED power is off, so the strip isn't phantom-powered through its DIN pins.
- **V_LOGIC5** (the buffer's supply): bridged to V_LED in 5 V mode; in 12 V mode, a small
  12→5 V LDO (78L05 / LDL112 class, tens of mA).
- 8 lines = 8 clockless strips (WS2812/SK6812/WS2815…), **or** 4 clocked strips (APA102/SK9822,
  data + clock), or any mix.

### Other bits
- **USB-C:** 16-pin receptacle, 5.1 kΩ on CC1 and CC2 (sink), USB ESD array (e.g.
  USBLC6-2SC6), VBUS TVS. CC1/CC2 also go to two ADC pins through high-value resistors, so
  firmware can tell a default/1.5 A/3 A source (~0.4 / 0.9 / 1.6 V on the active CC). A weak
  source lowers the LED power budget while plugged in.
- **Buttons:** BOOT (GPIO0) doubles as the ChromaBay pattern button
  (documentation/BUTTON_CONTROL_PLAN.md). RESET. Both side-actuated if they fit.
- **Indicators:** charge LED on STAT (hardware, works with the switch off), one status LED on a
  GPIO. Add a solder jumper to disable LEDs for dark-environment builds.
- **Qwiic/STEMMA QT** (JST-SH 4-pin) footprint on the I2C bus (optional). An IMU is the obvious
  wand add-on.
- **Polyfuse / eFuse** on V_LED output: a shorted strip shouldn't kill the board.

---

## 5. Jumper/config summary (all solder jumpers, all default to the safe choice)

| Jumper | Default | Options |
|---|---|---|
| CHG | 500 mA | 1 A, 2 A (bridge both = 2.5 A) |
| VLED | 5 V | 12 V (moves FB resistor *and* V_LOGIC5 source; it's one 3-pad + one 2-pad pair, printed side by side) |
| NTC | Onboard 10 kΩ NTC next to the battery connector | External: use the pack's thermistor through the 3rd pad |
| SW | Onboard slide switch | Cut trace → use the SW pads for an external switch |
| LEDS | Indicator LEDs on | Cut to disable |

---

## 6. The on/off switch

- **The switch carries logic, not battery current.** It drives SW_ON, which enables the 3.3 V
  LDO, the boost, and the LED load switch. That means:
  - Any tiny slide switch works, and so does an external switch on thin wire (pads next to the
    onboard one, with a cut-trace jumper). It can also be a magnetic reed switch for a sealed
    wand.
  - Off draw is just charger + boost + gauge quiescent, tens of µA. A 3 Ah cell would take
    years to drain. That's effectively zero, and nothing is "half on."
  - **Charging still works with the switch off**, and the charge LED still shows.
- If you want a true zero-µA battery disconnect for long storage, add an optional BAT
  disconnect pad pair (cut-trace) in line with the battery. You can wire a high-current switch
  there, but it's not the normal path.

---

## 7. Mechanical / layout

- **Width 0.75" (19.05 mm), length ~70–85 mm** (estimate; layout will tell). Two layers might
  work. Four layers (solid ground plane, wide copper pours for the 5 A path) is worth the small
  extra cost for the boost's sake.
- Suggested order along the length, from one end:
  1. **USB-C** (end-facing) + **battery connector** + charger. Charging side.
  2. Fuel gauge, slide switch (side-facing, near the edge), boost + inductor + load switch.
  3. **LED output pads**: heavy V_LED/GND pads (sized for 18 AWG) + DATA0–7, with silkscreen.
     Keep them close to the boost so the high-current loop is short.
  4. Level shifter, then **ESP32-S3-MINI-1 with the antenna at the far end.**
- **Battery connector:** JST-PH 2-pin is the standard, but it's rated ~2 A, which is fine for
  small packs and too little for full 5 A LED loads. So: a JST-PH footprint (Adafruit/SparkFun
  polarity; **other vendors' packs are often reversed, so print "+" and "−" big on the silk**)
  **plus** parallel solder pads for 18 AWG leads, for big 18650 packs.
- Mounting: two M2 holes, or none and a slot-in fit for tubes. Wands probably want no holes and
  a printed sled.

---

## 8. Firmware work this board implies (ChromaBay `esp32/`)

The board only pays off with these. None exist yet (as of today the firmware has no battery or
power-limit code):

1. **Power limiting:** a configurable max mA for the LED rail, scaled down automatically when
   on a weak USB source or low battery. Estimate current from pixel values (FastLED-style
   `setMaxPowerInVoltsAndMilliamps`) and include each LED's idle current.
2. **Battery telemetry:** MAX17048 % + voltage, charger STAT/PG → a new status field the app
   shows on the Devices tab.
3. **Low-battery behavior:** at ~15% dim to a floor; at ~3.3 V cut V_LED (load switch); just
   before empty, deep sleep.
4. **LED_EN handling:** rail off when brightness is 0 or idle for N minutes, data pins held low
   while it's off, /OE released only after the rail is up and settled.
5. **Board profile:** a "ChromaBay Controller" board preset (pins, 8 outputs, voltage mode)
   so users don't set pins by hand.
6. **8 simultaneous clockless outputs:** the S3 has only 4 RMT TX channels. The current
   NeoPixelBus RMT methods top out at 4 strips. Past 4, use NeoPixelBus's S3 parallel
   I2S/LCD (x8) methods.

---

## 9. Pin map (draft, ESP32-S3-MINI-1)

| Function | GPIO | Notes |
|---|---|---|
| USB D− / D+ | 19 / 20 | Native USB |
| BOOT / pattern button | 0 | Strapping pin, pull-up |
| DATA0–DATA7 → AHCT245 A1–A8 | 1, 2, 4, 5, 6, 7, 15, 16 | Avoid strapping pins 3/45/46 and the flash/PSRAM pins |
| Shifter /OE | 17 | Pull-up = disabled |
| LED_EN (load switch) | 18 | Pull-down = off |
| I2C SDA / SCL | 8 / 9 | Fuel gauge + Qwiic |
| Gauge ALRT | 10 | |
| Charger STAT / /PG | 11 / 12 | Open-drain, pull-ups to 3.3 V |
| CC1 / CC2 sense | 13 / 14 | ADC1 (works with Wi-Fi on) |
| Status LED | 21 | |

Check the final assignment against the MINI-1 datasheet before layout; the N4R2/N8R2
variants reserve extra pins for PSRAM.

---

## 10. Open questions / next steps

1. Look up the BQ25606 `IBATFET_OCP` value. It decides whether the boost hangs off VSYS or BAT.
2. WEBENCH the TPS61088 (or TPS61288) at both output voltages and choose the inductor.
3. Is "4 two-pin strips" 4 × APA102 (data+clock) or 4 × WS2812 (data+GND)? Either works; it
   changes the silkscreen and pad grouping.
4. Is there a hard max length for the wand? It fixes the layout.
5. Then: KiCad schematic in `hardware/controller-board/`, layout, JLC PCBA order for ~5
   boards.
