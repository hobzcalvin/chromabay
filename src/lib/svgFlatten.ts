// SVG path → flattened polygon contours → compact encoded string for SvgFillOperator.
// The DEVICE never parses SVG; it only scanline-fills these contours. Flattening (bezier/
// arc → line segments), decimation, and bbox-normalisation all happen here so preview and
// firmware fill identical geometry. Encoded format (see SvgFillOperator.h decode()):
//   "1|<count>:x0,y0,x1,y1,...;<count>:...;"  ints in ~[-500,500] (÷1000 → [-0.5,0.5]).

export type Pt = { x: number; y: number };
type Contour = Pt[];

const BEZIER_STEPS = 16; // per curve segment; decimation trims the flat parts afterward

// --- tokenizer: split a `d` string into [command, ...numbers] groups ---
function tokenize(d: string): Array<{ cmd: string; args: number[] }> {
  const out: Array<{ cmd: string; args: number[] }> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let m: RegExpExecArray | null;
  let cur: { cmd: string; args: number[] } | null = null;
  while ((m = re.exec(d))) {
    if (m[1]) { cur = { cmd: m[1], args: [] }; out.push(cur); }
    else if (cur) cur.args.push(parseFloat(m[2]));
  }
  return out;
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, into: Contour) {
  for (let i = 1; i <= BEZIER_STEPS; i++) {
    const t = i / BEZIER_STEPS, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    into.push({ x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y });
  }
}
function quad(p0: Pt, p1: Pt, p2: Pt, into: Contour) {
  for (let i = 1; i <= BEZIER_STEPS; i++) {
    const t = i / BEZIER_STEPS, u = 1 - t;
    into.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
}
// Endpoint-parameterised arc → cubic beziers (SVG spec appendix), then flatten.
function arc(p0: Pt, rx: number, ry: number, phi: number, laf: number, sf: number, p: Pt, into: Contour) {
  if (rx === 0 || ry === 0) { into.push(p); return; }
  const rad = (phi * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (p0.x - p.x) / 2, dy = (p0.y - p.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = laf === sf ? -1 : 1;
  let co = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1);
  co = sign * Math.sqrt(Math.max(0, co));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0.x + p.x) / 2, cy = sin * cxp + cos * cyp + (p0.y + p.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dTheta = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sf && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sf && dTheta < 0) dTheta += 2 * Math.PI;
  const segs = Math.max(2, Math.ceil(Math.abs(dTheta) / (Math.PI / 8)));
  for (let i = 1; i <= segs; i++) {
    const t = theta + (dTheta * i) / segs;
    const px = cos * rx * Math.cos(t) - sin * ry * Math.sin(t) + cx;
    const py = sin * rx * Math.cos(t) + cos * ry * Math.sin(t) + cy;
    into.push({ x: px, y: py });
  }
}

/** Parse an SVG path `d` into flattened contours (line-segment point lists). */
export function parsePath(d: string): Contour[] {
  const toks = tokenize(d);
  const contours: Contour[] = [];
  let cur: Contour = [];
  let x = 0, y = 0, sx = 0, sy = 0;      // current + subpath start
  let pcx = 0, pcy = 0, prevCmd = '';    // last control point (for S/T reflection)
  const push = () => { if (cur.length > 1) contours.push(cur); };
  for (const { cmd, args } of toks) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    let i = 0;
    const ax = () => (rel ? x : 0), ay = () => (rel ? y : 0);
    if (up === 'M') {
      push(); cur = [];
      x = args[0] + ax(); y = args[1] + ay(); sx = x; sy = y; cur.push({ x, y }); i = 2;
      while (i + 1 < args.length) { x = args[i] + (rel ? x : 0); y = args[i + 1] + (rel ? y : 0); cur.push({ x, y }); i += 2; }
    } else if (up === 'L') {
      while (i + 1 < args.length) { x = args[i] + (rel ? x : 0); y = args[i + 1] + (rel ? y : 0); cur.push({ x, y }); i += 2; }
    } else if (up === 'H') {
      while (i < args.length) { x = args[i] + (rel ? x : 0); cur.push({ x, y }); i++; }
    } else if (up === 'V') {
      while (i < args.length) { y = args[i] + (rel ? y : 0); cur.push({ x, y }); i++; }
    } else if (up === 'C') {
      while (i + 5 < args.length) {
        const p1 = { x: args[i] + ax(), y: args[i + 1] + ay() }, p2 = { x: args[i + 2] + ax(), y: args[i + 3] + ay() }, p3 = { x: args[i + 4] + ax(), y: args[i + 5] + ay() };
        cubic({ x, y }, p1, p2, p3, cur); pcx = p2.x; pcy = p2.y; x = p3.x; y = p3.y; i += 6;
      }
    } else if (up === 'S') {
      while (i + 3 < args.length) {
        const refl = (prevCmd === 'C' || prevCmd === 'S') ? { x: 2 * x - pcx, y: 2 * y - pcy } : { x, y };
        const p2 = { x: args[i] + ax(), y: args[i + 1] + ay() }, p3 = { x: args[i + 2] + ax(), y: args[i + 3] + ay() };
        cubic({ x, y }, refl, p2, p3, cur); pcx = p2.x; pcy = p2.y; x = p3.x; y = p3.y; i += 4;
      }
    } else if (up === 'Q') {
      while (i + 3 < args.length) {
        const p1 = { x: args[i] + ax(), y: args[i + 1] + ay() }, p2 = { x: args[i + 2] + ax(), y: args[i + 3] + ay() };
        quad({ x, y }, p1, p2, cur); pcx = p1.x; pcy = p1.y; x = p2.x; y = p2.y; i += 4;
      }
    } else if (up === 'T') {
      while (i + 1 < args.length) {
        const refl = (prevCmd === 'Q' || prevCmd === 'T') ? { x: 2 * x - pcx, y: 2 * y - pcy } : { x, y };
        const p2 = { x: args[i] + ax(), y: args[i + 1] + ay() };
        quad({ x, y }, refl, p2, cur); pcx = refl.x; pcy = refl.y; x = p2.x; y = p2.y; i += 2;
      }
    } else if (up === 'A') {
      while (i + 6 < args.length) {
        const p = { x: args[i + 5] + ax(), y: args[i + 6] + ay() };
        arc({ x, y }, args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], p, cur);
        x = p.x; y = p.y; i += 7;
      }
    } else if (up === 'Z') {
      // The operator closes each contour implicitly (wraps last→first), so don't add a
      // duplicate closing vertex — it would give RDP a degenerate baseline. Just restore pen.
      x = sx; y = sy;
    }
    prevCmd = up;
  }
  push();
  return contours;
}

// Ramer–Douglas–Peucker decimation.
function rdp(pts: Contour, eps: number): Contour {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [a, b];
}

/** Normalise contours to bbox-centred [-500,500] ints and encode. `budget` caps total points. */
export function encodeContours(contours: Contour[], budget = 160): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const p of c) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (!isFinite(minX)) return '1|';
  const w = maxX - minX || 1, h = maxY - minY || 1, span = Math.max(w, h);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  // Drop any trailing point that coincides with the first (curves/Z return to start) so RDP
  // doesn't see a zero-length baseline and collapse the whole contour.
  const cleaned = contours.map((c) => {
    const out = c.slice();
    while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < span * 1e-3) out.pop();
    return out;
  });

  // Decimate with an epsilon that scales up until the total point budget is met.
  let eps = span * 0.004;
  let dec: Contour[] = [];
  for (let pass = 0; pass < 12; pass++) {
    dec = cleaned.map((c) => rdp(c, eps)).filter((c) => c.length >= 3);
    const total = dec.reduce((n, c) => n + c.length, 0);
    if (total <= budget) break;
    eps *= 1.5;
  }
  const parts = dec.map((c) => {
    const nums = c.map((p) => `${Math.round(((p.x - cx) / span) * 1000)},${Math.round(((p.y - cy) / span) * 1000)}`);
    return `${c.length}:${nums.join(',')}`;
  });
  return `1|${parts.join(';')}`;
}

/**
 * Pull a usable path out of whatever the user pasted. Accepts a full `<svg>`, a lone
 * `<path .../>`, an attribute soup, or a bare `d` string — grabs the FIRST `d="…"`/`d='…'`
 * it sees (negative lookbehind avoids matching `id=`, `data-d=`, `width=`, etc.) and falls
 * back to treating the whole input as the path when there's no `d=` at all.
 */
export function extractPathData(input: string): string {
  const m = input.match(/(?<![\w-])d\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (m) return (m[1] ?? m[2] ?? '').trim();
  return input.trim();
}

/** Convenience: pasted SVG/path text → encoded blob for the SvgFill `path` param. */
export function flattenSvgPath(input: string, budget = 160): string {
  return encodeContours(parsePath(extractPathData(input)), budget);
}

// Preset shapes (viewBox-agnostic; encoder normalises). Heart matches SvgFillOperator kHeart.
export const PRESETS: Record<string, string> = {
  heart: 'M0,60 C-24,36 -60,20 -60,-20 C-60,-46 -40,-52 -24,-52 C-9,-52 -3,-40 0,-30 C3,-40 9,-52 24,-52 C40,-52 60,-46 60,-20 C60,20 24,36 0,60 Z',
  star: 'M0,-50 L14.7,-15.5 L47.6,-15.5 L21.4,6 L30.9,40.5 L0,20 L-30.9,40.5 L-21.4,6 L-47.6,-15.5 L-14.7,-15.5 Z',
  circle: 'M50,0 C77.6,0 100,22.4 100,50 C100,77.6 77.6,100 50,100 C22.4,100 0,77.6 0,50 C0,22.4 22.4,0 50,0 Z',
  triangle: 'M0,-50 L50,45 L-50,45 Z',
  ring: 'M50,0 A50,50 0 1,0 50.01,0 Z M50,25 A25,25 0 1,1 49.99,25 Z',
};
