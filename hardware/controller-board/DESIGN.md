# ChromaBay battery LED controller: board + case design

Status: **KiCad rev A: schematic done (ERC clean), parts placed on 36 × 66 mm with a tapered nose (DRC/parity clean),
first-pass routed (draft), power stage still to hand-lay-out.** One PCB, three builds (Core / Plug / Complete); see section 0. See [README.md](README.md) for the files, renders and how to regenerate them. Where rev A
differs from this spec, section 0 wins.

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

## 0f. First routing pass (draft: connectivity, not yet a power layout)

**Placement bug fixed.** The auto-placer compared net names without KiCad's leading "/", so it never found
a target and spiralled every passive out from the board centre. For example the charger's REGN cap ended up
29 mm from its pin. It now places the parts on charger/boost control pins first, then those chips' rail caps,
then other chip pins, rails, and the rest. The USB ESD part (U8) is now fixed beside the USB-C.

**Routing pipeline** (`tools/route.py`, Freerouting **1.9.0** under `xvfb-run`; 2.x ignores its pass limit and
only saves on exit):
1. `tools/fanout.py` drops a via beside every GND SMD pad to the In1 plane (~105 vias).
2. In1 is exported as a plane layer, so no signals cross the ground plane. A 0.35 mm ring along the edge is
   no-track.
3. Route (~10 min), import in a fresh process, restore the outer GND pours, fill.
4. `tools/patch_route.py <drc.rpt>` is a small grid maze router that finishes leftover gaps where there's room.
   `--rip` lets it rip up other traces, but in the charger corner that thrashes, so it's off by default.

**Result:** 271 vias, about 3 m of track on F/In2/B. In1 is untouched solid GND. DRC shows **0 clearance
errors and 6 unrouted** connections, all short hops at the charger and boost:

| Net | Between |
|---|---|
| VSYS | stub near U2 to stub by the LED |
| CHG_PMID | C2 to U2 pin 23 |
| CHG_STAT | R34 to U2 pin 5 |
| BST_VCC | C13 to U3 pin 1 |
| BST_COMP | C17 / R19 to U3 pin 18 |

**Not ready to order.** The power paths came out as 0.4 mm autorouted traces, often long. Examples: VSYS
128 mm in total, BAT 70 mm, and the charger and boost switch nodes about 21 mm each. That carries current
for testing connectivity, but a 2–3 A charger and boost need:
- short, wide pours for VBUS/PMID, VSYS, BAT, 5V_BOOST and VLED;
- tight switch-node loops (U2 to L1, U3 to L2) on the top layer;
- input and output caps right at the pins.

The next step is to hand-lay out those two corners in KiCad: delete their autorouted copper, draw the pours,
then re-run `tools/route.py`'s import or `patch_route.py` for the rest. From here on, edit the board in KiCad.
**Don't run `gen_pcb.py` again** (it re-places everything and throws routing away).

## 0e. 18650 cases with the same outline (supersedes the brick in 0b/0d)

Every case variant now has exactly the same outline. Only the depth of the bottom half changes.
- Two 18650 cells side by side are 37 mm wide, so they need about 68 mm of the case at full width (65 mm cells
  plus the protection board). The tapered nose leaves only ~58 mm at full width. That is why the old brick was
  wider, longer and overhanging.
- **`18650`**: one cell, centred lengthwise, with its protection board under the nose. About 3.4 Ah / 12.5 Wh,
  roughly 2 h at the 200-LED "low" load. The case is 30.8 mm tall.
- **`brick`**: two cells **stacked** (1S2P), about 6.8 Ah / 25 Wh, roughly 4 h. The case is 49.6 mm tall.
- The centred cells clear the M2 screw bosses at the antenna end, which sit 2.6 mm in from each side.

**Removing the OUT1 push-ins later.** The 2060s are SMD parts on large pads tied to the 5 V and GND copper, so
taking one off needs hot air with board preheat, or two irons plus lots of flux, and risks lifting pads. To build
without them, order the `plug` or `core` BOM (`fab/`), which leaves J2/J6 off, and wire to the ten pads. On its
own that does not make the board thinner: the JST-PH (5.5 mm) is the tallest part. A `core` build (no JST, no
WAGO) is limited by the USB-C (3.3 mm) and the inductors (2 mm), so its case could be about 2.2 mm shallower
than now.

## 0d. Fixes (supersedes 0c where they differ)

- **Battery-lead notch: 4 × 3 mm** (was 8 × 5). JST-PH crimps take 24–28 AWG (24–32 with the smaller crimp), and
  their insulation is at most ~1.5 mm OD. The two leads leave the plug on a 2 mm pitch, so they span ≤ 3.5 mm. The
  mated plug's back ends ~3.5 mm from the board edge, so the leads bend straight down into the 3 mm-deep notch.
  The case's side U-notch for external-battery leads is now 4 × 2 mm.
  Even the 2 × 18650 brick should stay on 24 AWG: PH contacts are rated 2 A, so for sustained LED loads above
  that, solder the pack to the BAT+/BAT− pads instead.
- **WAGO lid slot** moved over the release buttons (board x 27.2–29.4). It had stayed over the wire-entry end when
  the push-ins were turned around.
- **Brick case:** the 18650 bay now starts at the business end and matches the length of the rest of the case
  (73 mm, was 86).
- **Silkscreen labels** on every wire pad: BAT+ / BAT− / NTC on the battery pads, and GND 5V C1 D1 … C4 D4 beside
  the LED pads.

## 0c. Flush business end, no printed parts (supersedes 0b where they differ)

- **Button and switch overhang the board.** The middle of the business end is now a 1.9 mm tab that runs through
  the case end wall, so the board edge is **flush with the case face**. The button plunger sticks out ~0.95 mm past
  it and the slide-switch handle ~1.0 mm. Both are usable with a fingertip, with no printed plunger or cap (those
  parts are gone). Pads stay ≥ 0.3 mm from the edge, and the button's front locating peg was dropped so it doesn't
  sit on the edge.
- **LED set back.** Button, USB-C and switch are packed edge to edge (x 5.3–30.7 mm). The status LED sits behind
  the USB-C, aimed at a small slot beside the USB-C opening. It will also glow through most printed plastics.
- **Taper:** the rounding starts 5 mm in from each side (the button/USB/switch row needs 25.4 mm), so the case tip
  is about 26 mm wide. That's ~2 mm wider than the printed-extender version, but the case is also 1.9 mm shorter
  because the end wall no longer sits in front of the board.
- Mic moved to x 9 (its channel still exits the end face under the board). The EXT5V cut-jumper moved to the free
  corner by the switch. Jumper labels are placed automatically where they clear every pad and silkscreen line.
  The header's silkscreen outline was removed so it no longer runs through the pin labels.

## 0b. Taper + usability pass (supersedes 0a where they differ)

- *(Replaced by 0c.)* **Nose taper:** the rounding now starts **8 mm in from each side** and runs 15 mm down (was 2.6 × 12). The board's
  straight tip is 20 mm wide (case tip ~24 mm). To allow that, the button and power switch sit ~2.7 mm back from the
  edge, and the case includes two small printed parts (`case/out/button-plunger.stl`, `switch-cap.stl`): a captive
  plunger for the button and a cap that slips over the slide-switch handle. Both reach ~1.2 mm past the end wall, so
  no paper clip is needed. Tune the handle pocket on the first print.
- **5 V for accessories:** the header is now **2 × 12** and adds **VUSB** (USB 5 V, present only while plugged in) and
  **5V** (the LED rail: fused at 3 A, on only while firmware enables the LEDs). The LED pad strip's V pad is the same rail.
- **Battery notch:** 8 mm along the edge × 5 mm deep (was 9.8 × 6.6). A PHR-2 plug is 6 mm wide, and its 24–28 AWG
  leads (≤ 1.3 mm OD each) drop straight through to the cell.
- **Charge jumpers** JP1 (+0.45 A) and JP2 (+1 A) sit side by side under a CHG label. Every solder jumper now has a
  silkscreen label.
- **Case:** one opening in the right wall covers the WAGO entries and all ten LED pads.
- **Battery sizes** (energy ≈ Ah × 3.7 V; run time at the 200-LED "low" load of ~6 W):

  | Case | Cell | Capacity | Run time at 200 LEDs, low | Outer size |
  |---|---|---|---|---|
  | external | your pack, outside | any | — | 39.8 × 75 × 11 mm |
  | slim | 603450-class pouch | ~1.1 Ah (4 Wh) | ~40 min | 39.8 × 75 × 16.6 mm |
  | thick | 103450-class pouch | ~2 Ah (7.4 Wh) | ~1.2 h | 39.8 × 75 × 20.6 mm |
  | **brick** (new) | 1S2P 18650 pack | **~6–7 Ah (24 Wh)** | **~4 h** | 41.6 × 86 × 30.5 mm |

- **Power behaviour:**
  - With no USB, the red (charge) LED is dark. The charger only drives it while charging, and green is firmware-only.
  - On USB with no battery, the board runs from USB (the charger's power path powers the system directly), limited to
    about 2.4 A of input.
  - Programming over USB-C works whenever the **power switch is on**: the switch gates the 3.3 V regulator. Charging
    works with the switch off.
  - Check on the first boards: with no battery fitted, BQ2560x chargers can blink STAT while they probe for a cell.
- **Mic port:** the mic listens through a hole in its *underside* and a matching hole drilled through the board. The
  board's underside there sits on the case's solid nose block, so the channel in the case floor is what gets outside
  sound to it. Without the channel the port would face sealed plastic.

## 0a. Latest layout pass (supersedes older notes in section 0 where they differ)

- **Board 36 × 66 mm, 1.6 mm**, with a **rounded nose**: the business-end corners are quarter-ellipses (2.6 × 12 mm)
  that start right where the controls end (`tools/outline.py`).
- **Business end, packed edge to edge** (pad extents x 2.95–33.06): button · LED · USB-C · power switch, all
  facing out. The mic port exits under the LED. That's the small hole under the LED hole in the case: a
  channel in the case floor carries sound from the end face to the bottom-port mic.
- **3D models fixed:** the USB-C, LED and slide-switch models were shifted 1.1–2 mm inward of their pads (an
  easyeda2kicad offset bug on models it rotates 180°). The footprints now carry corrected offsets, so all three sit on
  their pads and reach the board edge. The other rotated models are symmetric and unaffected.
- **Floorplan by function:**
  - POWER on the left, from the USB-C down to the battery: charger right behind the USB-C, JST-PH and reverse-polarity
    FET beside it, 5 V boost below, then the load switch.
  - LED OUTPUT on the right edge: WAGO push-ins, pad strip, and the level shifter, ESD and fuse next to them.
  - USER HEADER across the board.
  - MCU at the far end: module, 3.3 V regulator, IMU.
  - Passives auto-place next to the pin they serve.
- **Battery notch:** the JST-PH faces into a 6.6 × 9.8 mm notch in the left edge. The plug sits in the notch, and
  the lead drops straight through it to a cell under the board, so there's room to wrap without fouling the case.
  The case ledge is open under the notch.
- **User header: 2 × 11 through-holes at 2.54 mm** (fits a pin header, or wires). It carries every free GPIO (IO3/11/26/
  43/44/45/46), 3V3, GND ×2, I2C, T1–T4, BOOT, ext-mic BCLK/WS/SD and the ext power-switch pair. Each hole is labeled on
  the silkscreen. The LED pads and battery pads were already through-holes.
- **Removing connectors:** the JST-PH is two small SMD pins plus two tabs, easy to remove with an iron. The WAGO 2060s
  are SMD with large reflowed pads, so removing them takes hot air and isn't something to do casually. For builds
  without them, order the `core` or `plug` BOM instead (`fab/bom-jlc-*.csv`). Every LED signal is on the pad strip either way.

## 0. Rev A as built in KiCad (supersedes the spec below where they differ)

**Status:** the schematic is ERC-clean and all 124 parts are placed, with 0 schematic-parity issues. The
remaining DRC items are unrouted connections and silkscreen cosmetics. **The board isn't routed yet** (see "Routing").

| Topic | Now | Why |
|---|---|---|
| Board | **36 × 68 mm, 1.6 mm, 4-layer** (1:1.9) | 32 × 60 placed at ~100% part coverage, with nowhere left for traces. Freerouting stalled at ~120 unrouted there. 36 × 68 leaves routing channels. |
| ESP32 antenna | **Overhangs the far edge by ~5 mm** | Espressif's preferred placement. It frees the dead copper keep-out strips beside the module (the empty space in the earlier renders). |
| Business end | **User button, LED, USB-C, power switch all face out the end**; the mic port exits there too, through a channel under the board | The three controls you'll touch most share one face. |
| Battery | **JST-PH 2-pin, SMD, side-entry (opening faces the left wall)** + small + / − / NTC wire pads | Swappable packs. The pads are for packs without a plug. **Check polarity per pack**: + and − are on the silk. |
| LED outputs | **OUT1 on two WAGO 2060 push-in blocks** (G V + C1 D1; SMD, reflowed by JLC, **4.5 mm tall**, 18–24 AWG, wire entry facing the right wall). **All 8 LED lines + G/V also on a 2.54 mm solder-pad strip** | Replaced the 12.8 mm-tall lever terminal: same footprint area, fits under the normal lid, and needs no hand soldering. The case has a wall window for the wires and a lid slot for the release buttons, so wiring never needs the case opened. |
| Battery sense | **1M/1M divider on IO10 (ADC1)** instead of the MAX17048 gauge; IMU INT1 moved to IO14 | −$2.01/board. 2 µA standing drain. |
| Spare GPIO | **IO3\*, IO11, IO26, IO43, IO44, IO45\*, IO46\*** on their own pads (left edge). Plus the existing user pads: T1–T4, SDA/SCL, ext-mic BCLK/WS/SD, BOOT | Every free pin is broken out. \*Strapping pins: don't pull IO45/IO46 high at boot. IO43/44 are UART0 (boot log). |
| Wires | Exit through **U-notches at the case seam on the long sides**, right next to the business end | The end face is full with the controls and USB. |
| BOOT / RESET | BOOT is a user pad (GPIO0). No RESET: the power switch is the reset | Saves parts and area. Native USB flashing rarely needs BOOT. |
| UART pads | Dropped | USB serial/JTAG covers logging. |
| Mic | INGHAi GMA3526H10-B26 PDM, $1.00 (datasheet pinout verified) | The ICS-43434 is $3.67 at JLC. |
| ESD | SRV05-4 ×3 (USB D+/D-/CC; outputs) | JLC Preferred-Extended, no loading fee. |

### Builds: one board, three ways to use it

The same PCB serves all three. They differ only in which connectors JLC fits (`fab/bom-jlc-<build>.csv`)
and which case you print:

| Build | Battery | LEDs | Case | PCBA / board at 5 · 10 · 30 |
|---|---|---|---|---|
| **Core** (full custom) | Solder to the + / − / NTC pads (18 AWG holes, any connector you like) | Solder to the pad strip, all 4 outputs | Optional (any variant, or none) | $25.64 · $18.72 · $13.86 |
| **Plug** | JST-PH | Solder to the pads | Any | $26.31 · $19.08 · $14.02 |
| **Complete** (GLEDOPTO-style, solder-free) | JST-PH, cell inside the slim/thick case | Push wires into OUT1 from outside; OUT2–4 still on pads | Slim or thick; never needs opening | $27.61 · $20.08 · $14.72 |

**Recommendation: build everything as "Complete".** It's only ~$1.36/board more than Core at 10 boards, one SKU is
simpler, and Core users can ignore the JST and WAGO (every signal is still on solder pads). Make separate builds
only if you order 30+ of one kind.

### What each feature costs (`python3 tools/cost_options.py 10`, live prices, per board at 10 boards incl. the per-order fee share)

| Change | Saves / board | Trade-off |
|---|---|---|
| ~~Fuel gauge → voltage divider~~ | **done** ($2.01) | Battery % now comes from a 1M/1M divider on IO10 (ADC1), ±10–15% under LED load |
| Drop the IMU | **$1.47** | No motion, taps or wake-on-shake |
| IMU → LIS2DH12 (accel only) | $0.43 | No gyro (swing speed/rotation) |
| Drop the onboard mic | **$1.31** | External I2S mic pads still work |
| Drop the WAGO push-ins | $1.00 | No solder-free LED wiring |
| Drop output ESD | $0.57 | Hot-plugging strips gets riskier |
| Drop the JST-PH | $0.36 | No plug-and-play battery |
| Drop reverse-polarity FET | $0.21 | Not recommended: a backwards pack can kill the charger |
| **Order 30 instead of 10** | **$5.70** | Inventory |

Things that **don't** move the price: board thickness (0.8 vs 1.6 mm), board size at this scale, and swapping
cheap Extended parts for "Basic" ones (JLC has no Basic equivalents for most of them). Going from 4 layers to 2
would save ~$0.50–1/board but makes routing and power/RF layout much harder: not worth it.
**The ESP32-S3 module ($4.17) and the per-order fees (~$65–80) are the floor.**

### LED pins and hardware acceleration
All 8 LED lines (IO15/16/17/18/21/33/34/35) can use every S3 output peripheral. The S3's GPIO matrix routes RMT
(4 TX channels), both general-purpose SPI hosts (SPI2/SPI3, fine up to ~40 MHz through the matrix; APA102 rarely needs
more than 20) and the I2S/LCD parallel peripheral (all 8 lines at once) to any of these pins. **Keep the module an N8 or
N4R2:** octal-PSRAM variants (N8R8 etc.) take IO33–37.

### Checks done (datasheets)
- **BQ25606** `IBATFET_OCP` ≥ 6.0 A, so the boost stays on SYS. Floating D+/D- means "unknown adapter", so the ILIM pin sets the input limit (200 Ω → 2.4 A).
  Charge current 0.45 / 0.9 / 1.45 / 1.9 A via JP1/JP2.
- **Battery temperature window** with the NCP15XH103 (B = 3380) NTC: rev 1's 5.1k/33k divider cut off charging at ~7 °C. It's now
  **5.1k/24k → charging allowed ~0.7 °C to ~61 °C**, close to the 103AT design window.
- **TPS61088 compensation:** computed from the datasheet equations (Rsense 0.08 Ω, gm 190 µA/V, fc 15 kHz at 3 A from a 3.0 V cell,
  ~75 µF effective output C after DC bias): **R5 = 10k, C5 = 10 nF, C8 = 47 pF**. RFREQ 150k ≈ 1 MHz, ILIM 150k ≈ 7.9 A peak,
  inductor peak 6.3 A at 3 A out from 3.0 V (< 7 A sat). Still worth one WEBENCH run or a load-step test on the first boards.
- **Reverse-polarity FET** AONR21321: < 29.5 mΩ at −4.5 V. At 3.5 A from a low cell that's about 0.5 W, warm but fine. At the
  typical ~2 A it's ~0.15 W.
- **LED:** LTST-S326KGJRKT C1 = red = charge (driven by the charger, works with the switch off), C2 = green = status (firmware).
- **Mic** pinout (DATA, SELECT, GND, CLOCK, VDD) and the **IMU**'s unused SDx/SCx pins (tied to GND, allowed) match their datasheets.
- **Not verifiable from the datasheets I could extract:** which pins of the two 4-pin switches (SW2 button, SW1 MSK12C02) are
  internally paired. The design assumes the usual 1-2 / 3-4 pairing. Check against the physical part or JLC's preview.

### Routing
Freerouting runs headless (`tools/route.py`). On 36 × 68 it got from 222 to 40–90 unrouted connections in 55 passes,
then oscillated and never closed. That's typical for a dense mixed-signal board, and the charger and boost power loops
shouldn't be autorouted anyway. Plan: hand-route the two converters' power loops, the battery → FET → charger path and the
5 V → load switch → fuse → J2/J5 path as copper pours in KiCad, then let Freerouting fill in the signals. Expect 1–2 days for
someone fluent in KiCad.

### Thickness and sturdiness
- **1.6 mm board** (up from 0.8): stiffer, standard JLC stock, no cost difference. It also matters for a lever terminal and a
  USB-C socket that get pushed on. The 0.8 mm board saved 0.8 mm, but the JST-PH alone adds more height than that.
- **Stack height (no terminal):** JST-PH 5.5 mm is now the tallest part, then USB-C 3.2, ESP32 2.55, inductors 2.0. The board
  with parts is ~7.1 mm.
- **Case:** external battery 39.8 × 77 × 11 mm, slim cell (603450, ~1.1 Ah) 16.6 mm, thick cell (103450, ~2 Ah) 20.6 mm.
  The WAGO push-ins (4.5 mm) fit under the normal lid. No hump.
- **What costs thickness:** the JST-PH (+2.3 mm over the USB-C). A flat JST-SH or
  Molex PicoBlade battery plug would save ~2 mm, but those are rated 1 A, too little for this load. **The JST-PH is the right
  call for swappable packs.**

### Other constraints worth a second look
- **Board-sized internal cells are small.** A 603450 is ~1.1 Ah: about 1 h at the 200-LED "low" target, or ~4 h at ~60 LEDs.
  Long run times mean the external-battery case.
- **JST-PH is rated 2 A.** The LED rail can pull ~3.3 A from the cell at full 2 A output. Firmware should cap LED current when on
  battery, or use the wire pads for big loads.

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

## 10. Layout (single-sided, 0.8 mm 4-layer; rev A is 32 × 64 mm, see section 0)

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

## 11. BOM and JLC cost (live JLC prices, Nov 2026: `python3 tools/jlc_cost.py`)

44 unique parts, 93 placements, ~378 joints per board. 17 unique Extended parts at $3.07 each per order (Basic and
Preferred-Extended load free). Economic PCBA: setup $8.18, stencil $1.53, $0.0016 per joint.

| Boards | Parts / board | PCBA fees / order | PCBA / board | + bare 4-layer PCB (est.) | **≈ total / board** |
|---|---|---|---|---|---|
| 2 (min PCBA qty; JLC still makes 5 PCBs) | $15.89 | $63 | $47.45 | ~$10 / 5 pcs | **~$50** |
| 5 | $15.89 | $65 | $28.88 | ~$10 / 5 pcs | **~$31** |
| 10 | $14.31 | $68 | $21.10 | ~$15 / 10 pcs | **~$22.60** |
| 30 | $12.99 | $80 | $15.66 | ~$30 / 30 pcs | **~$16.70** |

**Bare PCB is an estimate.** JLC advertises 4-layer, 5 pcs, ≤ 100 × 100 mm "from $2" for promos/new users, and ~$7 normally.
Real quotes for 36 × 68 mm at 1.6 mm usually land in the $7–15 range for 5–10 pcs. Upload the Gerbers to get the exact number.
Not included: shipping (~$15–25 DHL/FedEx) and US import duty on JLC orders, which is currently significant and changes often.
Optional lever terminal: ~$0.30, hand-soldered, or added as a THT line at JLC (extra THT fee).

**First validation run:** 5 boards ≈ $150 + shipping/duty. That's the minimum sensible run: the fixed fees are nearly the same
for 2 or 5.

Cost cuts, roughly in order of value: order 10+; ADC divider instead of the MAX17048 (−$1.70/board, −$3.07/order); swap
cheap Extended parts (NTC, polyfuse, slide switch, LED, LDO, JST) for Basic/Preferred ones (−$3.07/order each); LIS2DH12
instead of LSM6DS3 (no gyro, −$0.40). New JLC accounts get a coupon pack (incl. a $10 SMT coupon), and JLC issues monthly coupons.

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

## 13. Pin map (rev A, ESP32-S3-MINI-1-N8; source of truth: `tools/design.py`)

| Function | GPIO |
|---|---|
| USB D− / D+ | 19 / 20 |
| BOOT (user pad: touch to GND at power-on) | 0 |
| CC1 / CC2 sense (ADC) | 1 / 2 |
| Touch/spare pads T1–T4 | 4, 5, 6, 7 |
| I2C SDA / SCL (IMU 0x6A, pads) | 8 / 9 |
| Battery voltage sense (ADC1, BAT/2) | 10 |
| IMU INT1 (wake) / INT2 | 14 / 13 |
| (unused) | 11 |
| Charger /PG | 12 |
| C1/D1, C2/D2, C3/D3, C4/D4 | 15/16, 17/18, 21/33, 34/35 |
| Shifter /OE · LED_EN (boost + load switch) | 36 · 37 |
| PDM mic CLK / DATA | 38 / 39 |
| External I2S mic BCLK / WS / SD (pads) | 40 / 47 / 48 |
| Status LED · User button | 41 · 42 |

The charger's STAT pin drives the charge LED only; firmware reads charge state from /PG plus the
gauge's charge-rate register.

---

## 14. Open questions / next steps

1. **Infinity Scarab fit:** need its internal cavity dimensions (L × W × H) and where the
   USB/switch can poke out. If it's ≥ 28 × 56 × 3.6 mm (slim, no battery), it fits as-is. A
   smaller cavity means cutting optional parts in the order of least value.
2. BQ25606 `IBATFET_OCP`; WEBENCH TPS61022 vs TPS61088 with 4 × 4 × 2 mm inductors.
3. JLC stock / basic-vs-extended: ICS-43434, LSM6DS3TR-C, BQ25606, boost, mid-mount USB-C,
   low-profile inductors.
4. KiCad schematic → layout → outline/feature JSON → parametric case → PCBA order (~10).
