# Camera auto-layout

Point the phone at the running LEDs, they flash a coded sequence, and we recover a WLED
ledmap automatically. Branch `feat/auto-layout` (off `feat/arbitrary-layouts`).

## Status

| Piece | State |
|------|-------|
| Geometry: rectify + snap + rotate (`src/lib/autoLayout.ts`) | **DONE**, host-tested |
| Firmware calibration flash-mode (structured light) | **DONE**, HW-validated; now flashes at a tunable LOW brightness (see below) |
| App: camera capture → decode → points (`cameraDecode.ts`) | **REDESIGNED** from recorded footage — data-driven timing + per-pixel decode + cluster-by-code. Needs a re-record with dim LEDs to confirm 25/25 |
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

Remaining step: re-record with dim LEDs and confirm a clean 25/25 raster, then the chain is done.

## Geometry core (done, host-validated) — `src/lib/autoLayout.ts`

Given `pts[ledIndex] = {x,y}` (one position per LED, from the camera), produces a ledmap:

- **`rectifyPoints(pts)`** — the **rectify checkbox**. Finds the cloud's 4 extreme corners and
  computes the homography that maps them to the unit square, removing oblique-camera
  perspective *even if you never shot it head-on*. Assumes the display outline is a rectangle
  — so it's opt-in (a genuinely non-rectangular display should leave it off). Verified: a
  perspective-warped 10×10 recovers to a clean grid.
- **`buildLedmap(pts, snap, maxDim)`** — the **snap slider** (0..1). Quantizes positions to a
  grid; cell size = natural pixel spacing × (snap + (1−snap)·¼):
  - **snap = 1** → coarsest grid ≈ the intended N×M; slightly-off pixels snap into place
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
