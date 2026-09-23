# Filled-SVG operator (and folding in Symbol)

**Idea:** an operator that renders a **filled** vector shape from an SVG path. The user pastes a
full `d` string (or picks a preset); the **app flattens it in the browser** to simple polygons; the
device just **scanline-fills** those polygons, with automatable transform. This can **replace the
existing `Symbol` operator** — Symbol's glyphs are just filled shapes, so they become preset paths.

## Why the app does the SVG (the key move)
Don't parse SVG on the chip. The browser parses *any* path natively (`Path2D`, or an
`SVGPathElement` + `getTotalLength()`/`getPointAtLength()`) — every command including arcs, for free.
So:

- **App:** `d` string → flatten to **contours** (point lists) in a normalized space, decimate to a
  point budget (Douglas–Peucker), tag the **winding rule** (nonzero / even-odd, for holes).
- **Device + WASM operator:** receive the flattened contours and **scanline-fill + transform** them.
  No SVG grammar, no bezier/arc math on-device — tiny, and identical in preview and firmware.

The device only ever knows "filled polygons." Preview and device fill the **same** flattened blob,
so they match.

## What fill needs (device)
Scanline polygon fill: per row, find edge crossings across all subpaths, sort, fill spans by the
winding rule (so counters/holes work). ~150–250 lines of shared C++, **threshold not AA** (crisp LED
look), cheap at 40×40 even per frame. More than stroke, but bounded.

## Data model
- The SVG `d` is **app-only input** (editing + preview). The transmitted thing is the flattened
  polygon blob — too big for a 31-char string param, so it rides **in the pattern as a geometry blob**
  (msgpack array/bin), parsed into the node like params. Reuses the arbitrary-layouts chunking /
  per-node-data patterns, not the string-param path.
- User-facing params stay small floats: **rotation, scale, offset, hue, saturation, fill rule** — all
  of which drop into the **automation system** (spin / scale-pulse / draw the shape moving).

## Folding in Symbol
`Symbol` today = ~12 procedural glyphs via `inside(u,v)` implicit functions, supersampled + threshold,
with an optional cycle-through-glyphs. Those glyphs are just filled shapes, so:

- Ship them as a **preset library of `d` strings** and give the SVG operator a **preset picker**
  (SELECT) that populates the path, plus a custom-paste field.
- Preserve Symbol's "cycle glyphs" as a preset-cycle option.
- **Retire** the hand-written procedural glyph C++ in favor of path data (one renderer, arbitrary
  shapes). Net simplification + a big capability jump (any icon/logo, not just the built-ins).

Migration: convert the existing Symbol glyphs to `d` strings (once), keep the names as presets so old
patterns can map over.

## Gotchas
- **Point budget / decimation** — cap complexity so it fits the pattern payload and fills fast; app enforces.
- **Winding rule** — carry even-odd vs nonzero from the source (default nonzero) so holes render right.
- **Consistency** — flatten once in the app; both renderers use that blob (never re-flatten on device).
- **Geometry-per-node storage** is new (layouts are per-strip); it travels in the serialized pattern
  and is parsed into the PatternNode alongside params.
- **Self-intersecting / giant paths** — cap + decimate; reject absurd inputs.

## Simpler alternative (rejected for the main use)
The app could rasterize the filled path to a small **bitmap mask** and ship that — trivial on-device,
but rotating/scaling a pre-rasterized bitmap looks bad, so you lose crisp device-side animation. Since
the appeal is *animatable* vector art (pairs with automation), go polygon-fill on-device; keep bitmap
as a possible fast-path for purely-static shapes.

## Effort / phasing
Medium–large (bigger than Text). App-does-the-SVG removes the scary part (on-device SVG parsing).
1. Flatten-in-app (`d` → contours + winding + decimate) and preview.
2. Geometry blob in the pattern + device/WASM parse into the node.
3. Scanline-fill operator with rotate/scale/offset/color (automatable).
4. Preset library + picker → **retire Symbol**, map its glyphs to presets.
