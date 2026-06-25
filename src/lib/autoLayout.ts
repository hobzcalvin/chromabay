// Auto-layout geometry: turn a cloud of detected LED positions (one (x,y) per LED index,
// in image/plane coordinates) into a WLED ledmap {width,height,map}. This is the part the
// camera pipeline feeds; it's pure + deterministic so it's unit-tested with synthetic data.
//
//  - rectifyPoints():  perspective-correct an obliquely-viewed (but coplanar) set, assuming
//                      the display outline is a rectangle. Optional (the "rectify" checkbox).
//  - buildLedmap():    quantize positions to a grid. `snap` (0..1) tunes grid coarseness:
//                      1 = force into the smallest grid that fits the structure (a slightly
//                      off pixel gets pulled into place — e.g. a jittered curtain → clean
//                      10×10); 0 = a fine grid that preserves real spacing (offsets land in
//                      their own cells, gaps appear). In between scales the resolution.
//  - rotateLedmap():   rotate a finished ledmap by 90° steps (orientation isn't recoverable
//                      from geometry alone; the user/UI picks which way is up).

export type Pt = { x: number; y: number };
export type Ledmap = { width: number; height: number; map: number[] };

// ---- rectify (perspective) ---------------------------------------------------------------

// Pick the 4 extreme corners of a point cloud (works for an arbitrarily rotated quad):
// TL=min(x+y), BR=max(x+y), TR=max(x−y), BL=min(x−y).
function quadCorners(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  let tl = pts[0], br = pts[0], tr = pts[0], bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

// Solve the 3x3 homography mapping src[0..3] -> dst[0..3] (DLT, 8x8 Gaussian elimination).
function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((bi, i) => bi / (A[i][i] || 1e-12));
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function applyH(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

// Warp the cloud so its bounding quad becomes the unit square — removes the oblique-camera
// perspective. Use only when the real display outline is rectangular.
export function rectifyPoints(pts: (Pt | null)[]): (Pt | null)[] {
  const real = pts.filter((p): p is Pt => !!p);
  if (real.length < 4) return pts.slice();
  const [tl, tr, br, bl] = quadCorners(real);
  const h = homography([tl, tr, br, bl], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  return pts.map((p) => (p ? applyH(h, p) : null)); // keep index alignment; gaps stay gaps
}

// ---- grid quantization (snapping) --------------------------------------------------------

// Median nearest-neighbour distance — the natural pixel spacing of the cloud.
function medianSpacing(pts: Pt[]): number {
  const d: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      const s = Math.hypot(dx, dy);
      if (s < best) best = s;
    }
    if (best < Infinity) d.push(best);
  }
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 1;
}

/**
 * Quantize LED positions to a WLED ledmap.
 * @param pts     pts[ledIndex] = position (any units; normalized internally)
 * @param snap    0..1. 1 → coarsest grid (~the intended NxM, off-pixels snapped in);
 *                0 → fine grid preserving real spacing (gaps between offset pixels).
 * @param maxDim  cap on either grid dimension.
 */
export function buildLedmap(pts: (Pt | null)[], snap = 1, maxDim = 64): Ledmap {
  // Only place LEDs we actually have a position for; null entries (undecoded) stay gaps.
  const real = pts.map((p, i) => ({ p, i })).filter((e): e is { p: Pt; i: number } => !!e.p);
  if (real.length === 0) return { width: 0, height: 0, map: [] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { p } of real) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const spacing = Math.max(medianSpacing(real.map((e) => e.p)), 1e-6);

  // At snap=1 the cell is the natural spacing → grid ≈ the intended row/col count. As snap
  // drops, cells shrink (finer grid) so genuine position offsets occupy distinct cells.
  const s = Math.min(1, Math.max(0, snap));
  const cell = spacing * (s + (1 - s) * 0.25); // 1× spacing at snap=1, ¼× at snap=0
  let W = Math.round(spanX / cell) + 1;
  let H = Math.round(spanY / cell) + 1;
  W = Math.min(maxDim, Math.max(1, W));
  H = Math.min(maxDim, Math.max(1, H));

  const map = new Array(W * H).fill(-1);
  const occupied = (c: number) => map[c] >= 0;
  for (const { p, i } of real) {
    let col = W <= 1 ? 0 : Math.round(((p.x - minX) / spanX) * (W - 1));
    let row = H <= 1 ? 0 : Math.round(((p.y - minY) / spanY) * (H - 1));
    let cellIdx = row * W + col;
    // On collision (two LEDs rounded to the same cell — common at high snap), spiral out to
    // the nearest free cell so no LED is dropped.
    if (occupied(cellIdx)) {
      let placed = false;
      for (let r = 1; r < Math.max(W, H) && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            const nc = col + dx, nr = row + dy;
            if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
            const ci = nr * W + nc;
            if (!occupied(ci)) { cellIdx = ci; placed = true; }
          }
        }
      }
    }
    map[cellIdx] = i;
  }
  return { width: W, height: H, map };
}

// Rotate a finished ledmap by `quarterTurns` × 90° clockwise (1=90°, 2=180°, 3=270°).
export function rotateLedmap(l: Ledmap, quarterTurns: number): Ledmap {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (q === 0) return { ...l, map: l.map.slice() };
  const { width: W, height: H, map } = l;
  const nW = q === 2 ? W : H, nH = q === 2 ? H : W;
  const out = new Array(nW * nH).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nx: number, ny: number;
      if (q === 1) { nx = H - 1 - y; ny = x; }       // 90° cw
      else if (q === 2) { nx = W - 1 - x; ny = H - 1 - y; } // 180°
      else { nx = y; ny = W - 1 - x; }                // 270° cw
      out[ny * nW + nx] = map[y * W + x];
    }
  }
  return { width: nW, height: nH, map: out };
}
