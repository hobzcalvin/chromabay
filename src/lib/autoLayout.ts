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

// Fit a 2D lattice (grid) to a point cloud and assign each point integer (col,row).
// Robust to rotation, mild shear and perspective: recover the grid's two basis vectors from
// nearest-neighbour displacements, then refine the whole lattice by least squares and snap each
// point to its nearest node. Returns null if the points don't look like a grid.
type LatticeCell = { i: number; c: number; r: number };
function fitLattice(real: { p: Pt; i: number }[], maxDim: number): { W: number; H: number; cells: LatticeCell[] } | null {
  const n = real.length;
  if (n < 4) return null;
  const P = real.map((e) => e.p);
  // natural cell size = median nearest-neighbour distance
  const nn: number[] = [];
  for (let a = 0; a < n; a++) { let b = Infinity; for (let c = 0; c < n; c++) if (a !== c) { const d = Math.hypot(P[a].x - P[c].x, P[a].y - P[c].y); if (d < b) b = d; } nn.push(b); }
  const cell = [...nn].sort((x, y) => x - y)[n >> 1] || 1;
  // short inter-point displacements, angle folded to [0,π)
  const disps: { dx: number; dy: number; m: number; ang: number }[] = [];
  for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
    if (a === c) continue;
    const dx = P[c].x - P[a].x, dy = P[c].y - P[a].y, m = Math.hypot(dx, dy);
    if (m > 1.7 * cell || m < 0.3 * cell) continue;
    let ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI;
    disps.push({ dx, dy, m, ang });
  }
  if (disps.length < n) return null;
  // dominant axis from an angle histogram; second axis ⟂ to it
  const B = 36, hist = new Float64Array(B);
  for (const d of disps) hist[Math.min(B - 1, Math.floor((d.ang / Math.PI) * B))]++;
  let a1b = 0; for (let k = 0; k < B; k++) if (hist[k] > hist[a1b]) a1b = k;
  const a1 = ((a1b + 0.5) / B) * Math.PI, a2 = a1 + Math.PI / 2;
  const lenAlong = (ang: number) => {
    const tol = (22 * Math.PI) / 180, ls: number[] = [];
    for (const d of disps) { const da = Math.abs((((d.ang - ang + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI - Math.PI / 2); if (da < tol) ls.push(d.m); }
    ls.sort((x, y) => x - y); return ls.length ? ls[ls.length >> 1] : cell;
  };
  let v1 = { x: Math.cos(a1) * lenAlong(a1), y: Math.sin(a1) * lenAlong(a1) };
  let v2 = { x: Math.cos(a2) * lenAlong(((a2 % Math.PI) + Math.PI) % Math.PI), y: Math.sin(a2) * lenAlong(((a2 % Math.PI) + Math.PI) % Math.PI) };
  if (v1.x * v2.y - v1.y * v2.x < 0) { const t = v1; v1 = v2; v2 = t; } // fix handedness → only rotations, never a mirror
  let ox = 0, oy = 0; for (const p of P) { ox += p.x; oy += p.y; } ox /= n; oy /= n;
  const assign = (v1: Pt, v2: Pt, ox: number, oy: number): LatticeCell[] => {
    const det = v1.x * v2.y - v1.y * v2.x || 1e-9;
    const ia = v2.y / det, ib = -v2.x / det, ic = -v1.y / det, id = v1.x / det;
    return real.map((e) => { const rx = e.p.x - ox, ry = e.p.y - oy; return { i: e.i, c: Math.round(ia * rx + ib * ry), r: Math.round(ic * rx + id * ry) }; });
  };
  let cells = assign(v1, v2, ox, oy);
  // least-squares refine: fit x = a·c + b·r + e, y = d·c + f·r + g from the current assignment,
  // then re-snap. Averages out noise/perspective; converges in a few iterations.
  const solve3 = (M: number[][], rhs: number[]): number[] => {
    const A = M.map((row, i) => [...row, rhs[i]]);
    for (let i = 0; i < 3; i++) {
      let pv = i; for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[pv][i])) pv = r;
      [A[i], A[pv]] = [A[pv], A[i]];
      for (let r = 0; r < 3; r++) { if (r === i) continue; const f = A[r][i] / (A[i][i] || 1e-9); for (let k = i; k < 4; k++) A[r][k] -= f * A[i][k]; }
    }
    return [A[0][3] / (A[0][0] || 1e-9), A[1][3] / (A[1][1] || 1e-9), A[2][3] / (A[2][2] || 1e-9)];
  };
  for (let it = 0; it < 4; it++) {
    let Scc = 0, Srr = 0, Scr = 0, Sc = 0, Sr = 0, Sux = 0, Srx = 0, Sx = 0, Suy = 0, Sry = 0, Sy = 0;
    for (let k = 0; k < n; k++) { const c = cells[k], p = P[k]; Scc += c.c * c.c; Srr += c.r * c.r; Scr += c.c * c.r; Sc += c.c; Sr += c.r; Sux += c.c * p.x; Srx += c.r * p.x; Sx += p.x; Suy += c.c * p.y; Sry += c.r * p.y; Sy += p.y; }
    const M = [[Scc, Scr, Sc], [Scr, Srr, Sr], [Sc, Sr, n]];
    const [a, b, e] = solve3(M, [Sux, Srx, Sx]);
    const [d, f, g] = solve3(M, [Suy, Sry, Sy]);
    v1 = { x: a, y: d }; v2 = { x: b, y: f }; ox = e; oy = g;
    cells = assign(v1, v2, ox, oy);
  }
  let minc = 1e9, minr = 1e9, maxc = -1e9, maxr = -1e9;
  for (const c of cells) { minc = Math.min(minc, c.c); minr = Math.min(minr, c.r); maxc = Math.max(maxc, c.c); maxr = Math.max(maxr, c.r); }
  const W = maxc - minc + 1, H = maxr - minr + 1;
  for (const c of cells) { c.c -= minc; c.r -= minr; }
  // sanity: a real grid is reasonably tight (no runaway dimension from a bad fit)
  if (W < 1 || H < 1 || W > maxDim || H > maxDim || W > n || H > n || W * H > n * 4) return null;
  return { W, H, cells };
}

// Orient the grid to MATCH THE CAMERA VIEW: rotate the (c,r) assignment in 90° steps so column
// index increases with image x (rightward) and row index with image y (downward) — i.e. the
// ledmap looks like what the camera saw. We use the known image positions, not the LED wiring
// order, so an LED isn't forced to a corner; the user's Rotate buttons handle any residual.
// `pos[k]` is the image position of `cells[k]`. Only 90° rotations (never a mirror).
function orientToImage(cells: LatticeCell[], W: number, H: number, pos: Pt[]): { W: number; H: number; cells: LatticeCell[] } {
  let best: { W: number; H: number; cells: LatticeCell[]; score: number } | null = null;
  let cur = cells, cw = W, ch = H;
  const nn = cells.length;
  for (let t = 0; t < 4; t++) {
    let mc = 0, mr = 0, mx = 0, my = 0;
    for (let k = 0; k < nn; k++) { mc += cur[k].c; mr += cur[k].r; mx += pos[k].x; my += pos[k].y; }
    mc /= nn; mr /= nn; mx /= nn; my /= nn;
    let covcx = 0, covry = 0;
    for (let k = 0; k < nn; k++) { covcx += (cur[k].c - mc) * (pos[k].x - mx); covry += (cur[k].r - mr) * (pos[k].y - my); }
    const score = covcx + covry; // maximized when c↑ with x and r↑ with y
    if (!best || score > best.score) best = { W: cw, H: ch, cells: cur.map((c) => ({ ...c })), score };
    cur = cur.map((c) => ({ i: c.i, c: ch - 1 - c.r, r: c.c })); // rotate 90° cw
    [cw, ch] = [ch, cw];
  }
  return { W: best!.W, H: best!.H, cells: best!.cells };
}

// Drop any row/column that contains no LED at all. An all-blank row or column carries no
// information — removing it keeps every real LED's relative arrangement and just tightens the
// grid (no useless spacing between LEDs). Partial rows (some LEDs + some real gaps) are kept.
function compactLedmap(l: Ledmap): Ledmap {
  const { width: W, height: H, map } = l;
  if (W < 1 || H < 1) return l;
  const rowUsed = new Array(H).fill(false), colUsed = new Array(W).fill(false);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (map[r * W + c] >= 0) { rowUsed[r] = true; colUsed[c] = true; }
  const rows: number[] = [], cols: number[] = [];
  for (let r = 0; r < H; r++) if (rowUsed[r]) rows.push(r);
  for (let c = 0; c < W; c++) if (colUsed[c]) cols.push(c);
  if (rows.length === H && cols.length === W) return l;
  const nW = cols.length, nH = rows.length, nm = new Array(nW * nH).fill(-1);
  for (let nr = 0; nr < nH; nr++) for (let nc = 0; nc < nW; nc++) nm[nr * nW + nc] = map[rows[nr] * W + cols[nc]];
  return { width: nW, height: nH, map: nm };
}

/**
 * Quantize LED positions to a WLED ledmap.
 * @param pts     pts[ledIndex] = position (any units; normalized internally)
 * @param snap    0..1. ≥0.5 → fit a grid lattice (recovers the intended N×M even under
 *                rotation/perspective); <0.5 → fine grid preserving real spacing (gaps appear).
 * @param maxDim  cap on either grid dimension.
 */
export function buildLedmap(pts: (Pt | null)[], snap = 1, maxDim = 64): Ledmap {
  // Only place LEDs we actually have a position for; null entries (undecoded) stay gaps.
  const real = pts.map((p, i) => ({ p, i })).filter((e): e is { p: Pt; i: number } => !!e.p);
  if (real.length === 0) return { width: 0, height: 0, map: [] };
  if (real.length === 1) return { width: 1, height: 1, map: [real[0].i] };

  // Force-grid (high snap): fit a lattice. This is the robust path for matrices/curtains.
  if (snap >= 0.5) {
    const fit = fitLattice(real, maxDim);
    if (fit) {
      const { W, H, cells } = orientToImage(fit.cells, fit.W, fit.H, real.map((e) => e.p));
      const map = new Array(W * H).fill(-1);
      for (const c of cells) {
        let cellIdx = c.r * W + c.c;
        if (map[cellIdx] >= 0) { // rare collision → nearest free cell
          for (let rad = 1; rad < Math.max(W, H); rad++) { let done = false;
            for (let dy = -rad; dy <= rad && !done; dy++) for (let dx = -rad; dx <= rad && !done; dx++) {
              const nc = c.c + dx, nr = c.r + dy; if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
              if (map[nr * W + nc] < 0) { cellIdx = nr * W + nc; done = true; }
            }
            if (done) break;
          }
        }
        map[cellIdx] = c.i;
      }
      return compactLedmap({ width: W, height: H, map });
    }
    // lattice fit failed (not grid-like) → fall through to the fine-grid path
  }

  // Fine-grid path: quantize to a grid whose cell size scales with snap, preserving real spacing.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { p } of real) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const spacing = Math.max(medianSpacing(real.map((e) => e.p)), 1e-6);

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
  return compactLedmap({ width: W, height: H, map });
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
