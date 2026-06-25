# Arbitrary pixel layouts

Lets a strip's LEDs sit at **arbitrary physical positions** (rings, spirals, words,
scattered installs) instead of a regular grid. An operator pattern still renders into a 2D
image; each LED samples the image cell nearest its real-world position.

## Status

| Phase | What | State |
|------|------|-------|
| 1 | Device rendering core | **DONE** (build-verified; not hardware-tested) |
| 2a | Load layout from device flash | **DONE** |
| 2b | Upload a layout from the app (BLE) | designed below — not built |
| 2c | App settings UI (per strip) to pick/generate a layout | designed below — not built |
| 3 | Camera auto-layout (structured light) | designed below — needs hardware |

## Phase 1 — rendering core (implemented)

`LedBus` (`esp32/src/led_manager.h`) holds an optional layout:
- `setLayout(xs, ys, count)` — positions are `uint16` in *any* units; re-normalized to their
  bounding box. It picks a **virtual matrix** `W×H ≈ count` cells, aspect-matched and capped
  at `kLayoutMaxDim` (64), then precomputes, per LED, the buffer cell nearest its position
  (`_layoutSample[i] = row*W + col`). Sizing chosen so a regular grid maps 1:1 (0 waste) and
  scattered/ring layouts waste only ~30–40% of cells (validated host-side).
- `effectiveWidth()/Height()` return the virtual matrix when a layout is set.

`PatternRendererBase` (`esp32/src/pattern_renderer_base.cpp`):
- `getMatrixWidth()/Height()` size the shared canvas from `effectiveWidth()/Height()`, so the
  buffers are big enough for a layout's virtual matrix.
- `render()` renders the operator graph at the strip's effective size, then for a layout strip
  writes each LED from `patternBuffer[layoutSampleIndex(i)]` (instead of grid `xyToIndex`).

A strip with no layout behaves exactly as before.

## Phase 2a — on-device storage (implemented)

Per strip, file `/layout_<i>.bin` on LittleFS:

```
[u16 count] [ count × (u16 x, u16 y) ]      // little-endian
```

`ConfigManager::loadStripLayouts()` runs after `begin()` on every config apply: reads the file
(if present) and calls `setLayout`; absent file clears any layout (→ grid). Positions can be in
any units — they're re-normalized — so the app can send raw pixel coords or 0..65535.

## Phase 2b — upload from the app (BLE) — TODO

Add a characteristic (mirror the pattern-upload/OTA chunking in `main.cpp`):
1. App sends `stripIndex` + the `count`+positions blob (chunked; layouts for 1000 px ≈ 4 KB
   exceed one MTU).
2. Loop-task handler buffers chunks, writes `/layout_<i>.bin`, then re-applies config
   (`configMgr.loadStripLayouts()` or a full re-apply) so it takes effect live.
3. To clear: send `count = 0` → delete the file → `clearLayout()`.

App side (`src/lib/ble.ts`): `uploadStripLayout(deviceId, stripIndex, positions: {x,y}[])`
— pack the blob, chunk-write to the characteristic. JSON in / binary on the wire.

## Phase 2c — app settings UI (per strip) — TODO

In `LedConfiguration.svelte`, per strip: "Upload layout (JSON)" file input. JSON shape:
```json
{ "positions": [[x,y], [x,y], ...] }   // length == numLeds; any units
```
Parse → `uploadStripLayout`. Also offer built-in generators (ring, spiral, grid) and a
"Clear layout" button. Show the derived virtual-matrix size as feedback.

## Phase 3 — camera auto-layout (structured light) — TODO, needs hardware

Goal: point the phone camera at the lit strip, flash a coded sequence, recover each LED's
(x,y) in the image automatically.

**Binary structured light** (robust, ~`ceil(log2(N))` frames, not N):
1. Firmware "layout calibration mode": for bit `k` (0..⌈log2(N)⌉-1), light LED `i` at full
   white iff bit `k` of `i` is set; hold each frame ~150–250 ms. Also emit an all-on and an
   all-off reference frame. Drive this over BLE (a calibration command) synced to the app's
   capture, or free-run at a known cadence the app locks onto.
2. App: capture a frame per bit (Capacitor Camera / a `<video>` + canvas grab). Use the
   all-on frame to find candidate LED blobs (bright spots); the all-off frame for background
   subtraction.
3. For each blob centroid, read its on/off across the bit frames → that bit string **is** the
   LED index. Its centroid (x,y) → normalized position. Gray-code the indices to tolerate
   1-bit capture errors; require the all-on detection to gate a blob as real.
4. Build `{positions}` ordered by decoded index, upload via Phase 2b.

Practical notes: fixed exposure/focus during capture; ignore reflections via the all-off
subtraction + a brightness threshold; LEDs that never decode cleanly (occluded) get
interpolated from neighbors or dropped. A coarser fallback is one-LED-at-a-time (N frames) for
small strips, which is simpler but slow.

## Open questions for the user
- Per strip confirmed (each strip has its own `/layout_<i>.bin`).
- Should multi-strip installs share one coordinate space (one big canvas across strips) or stay
  independent (current: each strip samples its own normalized layout)? Independent is simpler;
  shared enables effects that span strips.
