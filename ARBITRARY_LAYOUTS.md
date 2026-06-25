# Arbitrary pixel layouts

Lets a strip's LEDs sit at **arbitrary physical positions** (rings, spirals, words,
scattered installs) instead of a regular grid. An operator pattern renders into a 2D image
and each grid cell drives the LED mapped to it — the **WLED ledmap model**, so existing
`ledmap.json` files work.

## Status

| Phase | What | State |
|------|------|-------|
| 1 | Device rendering core (WLED ledmap) | **DONE** (build-verified; not hardware-tested) |
| 2a | Load layout from device flash | **DONE** |
| 2b | Upload a layout from the app (BLE) | **DONE** |
| 2c | App settings UI (per strip) | **DONE** |
| 3 | Camera auto-layout (moving camera) | designed below — needs hardware |

## Model (WLED ledmap)

A layout is a `W×H` grid plus a `map`: `map[cell]` = the physical LED index that displays
that grid cell, or `-1` for a gap. Identical to WLED's
[ledmap.json](https://kno.wled.ge/advanced/mapping/). The operator graph renders at `W×H`;
`render()` walks the cells and lights each mapped LED.

**Multi-strip:** strips stay independent (each has its own ledmap), exactly like today. To
make two strips share one coordinate space, give them the **same `W×H`** and place each
strip's LEDs in the appropriate cells — both render the same pattern at the same resolution,
so the image is continuous across them. Mismatched sizes → independent, as before.

## Phase 1 — rendering core (implemented)

`LedBus` (`esp32/src/led_manager.h`): `setLayout(map, count, W, H)` stores the `W×H` map
(LED index per cell, `-1` gaps), capped at `kLayoutMaxDim` (256) per side; `effectiveWidth()/
Height()` return `W×H` when a layout is set. `PatternRendererBase` sizes the shared canvas
from the effective dims and, for a layout strip, lights `setPixelColor(map[cell], buffer[cell])`
per cell instead of the grid `xyToIndex`. No-layout strips are unchanged.

## Phase 2a — on-device storage (implemented)

Per strip, file `/layout_<i>.bin` on LittleFS:

```
[u16 W] [u16 H] [u16 count] [ count × i16 ledIndex ]      // little-endian; count == W*H
```

`ConfigManager::loadStripLayouts()` runs after `begin()` on every config apply; absent file
clears any layout (→ grid). Layouts (≤ a few KB) live in their own file, not the 4 KB-capped
main config.

## Phase 2b/2c — upload from the app (implemented)

`ble.ts uploadStripLayout(deviceId, stripIndex, {width,height,map})` packs the binary blob and
writes the layout characteristic; the device buffers it, writes `/layout_<i>.bin`, and
re-applies config so it takes effect live. `map: []` (empty) clears the layout. Settings UI
(`LedConfiguration.svelte`) per strip: paste/upload a **WLED ledmap.json** (`{width,height,map}`
or a bare `map` array with width/height), or **Clear layout**. JSON in, binary on the wire.

## Phase 3 — camera auto-layout, moving camera + plane fit (designed, needs hardware)

Goal: hold the phone (hand-shake OK, not perfectly face-on), the strip flashes a coded
sequence, and we recover each LED's position into a `W×H` ledmap.

**1. Identify each LED across frames (robust to motion).** Each LED continuously blinks its
own **temporal ID** — repeat its index as Manchester/Gray-coded bits over ~1–2 s, all LEDs in
lockstep on a clock the app can lock to (or BLE-synced). Capture a long burst (many frames).
Per frame: background-subtract (an all-off reference), threshold, find bright blobs. Track
blobs frame-to-frame by nearest-neighbour / optical flow (camera moves only a little between
adjacent frames). Accumulate each tracked blob's on/off → decode its LED index. Manchester
coding makes "on/off" self-clocking and motion-tolerant; require N consistent decodes per blob.

**2. Coalesce noisy positions.** Each LED now has many `(x,y)` samples from the frames where
it decoded, but the camera moved between them. Pick a reference frame (most LEDs visible /
sharpest). For every other frame, estimate a **homography** to the reference from the LEDs
co-visible in both (RANSAC to reject mis-tracks), warp that frame's samples into the reference,
then average per LED → one robust 2D point each. Outlier samples beyond a residual threshold
are dropped; LEDs never cleanly decoded are interpolated from neighbours or left as gaps.

**3. Off-axis / 3D (optional, nicer).** If the user can't face the strip, the reference frame
is oblique (perspective-distorted). Two options: (a) assume the LEDs are **coplanar** and
rectify — the inter-frame homographies + a frontal-ness prior let us pick the warp that makes
the layout most rectangular/uniform (minimize perspective foreshortening), giving a head-on
map; or (b) full **structure-from-motion** — triangulate 3D LED points from the tracked
correspondences across the moving views (bundle adjust), fit the best plane (PCA / least
squares) to the 3D points, and project onto it for a true face-on layout regardless of camera
angle. (b) is heavier but is the "point anywhere, we figure out the plane" experience.

**4. Quantize to ledmap.** Normalize the final 2D points to a bounding box, choose `W×H`
(≈ density, aspect-matched), snap each LED to its nearest cell (resolve collisions by nudging
to the nearest free cell), build the `map`, upload via 2b. Show a preview for confirmation.

Implementation surface: firmware "calibration mode" (BLE command → run the Manchester ID
flash loop at a known cadence); app camera capture (Capacitor Camera / `<video>`+canvas burst),
blob detection + tracking + decode + homography/SfM (OpenCV.js or a lean custom CV), preview,
upload. Needs the camera + real LEDs to tune thresholds/exposure — hence hardware-gated.
