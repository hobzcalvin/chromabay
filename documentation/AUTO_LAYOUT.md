# Camera auto-layout

Point the phone at the running LEDs, they flash a coded sequence, and we recover a WLED
ledmap automatically.

## v2 (2026-11) — current design

| Piece | Where |
|---|---|
| Flash sequences + decoder | `src/lib/structuredLight.ts` |
| Closed-loop scan (brightness probe → decode → retry) | `src/lib/autoScan.ts` (wired into `AutoLayoutModal.svelte`) |
| Geometry (rectify, lattice fit, rotate) | `src/lib/autoLayout.ts` |
| Synthetic camera + scoring | `src/lib/autoLayoutSim.ts` |
| Offline bench (20 physical setups) | `node --import ./automation/ts-resolve.mjs automation/autolayout-sim.ts` |
| Real-hardware rig (hands-free, CfT) | `automation/autolayout-rig.mjs --expect=16x16s --runs=5` |
| Replay a real capture | `automation/replay-capture.ts <run.bin> --expect=…` |

**Firmware mode 3 (feat 9): inverse pairs + parity.** `[ALL-ON][ALL-OFF][bit0][¬bit0]..[bitN][¬bitN][par][¬par]`. Each
bit is read per pixel as "brighter in b than in ¬b" (Scharstein & Szeliski, CVPR 2003): no
threshold, ambient light cancels, every LED blinks (in mode 1 an all-ones code — the last LED of
any 64/256/1024 strip — never did), and about half the LEDs are lit in every frame, so
auto-exposure holds still. A pixel lit by two LEDs (bloom between them) reads ~equal on the bits
they differ in and is rejected as low-confidence instead of decoding to a wrong ID. The app now
sends `bits` (firmware sized it from the *longest* strip, mismatching the app on uneven devices).

**Decoder.** (1) Exposure: divide out each frame's gain (median ratio to a temporal-median
reference). (2) Timing: frame-to-frame change energy spikes at every device frame edge; fit the
edge train's period + phase (device clock drifts ±8%, camera unsynced), drop edge frames.
(3) Per pixel, average every clean frame of each slot over all cycles; find which slot is ALL-ON by
the sequence's *structure* (pairs sum to ON+OFF), not mean brightness. (4) Read codes, cluster
same-code pixels, position = core-only weighted centroid (a one-sided halo past edge LEDs pulled
whole-blob centroids ½ pitch outward).

**Parity.** Under hard light (flicker, PWM, off-axis spots) the dominant error is one misread bit,
which lands an LED exactly on a neighbour's spot. The parity pair rejects those pixels; anything
that slips through and lands on another ID's spot loses to the stronger ID (collision guard).

**Reflections.** A code seen in two places (glossy floor, window) → keep the sharpest (highest
peak contrast) among substantial candidates; a reflection is diffuse.

**Closed loop.** The readable flash level spans ~1–200 across setups (close-up dense panel vs lit
room), so a fixed level can't work. Probe with a strobe: dimmer while LED cores clip, brighter while
ON−OFF contrast < 30; then decode. Up to two more passes fill in what was missed — dimmer if
clipping plausibly hides LEDs, otherwise brighter — merging only new IDs, registered (affine fit on
shared IDs) so a handheld camera's drift between passes doesn't misplace them. Last, a **targeted
pass** (firmware calibration mask) flashes only the still-missing LEDs at full level with the rest
dark (plus a few anchors at the normal level, for registration): a dim/occluded LED is buried in
its neighbours' glow at any shared level, never alone.

**Wiring fit** (`fitWiring` in `autoLayout.ts`). Most installs are a W×H matrix wired by rows or
columns, straight or serpentine. For every such wiring of `numLeds`, fit a homography from ideal
grid coordinates to the decoded points (trimmed least squares; one grid step must be ≈ one pitch
and the axes not parallel, or a straight strip "fits" everything) and take a clear winner. Exact by
construction — jitter up to 0.2 pitch, perspective, 30% of LEDs missing or out of frame — and it
places undetected LEDs by their wiring. Free-form installs get null and fall back to the lattice fit
(which now grows LED-to-LED instead of snapping to one global grid, so bent arrays hold together).

**Bench results, harsh set** (33 scenarios / 4898 LEDs, adding: fairy lights at random angles,
wavy curtain, 10× brightness spread, 20% occluded, floor reflection, 120 Hz mains flicker with short
exposure, LED PWM at 400 Hz / 1.2 kHz, panel filling the frame, defocus, 160×90 camera, partly out
of frame, all at once), each on 3 random installs/captures (`--seed=0/2/3`): closed loop + wiring
fit → **99.4–99.5% LEDs located, 0 misplaced, 96/96 layouts exact** (the missing ~0.5% are dead or
out of frame — the wiring fit still places them). Scans take 10–40 s.

More things the harsh set forced:
- **Exposure gain from background only.** When the panel fills the frame there is no background;
  the gain fit then divided the flash itself out (IDs scrambled) — so it's skipped.
- **Flicker bands** (mains light + short exposure + rolling shutter) are flattened per row, but only
  for the *timing fit* (kept if it gives sharper edges): in a row-wired panel the code bits are row
  patterns, and per-row flattening of the pixel read would erase them.
- **Strip continuity.** An LED far (>2 gaps) from BOTH wiring neighbours is suspect (a reflection
  that won): use the code's other sighting, or drop it.
- **Targeted pass anchors.** It also lights ~12 found LEDs (away from where the missing ones should
  be) at the main pass's level so it can be registered; the missing ones alone go to 255.
- If two passes can't be registered, keep whichever read more LEDs (a bad first pass no longer wins).

**Bench results, first set** (synthetic; `autolayout-sim.ts`, 20 scenarios / 3274 LEDs):

| Pipeline | LEDs correct | Wrong positions | Layouts exact |
|---|---|---|---|
| v1 (old decoder, mode 1) | 8.3% | 72 | 2/19 |
| v2 decoder, mode 1 (old firmware) | 90.2% | 58 | 9/19 |
| v2 decoder, mode 3 | 96.0% | 10 | 16/19 |
| closed loop, mode 3 | 99.8% (every scenario at its max) | 0 | 18/19 (the 19th has dead LEDs) |

The same bench found four lattice-fit bugs (even grids came out N+1×M+1, dense grids drifted,
rectify squashed aspect, straight strips collapsed to 1×1) — fixed. **Caveat:** the simulator and
decoder were written together; real captures are the arbiter. Known risk: very close/dense setups
bottom out at flash level 1–2, where WS2812 output is coarse.

---

## v1 notes (historical)

## Status

| Piece | State |
|------|-------|
| Geometry: rectify + snap + rotate (`src/lib/autoLayout.ts`) | **DONE**, host-tested |
| Firmware calibration flash-mode (structured light) | **DONE**, HW-validated; now flashes at a tunable LOW brightness (see below) |
| App: camera capture → decode → points (`cameraDecode.ts`) | **DONE** — data-driven timing + per-pixel decode + cluster-by-code. Confirmed **25/25** on a dim recording |
| Adaptive auto-scan (`autoMap` in `cameraDecode.ts`) | **DONE** — closed loop: each pass reports diagnostics (clipping, out-of-range codes, mask size, motion); the loop adjusts flash brightness/sensitivity + coaches the user, up to ~30s, until all LEDs lock |
| Record raw capture + offline harness (`automation/decode-capture.mjs`) | **DONE** — `⏺ Record` downloads a `.bin`; harness replays the exact pipeline + ASCII placement |
| UI: scan, snap slider, rectify checkbox, rotate, preview, upload (`AutoLayoutModal.svelte`) | **DONE**, chain HW-validated |

### CV decode: what the first real recording taught us

Analyzing a recorded 5×5 capture (`automation/decode-capture.mjs`) found three problems and one
hard physical limit:

1. **Timing was assumed, not measured.** The device's real per-frame cadence differs from the
   nominal `frameMs` (BLE/loop overhead), and it holds the **ALL-OFF** frame ~4× longer than the
   others. A fixed-period phase-fold therefore put the dim high-bit planes onto OFF windows → no
   high-index LEDs decoded. Fix: recover timing from the data — find the long dark OFF intervals,
   then split each active region between them into `bits+1` equal sub-slots (`[ON][bit0..]`).
2. **Range-image blob detection can't separate a matrix.** When LEDs are close they read as one
   bright blob. Fix: decode **per pixel** (each pixel reads its own bit-code), then **cluster
   pixels by decoded index** — LEDs separate in code space even when merged in image space.
3. **Background/exposure pulsing** from the bright matrix — handled by per-frame histogram-median
   subtraction.
4. **Hard limit — over-exposure.** At full white the LEDs saturated the sensor (≈70% of strip
   pixels clipped at 255) and bloomed past their spacing, so an "off" LED's centre still read 255
   from a lit neighbour. The per-LED signal is *clipped away* — no algorithm recovers it. **Fix is
   to flash dim**: firmware now drives calibration at a low per-channel level (default 40,
   app-tunable via the "Flash brightness" slider) so LEDs stay distinct dots.

**Calibration BLE write** (`a0be83f7`): `[u8 cmd(1=start,0=stop)][u8 stripIndex(0xFF=all)][u8 brightness(0⇒default 40)][u8 mode(0=strobe,1=full; default 1)]`.

### Flash sequence & motion handling

- **No all-off frame.** Full sequence is `[ALL-ON][bit0]..[bit(bits-1)]` (cycle = 1+bits). The old
  `[OFF][ON][bits]` had a long dark frame that only made the camera re-expose (slow + dark flashing)
  with no decode benefit — the decoder derives each pixel's OFF level from the bit frames it's dark
  in, and finds LED 0 (dark in every bit) via its swing against ALL-ON. Timing anchors on the
  ALL-ON frames (lit-count peaks) instead of dark gaps.
- **Faster blink.** `CALIB_FRAME_MS` 220→120ms: shorter cycle ⇒ less motion smear per cycle (decode
  is timing-agnostic so it's safe), staying well above the camera frame interval.
- **Translation registration.** Each ALL-ON frame shows the full constellation, so its bright
  centroid moves with a handheld camera. We align every frame to the first ON's centroid (linearly
  interpolated for the bit frames between anchors) before folding — a moving capture then folds like
  a still one; no-op on a steady one. Verified: synthetic 32px drift + jitter still decodes 25/25.
  (Pure frame-differencing can't do this — a moving lit pattern differs at every edge; you must
  register. Rotation/zoom registration is the next step if translation isn't enough.)

### Adaptive auto-scan (`autoMap`) — two phases, ~60s budget (never merged; superseded by `autoScan.ts`)

**Phase 1 — exposure sweep (strobe).** The device STROBES all LEDs on/off; we sweep flash
brightness low→high (`[8,13,20,30,44,64,92,130]`), grab a short burst at each, and pick the
**dimmest level that's clearly detectable with the lowest bloom**. Bloom is measured by **fill
ratio** = lit area ÷ bounding box (`analyzeExposure`): well-exposed LEDs are distinct dots with
dark gaps (fill ~0.05–0.15); bloomed LEDs merge into a solid blob (fill ~0.3+). Validated on real
captures: the decodable one was 0.06, the bloomed one 0.34. This is a genuine two-directional
search for the sweet spot — not a one-way nudge — and clipping alone (the old test) misses bloom
entirely, which is why it used to lock on bloomed data.

**Phase 2 — decode + refine.** With brightness locked, the device runs the full structured-light
sequence (`mode=full`). Each pass `captureAndDecode` returns a `DecodeDiag` (LEDs found, mask px,
max swing, **clipping %**, **out-of-range code %**, **motion px**, cycles used). `planAdjustment`
reads it and picks the next move:

| Symptom | Signal | Action |
|---|---|---|
| Bloom / over-exposed | clipped > 30% or out-of-range codes > 12% | flash dimmer (×0.55) |
| Too dim / not flashing | max swing < 45 or "nothing blinking" | flash brighter (×1.7) |
| Strip too small | mask px < 120 | coach "move closer", bump resolution |
| Camera moving | motion > 3.5px between cycles | coach "hold still" |
| Exposure fine, incomplete | found < numLeds | raise sensitivity, then resolution |

It keeps going (re-flashing only when brightness changes) up to ~30s, returns the best attempt, and
reflects the converged brightness back to the slider. Verified against recorded footage: the dim
capture returns solid on pass 1; the over-exposed one is correctly flagged (clipped 51%, out-of-range
21%) and would be dimmed into range.

## Geometry core (done, host-validated) — `src/lib/autoLayout.ts`

Given `pts[ledIndex] = {x,y}` (one position per LED, from the camera), produces a ledmap:

- **`rectifyPoints(pts)`** — the **rectify checkbox**. Finds the cloud's 4 extreme corners and
  computes the homography that maps them to the unit square, removing oblique-camera
  perspective *even if you never shot it head-on*. Assumes the display outline is a rectangle
  — so it's opt-in (a genuinely non-rectangular display should leave it off). Verified: a
  perspective-warped 10×10 recovers to a clean grid.
- **`buildLedmap(pts, snap, maxDim)`** — the **snap slider** (0..1). At **snap ≥ 0.5** it
  **fits a lattice**: recovers the grid's two basis vectors from nearest-neighbour displacements,
  refines the whole lattice by least squares, and snaps each point to its nearest node. This
  recovers the true N×M even under camera **rotation / perspective / mild shear** (where the old
  median-spacing rounding produced wrong dims like 5×7 and scrambled cells). Handedness is fixed
  so it can only ever be off by a rotation (never an un-fixable mirror), and it auto-orients so
  LED 0 sits top-left. Falls back to the fine-grid path below if the points aren't grid-like.
  The legacy **cell-size** path (snap < 0.5) preserves arbitrary spacing: cell = natural spacing ×
  (snap + (1−snap)·¼):
  - **snap = 1** → lattice fit ≈ the intended N×M; slightly-off pixels snap into place
    (the jittered curtain → ~10×10, every LED placed). Collisions spiral to the nearest free
    cell so no LED is dropped.
  - **snap = 0** → fine grid that **preserves real spacing** — offset pixels land in their own
    cells, with gaps between (the "imaginary points / arbitrary spacing" case). Verified:
    same cloud → 12×12 at snap 1 vs 43×43 at snap 0.
- **`rotateLedmap(map, quarterTurns)`** — see rotation below.

## Rotation

Geometry can't tell which way is "up" (the camera sees the display at some angle; rectify
fixes *perspective*, not the 4-way orientation, and the display might genuinely be portrait or
landscape). So: build the map in the rectified frame's natural orientation, **show it in the
LayoutPreview, and offer rotate-90° / flip buttons** that apply `rotateLedmap` until it looks
right. The user confirms visually before upload. (This also gives hand-made maps free rotate.)

## The red/green preview (already built)

`LayoutPreview.svelte` renders any `{width,height,map}` as a grid — green = LED, red = gap.
The auto-layout UI shows it live as you drag the snap slider / toggle rectify / rotate, so you
can see immediately whether the result is right before sending it to the device.

## Camera pipeline (TODO) — producing `pts`

Robust to a hand-held (slightly moving) camera:
1. **Firmware calibration mode** (BLE command): every LED continuously blinks its index as a
   Manchester/Gray-coded temporal ID, all in lockstep on a clock the app locks to. Plus an
   all-on and all-off reference frame.
2. **Capture** a burst (many frames) via Capacitor Camera / `<video>`+canvas.
3. **Detect**: background-subtract (all-off frame), threshold → bright blobs; track blobs
   across adjacent frames (small motion) by nearest-neighbour / optical flow.
4. **Decode**: each tracked blob's on/off across frames = its LED index (Manchester is
   self-clocking → tolerates shake). Require N consistent decodes.
5. **Coalesce motion**: each LED has many positions from moved frames → estimate a homography
   per frame to a reference (RANSAC on co-visible LEDs), warp all into the reference, average →
   one robust `pts[ledIndex]`.
6. Feed `pts` → `rectifyPoints` (if checkbox) → `buildLedmap(snap)` → preview → `rotateLedmap`
   → `uploadStripLayout`.

The CV (3–5) needs the camera + real LEDs to tune thresholds/exposure/decode, so it's the
hardware-gated next pass. Full 3D **structure-from-motion** (for genuinely non-planar, 3D
sculptures) is a later mode — for the common flat install, the homography rectify above *is*
the correct plane-aware solution (SfM is degenerate on a plane).
