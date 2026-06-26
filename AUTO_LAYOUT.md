# Camera auto-layout

Point the phone at the running LEDs, they flash a coded sequence, and we recover a WLED
ledmap automatically. Branch `feat/auto-layout` (off `feat/arbitrary-layouts`).

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

**Calibration BLE write** (`a0be83f7`): `[u8 cmd(1=start,0=stop)][u8 stripIndex(0xFF=all)][u8 brightness(0⇒default 40)]`.

### Adaptive auto-scan (`autoMap`) — two phases, ~60s budget

**Phase 1 — exposure lock (fast).** The device STROBES all LEDs on/off (`mode=strobe`, a 2-frame
cycle). We grab a ~1.3s burst and re-evaluate after each strobe (`analyzeExposure`: swing, clipping,
mask size) — no decode needed to know if we're over/under-exposed — nudging brightness until the
LEDs are crisp dots. Converges in a few short iterations instead of full-cycle captures.

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
