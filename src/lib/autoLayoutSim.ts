// Synthetic camera for the auto-layout decoder: renders what a camera would capture of a ChromaBay
// running its calibration flash, under a configurable physical setup, and scores a decode against
// the known ground truth. Pure (no DOM) so it runs under Vitest and from automation/autolayout-sim.ts.
//
// What it models, because each of these has broken a real capture:
//  - the firmware's exact sequence ([ALL-ON][bit0..]), on a device clock that drifts and jitters
//    relative to the nominal CALIB_FRAME_MS and is not synchronised to the camera;
//  - camera frame timing jitter, dropped frames, exposure integration (a frame straddling a
//    pattern change sees a blend) and rolling shutter (rows are exposed at different times);
//  - optics: per-LED Gaussian spot + wide bloom halo, saturation at 255, sRGB-ish gamma;
//  - auto-exposure that chases the scene mean (pulses as the pattern changes);
//  - ambient light (uniform + gradient + static bright objects like a lamp), sensor noise;
//  - handheld camera motion, per-LED brightness variation, dead LEDs, perspective/rotation.
import type { Frame } from './cameraDecode';
import type { Ledmap, Pt } from './autoLayout';
import { seqLength, seqOn, type SeqKind } from './structuredLight';

export type SimLayout =
  | { kind: 'grid'; cols: number; rows: number; serpentine?: boolean }
  | { kind: 'strip'; n: number; shape: 'line' | 'zigzag' | 'spiral'; rowLen?: number }
  | { kind: 'points'; pts: Pt[] };

export type SimScenario = {
  name: string;
  seed?: number;                  // per-capture randomness (noise, timing, shake)
  installSeed?: number;           // the physical install (jitter, facing, brightness spread) — fixed across captures
  layout: SimLayout;
  imgW?: number; imgH?: number;   // processing-resolution frame size (default 320×180)
  coverage?: number;              // fraction of the image width the array spans (default 0.6)
  rotDeg?: number;                // in-plane camera roll
  tilt?: number;                  // perspective strength (0 = head-on, 0.3 = strongly oblique)
  spotFrac?: number;              // LED spot σ as a fraction of LED spacing in the image (default 0.12)
  minSpotPx?: number;             // optical blur floor σ in px (default 0.7)
  bloom?: number;                 // halo amplitude relative to the core (default 0.04)
  bloomRadius?: number;           // halo σ as a multiple of the core σ (default 5)
  ledLevel?: number;              // LED peak radiance (linear; 1 = saturates at gain 1). Default 0.6
  ledVar?: number;                // per-LED brightness variation, ± fraction (default 0.15)
  deadLeds?: number[];
  ambient?: number;               // uniform ambient radiance (linear, default 0.02 = dim room)
  ambientGradient?: number;       // left→right ambient ramp added on top
  lamps?: { x: number; y: number; r: number; level: number }[]; // static bright objects (image fractions)
  noise?: number;                 // sensor noise σ in 8-bit output units (default 2)
  autoExposure?: boolean;         // camera chases a target mean (default true)
  aeTarget?: number;              // target mean (linear, default 0.18)
  aeSpeed?: number;               // per-frame exponent (default 0.12)
  fps?: number;                   // camera rate (default 30)
  fpsJitterMs?: number;           // camera frame-time jitter (default 3)
  dropRate?: number;              // fraction of frames dropped (default 0.02)
  exposureMs?: number;            // integration time (default 16)
  rollingShutterMs?: number;      // top→bottom readout (default 20)
  frameMs?: number;               // firmware nominal CALIB_FRAME_MS (default 220)
  deviceClockScale?: number;      // real device frame period ÷ nominal (default 1.03)
  deviceJitterMs?: number;        // per-frame show() latency (default 8)
  shakePx?: number;               // handheld random-walk σ per frame, px (default 0)
  cycles?: number;                // flash cycles captured (default 5)
  seq?: SeqKind;                  // flash sequence the device runs (default 'legacy' = today's firmware)
  durationMs?: number;            // capture length override (default: `cycles` full cycles)
  // --- harsh conditions ---
  facingDeg?: number;             // each LED points up to this far off-axis: dimmer (cos³) + elongated spot
  ledVarLog?: number;             // log-normal brightness spread σ (0.9 ⇒ some LEDs ~10× dimmer)
  posJitter?: number;             // physical position noise, × pitch (wavy curtain, hand-placed lights)
  occludeFrac?: number;           // fraction of LEDs mostly hidden (5–30% of their light gets through)
  reflection?: { strength: number; mirrorY: number }; // mirrored, blurred copy about image row mirrorY (fraction of H)
  flickerHz?: number;             // ambient light flicker (100/120 Hz for mains lighting)
  flickerDepth?: number;          // 0..1
  pwmHz?: number;                 // LED PWM rate (WS2812 ≈ 400 Hz, WS2812B ≈ 1.2 kHz); free-running per LED
  pwmDuty?: number;               // PWM duty = flash brightness / 255 (default 40/255)
  offsetX?: number;               // shift the array sideways by this fraction of the frame (partly out of view)
  onlyLeds?: number[];            // targeted pass: only these LEDs flash (firmware calibration mask)
  anchorLeds?: number[];          // …plus these, at anchorScale × the pass's level
  anchorScale?: number;
};

export type SimResult = {
  frames: Frame[];
  numLeds: number;
  bits: number;
  truth: Pt[];                    // per-LED image position (px) at the capture's mean camera pose
  expected: Ledmap | null;        // the ledmap a perfect run should produce (grid layouts)
  spacingPx: number;              // median nearest-neighbour LED spacing in the image
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rnd: () => number) { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }

/** Physical LED positions (units = LED pitch) in index order, plus the ideal ledmap if gridded. */
export function layoutPositions(l: SimLayout): { pts: Pt[]; expected: Ledmap | null } {
  if (l.kind === 'points') return { pts: l.pts, expected: null };
  if (l.kind === 'grid') {
    const pts: Pt[] = []; const map = new Array(l.cols * l.rows).fill(-1);
    for (let r = 0; r < l.rows; r++) for (let k = 0; k < l.cols; k++) {
      const c = l.serpentine && r % 2 ? l.cols - 1 - k : k;
      map[r * l.cols + c] = pts.length; pts.push({ x: c, y: r });
    }
    return { pts, expected: { width: l.cols, height: l.rows, map } };
  }
  const pts: Pt[] = [];
  if (l.shape === 'line') for (let i = 0; i < l.n; i++) pts.push({ x: i, y: 0 });
  else if (l.shape === 'zigzag') { const rl = l.rowLen ?? Math.ceil(Math.sqrt(l.n)); for (let i = 0; i < l.n; i++) { const r = Math.floor(i / rl), k = i % rl; pts.push({ x: r % 2 ? rl - 1 - k : k, y: r }); } }
  else { let th = 0, rad = 1.5; for (let i = 0; i < l.n; i++) { pts.push({ x: rad * Math.cos(th), y: rad * Math.sin(th) }); th += 1 / rad; rad = 1.5 + (1.6 * th) / (2 * Math.PI); } } // Archimedean, ~1 pitch along the arm, 1.6 between turns
  if (l.kind === 'strip' && l.shape !== 'spiral') {
    const rl = l.shape === 'line' ? l.n : (l.rowLen ?? Math.ceil(Math.sqrt(l.n)));
    const rows = Math.ceil(l.n / rl); const map = new Array(rl * rows).fill(-1);
    pts.forEach((p, i) => { map[p.y * rl + p.x] = i; });
    return { pts, expected: { width: rl, height: rows, map } };
  }
  return { pts, expected: null };
}

export function simulateCapture(sc: SimScenario): SimResult {
  const rnd = mulberry32(sc.seed ?? 1);
  const irnd = mulberry32((sc.installSeed ?? 1) * 7919 + 13);   // same install every capture
  const W = sc.imgW ?? 320, H = sc.imgH ?? 180, N = W * H;
  const { pts: phys, expected } = layoutPositions(sc.layout);
  const n = phys.length, bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
  const frameMs = sc.frameMs ?? 220, devScale = sc.deviceClockScale ?? 1.03, devJit = sc.deviceJitterMs ?? 8;
  const seq: SeqKind = sc.seq ?? 'legacy';
  const cycleLen = seqLength(seq, bits), cycles = sc.cycles ?? (seq === 'legacy' ? 5 : 3);
  const durMs = sc.durationMs ?? (cycleLen + 1) * frameMs * cycles + frameMs;

  // Physical → image: centre, scale to coverage, roll, then a mild perspective (tilt about x).
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of phys) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y); }
  const span = Math.max(mxx - mnx, mxy - mny, 1e-6);
  // coverage = fraction of the frame the array fills along its tighter axis (so it always fits).
  const scale = (sc.coverage ?? 0.6) * Math.min(W / Math.max(mxx - mnx, 1e-6), H / Math.max(mxy - mny, 1e-6));
  const rot = ((sc.rotDeg ?? 0) * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot), tilt = sc.tilt ?? 0;
  const cx0 = (mnx + mxx) / 2, cy0 = (mny + mxy) / 2;
  const project = (p: Pt): Pt => {
    const u = (p.x - cx0) / span, v = (p.y - cy0) / span;       // ~[-0.5,0.5]
    const d = 1 + tilt * v;                                    // nearer at the bottom when tilted
    const pu = u / d, pv = v / d;
    const x = (pu * cr - pv * sr) * span * scale, y = (pu * sr + pv * cr) * span * scale; // span cancels the /span above
    return { x: W / 2 + x, y: H / 2 + y };
  };
  const pitch0 = medianNN(phys);
  const physJ = sc.posJitter ? phys.map((p) => ({ x: p.x + gauss(irnd) * sc.posJitter! * pitch0, y: p.y + gauss(irnd) * sc.posJitter! * pitch0 })) : phys;
  const img0 = physJ.map(project).map((p) => ({ x: p.x + (sc.offsetX ?? 0) * W, y: p.y }));
  const spacingPx = medianNN(img0);
  const sigma = Math.max(sc.minSpotPx ?? 0.7, (sc.spotFrac ?? 0.12) * spacingPx);
  const bloom = sc.bloom ?? 0.04, sigH = sigma * (sc.bloomRadius ?? 5);
  const level = sc.ledLevel ?? 0.6, ledVar = sc.ledVar ?? 0.15;
  const gainLed = phys.map(() => level * (1 + ledVar * (2 * irnd() - 1)) * (sc.ledVarLog ? Math.exp(gauss(irnd) * sc.ledVarLog) : 1));
  for (const d of sc.deadLeds ?? []) if (d < n) gainLed[d] = 0;
  const anch = new Set(sc.anchorLeds ?? []);
  const inMask = sc.onlyLeds ? new Set([...sc.onlyLeds, ...anch]) : null;
  if (sc.onlyLeds) for (const i of anch) if (!sc.onlyLeds.includes(i)) gainLed[i] *= sc.anchorScale ?? 1;
  // Off-axis LEDs: dimmer and their spot stretches along a random axis (projected emitter).
  const spotA = new Float32Array(n).fill(sigma), spotB = new Float32Array(n).fill(sigma), spotPhi = new Float32Array(n);
  if (sc.facingDeg) for (let i = 0; i < n; i++) {
    const c = Math.max(0.3, Math.cos((irnd() * sc.facingDeg * Math.PI) / 180));
    gainLed[i] *= c * c * c; spotA[i] = sigma / c; spotPhi[i] = irnd() * Math.PI;
  }
  if (sc.occludeFrac) for (let i = 0; i < n; i++) if (irnd() < sc.occludeFrac) gainLed[i] *= 0.05 + 0.25 * irnd();
  const pwmPhase = Float32Array.from({ length: n }, () => rnd()), pwmF = Float32Array.from({ length: n }, () => (sc.pwmHz ?? 0) * (0.95 + 0.1 * irnd()));
  const duty = Math.min(1, Math.max(1 / 255, sc.pwmDuty ?? 40 / 255));
  // Fraction of [a, a+E] (ms) that a square wave (freq f Hz, phase ph, duty d) is high, ÷ d — so the
  // long-exposure average is 1 and short exposures sample the flicker.
  const pwmGain = (i: number, a: number, E: number) => {
    const T = 1000 / pwmF[i], dT = duty * T, off = pwmPhase[i] * T;
    const F = (x: number) => { const y = x + off; return Math.floor(y / T) * dT + Math.min(((y % T) + T) % T, dT); };
    return (F(a + E) - F(a)) / (duty * E);
  };

  // Device frame start times (drifting + jittered clock).
  const devStart = rnd() * frameMs * cycleLen;                // camera opens mid-sequence
  const nDev = Math.ceil((durMs + devStart) / (frameMs * devScale)) + 4;
  const bound = new Float64Array(nDev + 1);
  for (let k = 0; k <= nDev; k++) bound[k] = -devStart + k * frameMs * devScale + rnd() * devJit;
  const devFrameAt = (t: number) => { let k = Math.floor((t + devStart) / (frameMs * devScale)); k = Math.max(0, Math.min(nDev - 1, k)); while (k > 0 && t < bound[k]) k--; while (k < nDev - 1 && t >= bound[k + 1]) k++; return k; };
  const ledOn = (i: number, k: number) => seqOn(seq, bits, k % cycleLen, i);

  // Static ambient radiance image.
  const amb = new Float32Array(N), a0 = sc.ambient ?? 0.02, ag = sc.ambientGradient ?? 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) amb[y * W + x] = a0 + ag * (x / W);
  for (const L of sc.lamps ?? []) { const lx = L.x * W, ly = L.y * H, lr = L.r * W; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d2 = (x - lx) ** 2 + (y - ly) ** 2; amb[y * W + x] += L.level * Math.exp(-d2 / (2 * lr * lr)); } }

  const fps = sc.fps ?? 30, fj = sc.fpsJitterMs ?? 3, drop = sc.dropRate ?? 0.02;
  const expMs = sc.exposureMs ?? 16, rs = sc.rollingShutterMs ?? 20, noise = sc.noise ?? 2;
  const ae = sc.autoExposure ?? true, aeT = sc.aeTarget ?? 0.18, aeS = sc.aeSpeed ?? 0.12;
  const shake = sc.shakePx ?? 0;
  let gain = 1, sx = 0, sy = 0, msx = 0, msy = 0, kept = 0;
  const frames: Frame[] = [];
  const rad = new Float32Array(N);
  const SUB = 6;                                               // sub-samples across the exposure window
  const R = Math.ceil(3 * (bloom > 0 ? sigH : sigma));
  for (let fi = 0, t = 0; t < durMs; fi++, t = fi * (1000 / fps) + gauss(rnd) * fj) {
    if (shake) { sx += gauss(rnd) * shake; sy += gauss(rnd) * shake; }
    if (rnd() < drop) continue;
    if (sc.flickerHz && sc.flickerDepth) {
      // Mains-lit ambient, integrated over each row's (rolling-shutter-shifted) exposure → bands.
      const fd = sc.flickerDepth, w2 = (2 * Math.PI * sc.flickerHz) / 2000;   // |sin| has period 1/flickerHz
      for (let y = 0; y < H; y++) {
        const a = t + (y / H) * rs; let m = 0;
        for (let q = 0; q < 8; q++) m += 1 - fd + fd * Math.abs(Math.sin(w2 * (a + ((q + 0.5) / 8) * expMs)));
        m /= 8; for (let x = 0; x < W; x++) rad[y * W + x] = amb[y * W + x] * m;
      }
    } else rad.set(amb);
    for (let pass = 0; pass < (sc.reflection ? 2 : 1); pass++)
    for (let i = 0; i < n; i++) {
      if (!gainLed[i] || (inMask && !inMask.has(i))) continue;
      const refl = pass === 1, rf = sc.reflection;
      const px = img0[i].x + sx, py = refl ? 2 * rf!.mirrorY * H - (img0[i].y + sy) : img0[i].y + sy;
      if (py < -50 || py > H + 50) continue;
      // On-fraction over this LED's row exposure window (rolling shutter → row-dependent start).
      const tr = t + (py / H) * rs; let on = 0;
      for (let s = 0; s < SUB; s++) if (ledOn(i, devFrameAt(tr + ((s + 0.5) / SUB) * expMs))) on++;
      if (!on) continue;
      let I = gainLed[i] * (on / SUB) * (refl ? rf!.strength : 1);
      if (sc.pwmHz) I *= pwmGain(i, tr, expMs);
      if (I <= 0) continue;
      const sa = spotA[i] * (refl ? 3 : 1), sb = spotB[i] * (refl ? 3 : 1), cph = Math.cos(spotPhi[i]), sph = Math.sin(spotPhi[i]);
      const Ri = Math.max(R, Math.ceil(3 * sa));
      const x0 = Math.max(0, Math.floor(px - Ri)), x1 = Math.min(W - 1, Math.ceil(px + Ri));
      const y0 = Math.max(0, Math.floor(py - Ri)), y1 = Math.min(H - 1, Math.ceil(py + Ri));
      const ia = 1 / (2 * sa * sa), ib = 1 / (2 * sb * sb), ih = 1 / (2 * sigH * sigH);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x - px, dy = y - py, u = dx * cph + dy * sph, v = -dx * sph + dy * cph;
        rad[y * W + x] += I * (Math.exp(-u * u * ia - v * v * ib) + (bloom > 0 ? bloom * Math.exp(-(dx * dx + dy * dy) * ih) : 0));
      }
    }
    const gray = new Uint8Array(N); let mean = 0;
    for (let p = 0; p < N; p++) {
      const lin = rad[p] * gain; mean += Math.min(1, lin);
      let v = 255 * Math.pow(Math.min(1, Math.max(0, lin)), 1 / 2.2) + gauss(rnd) * noise;
      gray[p] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    if (ae) gain = Math.min(64, Math.max(0.25, gain * Math.pow(aeT / Math.max(1e-4, mean / N), aeS)));
    frames.push({ t, gray, w: W, h: H }); msx += sx; msy += sy; kept++;
  }
  // Truth = mean pose over the capture (a still-camera decoder can at best recover the average).
  const truth = img0.map((p) => ({ x: p.x + msx / Math.max(1, kept), y: p.y + msy / Math.max(1, kept) }));
  return { frames, numLeds: n, bits, truth, expected, spacingPx };
}

function medianNN(pts: Pt[]): number {
  if (pts.length < 2) return 1;
  const d = pts.map((p, i) => { let m = Infinity; pts.forEach((q, j) => { if (i !== j) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y)); }); return m; }).sort((a, b) => a - b);
  return d[d.length >> 1];
}

export type PointScore = { correct: number; wrong: number; missing: number; meanErrPx: number };

/** Decoded points (normalized by image width, as the decoder returns) vs. ground truth. */
export function scorePoints(points: (Pt | null)[], truth: Pt[], spacingPx: number, imgW: number): PointScore {
  let correct = 0, wrong = 0, err = 0;
  for (let i = 0; i < truth.length; i++) {
    const p = points[i]; if (!p) continue;
    const e = Math.hypot(p.x * imgW - truth[i].x, p.y * imgW - truth[i].y);
    if (e < 0.4 * spacingPx) { correct++; err += e; } else wrong++;
  }
  return { correct, wrong, missing: truth.length - correct - wrong, meanErrPx: correct ? err / correct : 0 };
}

/** Compare a produced ledmap with the expected one, up to rotation + mirror (orientation isn't
 *  recoverable from geometry; the UI's rotate button handles it). Returns the best cell agreement. */
export function scoreLedmap(got: Ledmap, want: Ledmap): { exact: boolean; cellMatch: number } {
  let best = 0;
  for (const g of dihedral(got)) {
    if (g.width !== want.width || g.height !== want.height) continue;
    let m = 0, tot = 0;
    for (let c = 0; c < want.map.length; c++) { if (want.map[c] < 0 && g.map[c] < 0) continue; tot++; if (want.map[c] === g.map[c]) m++; }
    best = Math.max(best, tot ? m / tot : 0);
  }
  return { exact: best === 1, cellMatch: best };
}

export function dihedral(l: Ledmap): Ledmap[] {
  const out: Ledmap[] = []; let cur = l;
  const rot = (m: Ledmap): Ledmap => { const o = new Array(m.map.length).fill(-1); for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) o[x * m.height + (m.height - 1 - y)] = m.map[y * m.width + x]; return { width: m.height, height: m.width, map: o }; };
  const flip = (m: Ledmap): Ledmap => { const o = new Array(m.map.length).fill(-1); for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) o[y * m.width + (m.width - 1 - x)] = m.map[y * m.width + x]; return { ...m, map: o }; };
  for (let k = 0; k < 4; k++) { out.push(cur, flip(cur)); cur = rot(cur); }
  return out;
}
