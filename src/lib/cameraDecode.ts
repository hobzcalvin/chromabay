// Camera structured-light decode (FIRST PASS — the part to tune on real hardware).
// The device flashes [ALL-OFF][ALL-ON][bit0..bit(bits-1)] repeating; we capture a dense
// burst of frames, find the bright (ALL-ON) and dark (ALL-OFF) reference frames, detect LED
// blobs on (ON−OFF), then read each blob's on/off across the bit-frames to recover its LED
// index, and return points[ledIndex] = {x,y} normalized to [0,1].
//
// Thresholds / window sizes / frame alignment WILL need tuning against a real strip+camera;
// they're surfaced as options. This is intentionally a single-burst decoder (no inter-frame
// motion homography yet — hold the camera reasonably still for v1).
import type { Pt } from './autoLayout';

export type DecodeOpts = {
  bits: number;
  frameMs: number;        // device CALIB_FRAME_MS (220) — must match firmware
  cycles?: number;        // how many full flash cycles to capture (default 4)
  captureMs?: number;     // total capture window (default cycles × period + 1 frame)
  procWidth?: number;     // downscale width for processing (default 240; higher separates merged dots)
  relThr?: number;        // detection threshold as a FRACTION of the observed swing, 0..1 (default 0.35).
                          // Lower = more sensitive. This is the differential/adaptive knob — no
                          // absolute brightness, so a dark background isn't required.
  noiseFloor?: number;    // absolute min swing to count as "blinking" (reject sensor noise; default 12)
  minBlobPx?: number;     // min pixels per LED cluster (default ~maskPx/600; lower splits merges)
  numLeds?: number;       // expected LED count — codes ≥ this are out-of-range (corruption signal)
  onLog?: (m: string) => void;
};

// Quantitative health of a decode — drives the adaptive auto-scan loop (and surfaces coaching).
export type DecodeDiag = {
  found: number;          // LEDs located
  maskPx: number;         // strip pixels (temporal-swing region) — tiny => too far / too dim
  maxRange: number;       // strongest temporal swing (0..255) — low => too dim / not flashing
  clippedPct: number;     // fraction of strip px clipped at 255 in the brightest frame — high => bloom
  outOfRangePct: number;  // fraction of decoded px whose code ≥ numLeds — high => bloom/corruption
  motionPx: number;       // camera drift during the capture (px) — high => hold still
  cyclesUsed: number;     // flash cycles successfully folded
};

// Diagnostic data so the UI can show what the decoder actually saw.
export type DecodeDebug = {
  w: number; h: number;
  range: Uint8Array;                 // per-pixel temporal swing (what blinked — phase-independent)
  blobs: { x: number; y: number }[]; // detected candidate LED centroids
  decoded: { x: number; y: number; idx: number }[];
  frames: number; roiCount: number; maxRange: number;
};

export type Frame = { t: number; gray: Uint8Array; w: number; h: number };

// Capture the exact frames the decoder sees (downscaled max-channel grayscale + timestamps),
// for recording a calibration session to tune the decode offline. Exposed for the recorder.
export function captureRawFrames(video: HTMLVideoElement, captureMs: number, procWidth = 240): Promise<Frame[]> {
  return captureBurst(video, captureMs, procWidth);
}

// Grab frames from a live <video> into downscaled grayscale buffers for `captureMs`.
async function captureBurst(video: HTMLVideoElement, captureMs: number, procWidth: number): Promise<Frame[]> {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const w = Math.min(procWidth, vw), h = Math.round((w / vw) * vh);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames: Frame[] = [];
  const t0 = performance.now();
  return new Promise((resolve) => {
    const grab = () => {
      ctx.drawImage(video, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      // "Brightness" = MAX(R,G,B), not luma — so a coloured LED (e.g. a blue one, which is
      // ~dark in luma) registers as fully bright. `gray` holds this max-channel value.
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const m = d[i] > d[i + 1] ? d[i] : d[i + 1];
        gray[j] = m > d[i + 2] ? m : d[i + 2];
      }
      frames.push({ t: performance.now() - t0, gray, w, h });
      if (performance.now() - t0 < captureMs) requestAnimationFrame(grab);
      else resolve(frames);
    };
    requestAnimationFrame(grab);
  });
}

/** What a decode produced (or why it didn't). points is empty unless LEDs were confidently seen. */
export type DecodeResult = { points: (Pt | null)[]; ok: boolean; reason: string; debug?: DecodeDebug; diag?: DecodeDiag };

/**
 * Decode the calibration burst into points[ledIndex] = {x,y} (normalized 0..1), null = gap.
 *
 * Approach (validated against recorded hardware footage, see automation/decode-capture.mjs):
 *  1. Per-frame background subtraction (histogram median) cancels the camera's auto-exposure
 *     pulsing, so only the LEDs move.
 *  2. An LED MASK from the per-pixel temporal swing isolates the strip from the background.
 *  3. TIMING IS RECOVERED FROM THE DATA, not assumed: the device's real frame timing differs
 *     from the nominal frameMs (BLE/loop overhead) and the ALL-OFF frame is held much longer
 *     than the others, so a fixed-period fold misaligns the bit slots. Instead we find the long
 *     dark OFF intervals (unambiguous), then split each ACTIVE region between them into
 *     (bits+1) equal sub-slots = [ON][bit0..]. Works regardless of the device's actual cadence.
 *  4. PER-PIXEL structured-light decode: each pixel reads its own bit-code from the slot images
 *     (bit set iff that slot is brighter than the pixel's ON/OFF midpoint). Pixels are then
 *     CLUSTERED by decoded index → centroid per LED. This separates LEDs even when they bloom
 *     together (a saturated matrix is one blob in the range image, but distinct in code space).
 *
 * NOTE: the LEDs must not be over-exposed. At full brightness they saturate the sensor and
 * bloom past their spacing, clipping the per-LED signal — decode then collapses. Flash dim
 * (firmware calibration brightness ~40) so they read as distinct dots.
 */
export async function captureAndDecode(video: HTMLVideoElement, opts: DecodeOpts): Promise<DecodeResult> {
  const bits = opts.bits;
  const frameMs = opts.frameMs;
  const slots = 1 + bits;                       // [ALL-ON][bit0..] — no all-off frame
  const cycles = opts.cycles ?? 4;
  // Capture generously (2× nominal) to absorb camera/device timing slack + get the full cycles.
  const captureMs = opts.captureMs ?? slots * frameMs * cycles * 2 + frameMs;
  const procWidth = opts.procWidth ?? 240;
  const relThr = opts.relThr ?? 0.35;
  const noiseFloor = opts.noiseFloor ?? 12;
  const log = opts.onLog ?? (() => {});

  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < slots * 2) return { points: [], ok: false, reason: 'too few camera frames captured' };
  const w = frames[0].w, h = frames[0].h, N = w * h, F = frames.length;
  log(`captured ${F} frames @ ${w}x${h}`);

  // (1) Per-frame background level (histogram median) → exposure-flat normalized value nv().
  const bg = new Float32Array(F);
  for (let fi = 0; fi < F; fi++) {
    const g = frames[fi].gray; const hist = new Int32Array(64);
    for (let i = 0; i < N; i++) hist[g[i] >> 2]++;
    let acc = 0; let bin = 0; const half = N >> 1;
    for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= half) break; }
    bg[fi] = bin * 4 + 2;
  }
  const nv = (fi: number, i: number) => {
    const v = frames[fi].gray[i] - bg[fi] + 128;
    return v < 0 ? 0 : v > 255 ? 255 : v;
  };

  // (2) Per-pixel temporal swing → LED mask (the strip vs the static background).
  const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
  for (let fi = 0; fi < F; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
  const range = new Uint8Array(N);
  let maxRange = 0;
  for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > maxRange) maxRange = r; }
  const debug: DecodeDebug = { w, h, range, blobs: [], decoded: [], frames: F, roiCount: 0, maxRange };
  const diag: DecodeDiag = { found: 0, maskPx: 0, maxRange, clippedPct: 0, outOfRangePct: 0, motionPx: 0, cyclesUsed: 0 };
  const fail = (reason: string): DecodeResult => ({ points: [], ok: false, reason, debug, diag });
  if (maxRange < noiseFloor) return fail('nothing in view is blinking — is the strip calibrating and in frame?');

  const maskThr = Math.max(noiseFloor, relThr * maxRange);
  const maskIdx: number[] = [];
  for (let i = 0; i < N; i++) if (range[i] >= maskThr) maskIdx.push(i);
  debug.roiCount = maskIdx.length; diag.maskPx = maskIdx.length;
  if (maskIdx.length < (opts.minBlobPx ?? 3)) return fail('blinking region too small — move closer / fill more of the frame');

  // (3) Recover timing by finding the ALL-ON frames (every LED lit → the lit-pixel count peaks).
  // These anchor both the cycle (the bits follow each ON) and the motion registration below.
  // Also track sensor clipping (bloom signal): max fraction of strip px pinned at 255.
  const litC = new Int32Array(F);
  let maxClipped = 0;
  for (let fi = 0; fi < F; fi++) {
    let c = 0, clip = 0;
    for (const i of maskIdx) { const g = frames[fi].gray[i]; if (g - bg[fi] + 128 > 175) c++; if (g >= 250) clip++; }
    litC[fi] = c; if (clip > maxClipped) maxClipped = clip;
  }
  diag.clippedPct = maskIdx.length ? maxClipped / maskIdx.length : 0;
  let maxLit = 0; for (let fi = 0; fi < F; fi++) if (litC[fi] > maxLit) maxLit = litC[fi];
  const onThr = 0.7 * maxLit;                    // ALL-ON ≈ maxLit; bit frames ≈ half → well separated
  const onInt: [number, number][] = [];
  { let s = -1;
    for (let fi = 0; fi < F; fi++) {
      if (litC[fi] >= onThr) { if (s < 0) s = fi; }
      else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.4) onInt.push([s, fi - 1]); s = -1; } }
    }
    if (s >= 0 && frames[F - 1].t - frames[s].t > frameMs * 0.4) onInt.push([s, F - 1]);
  }
  if (onInt.length < 2) return fail('could not lock onto the flash cycle — hold steadier / capture longer');

  // Motion registration (handheld): each ALL-ON frame shows the full constellation, so its bright
  // centroid moves with the device. Align every frame to the first ON's centroid (translation,
  // interpolated for the bit frames between ON anchors) before folding — so a moving capture folds
  // like a still one. On a still capture all centroids match → zero shift → no-op.
  const onCent = onInt.map(([a, b]) => {
    let sx = 0, sy = 0, sw = 0;
    for (let fi = a; fi <= b; fi++) for (const i of maskIdx) { const v = nv(fi, i); if (v > 170) { sx += (i % w) * v; sy += ((i / w) | 0) * v; sw += v; } }
    return { t: (frames[a].t + frames[b].t) / 2, x: sw ? sx / sw : 0, y: sw ? sy / sw : 0 };
  });
  const refX = onCent[0].x, refY = onCent[0].y;
  for (const c of onCent) { const d = Math.hypot(c.x - refX, c.y - refY); if (d > diag.motionPx) diag.motionPx = d; }
  const shiftAt = (t: number): { dx: number; dy: number } => {
    let cx = onCent[0].x, cy = onCent[0].y;
    if (t >= onCent[onCent.length - 1].t) { cx = onCent[onCent.length - 1].x; cy = onCent[onCent.length - 1].y; }
    else if (t > onCent[0].t) for (let k = 0; k < onCent.length - 1; k++) {
      if (t >= onCent[k].t && t <= onCent[k + 1].t) { const f = (t - onCent[k].t) / ((onCent[k + 1].t - onCent[k].t) || 1); cx = onCent[k].x + (onCent[k + 1].x - onCent[k].x) * f; cy = onCent[k].y + (onCent[k + 1].y - onCent[k].y) * f; break; }
    }
    return { dx: Math.round(cx - refX), dy: Math.round(cy - refY) };
  };
  // registered sample: read reference pixel (x,y) from frame fi at its motion-shifted location
  const nvS = (fi: number, x: number, y: number): number => {
    const sh = shiftAt(frames[fi].t); const xx = x + sh.dx, yy = y + sh.dy;
    return xx < 0 || yy < 0 || xx >= w || yy >= h ? 128 : nv(fi, yy * w + xx);
  };

  // ALL-ON reference (registered).
  const onRef = new Float32Array(N); let onc = 0;
  for (const [a, b] of onInt) {
    const span = frames[b].t - frames[a].t || 1;
    for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / span; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) onRef[i] += nvS(fi, i % w, (i / w) | 0); onc++; }
  }
  // bit references: the region between consecutive ON anchors holds bit0..bit(bits-1); split into
  // `bits` equal sub-slots (middle of each), registered, averaged across all cycles.
  const bitRef = Array.from({ length: bits }, () => new Float32Array(N));
  const bitCnt = new Int32Array(bits);
  let cyclesUsed = 0;
  for (let k = 0; k < onInt.length - 1; k++) {
    const aS = onInt[k][1] + 1, aE = onInt[k + 1][0] - 1;
    const t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0;
    if (aE <= aS || dur < bits * 30) continue;
    cyclesUsed++;
    for (let fi = aS; fi <= aE; fi++) {
      const f = ((frames[fi].t - t0) / dur) * bits;
      const s = Math.min(bits - 1, Math.floor(f));
      const fr = f - s; if (fr < 0.2 || fr > 0.8) continue;   // middle of the sub-slot only
      for (const i of maskIdx) bitRef[s][i] += nvS(fi, i % w, (i / w) | 0);
      bitCnt[s]++;
    }
  }
  if (!onc || !cyclesUsed || bitCnt.some((c) => c === 0)) return fail('capture too short — missed calibration frames (raise cycles / hold steadier)');
  diag.cyclesUsed = cyclesUsed;
  for (const i of maskIdx) onRef[i] /= onc;
  for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef[b][i] /= bitCnt[b];
  // OFF level per pixel = the dimmest bit slot (the bit frames where that LED is dark). No all-off
  // frame needed; LED 0 (dark in every bit frame) is still found via its swing against ALL-ON.
  const offRef = new Float32Array(N);
  for (const i of maskIdx) { let mn = Infinity; for (let b = 0; b < bits; b++) if (bitRef[b][i] < mn) mn = bitRef[b][i]; offRef[i] = mn; }
  log(`${cyclesUsed} cycles, ${maskIdx.length} strip px, swing ${maxRange}, drift ${diag.motionPx | 0}px`);

  // (4) Per-pixel decode, then cluster pixels by their decoded index → one centroid per LED.
  let maxContrast = 0; for (const i of maskIdx) { const c = onRef[i] - offRef[i]; if (c > maxContrast) maxContrast = c; }
  const contrastThr = Math.max(noiseFloor, 0.25 * maxContrast);
  const codes = 1 << bits;
  const numLeds = opts.numLeds ?? codes;
  const sumX = new Float64Array(codes), sumY = new Float64Array(codes), sumW = new Float64Array(codes), cnt = new Int32Array(codes);
  let decodedPx = 0, outOfRangePx = 0;
  for (const i of maskIdx) {
    const c = onRef[i] - offRef[i];
    if (c < contrastThr) continue;                       // not on a lit LED
    const mid = (onRef[i] + offRef[i]) / 2;
    let idx = 0;
    for (let b = 0; b < bits; b++) if (bitRef[b][i] > mid) idx |= (1 << b);
    decodedPx++;
    if (idx >= numLeds) { outOfRangePx++; continue; }     // impossible code → bloom/corruption, not an LED
    const x = i % w, y = (i / w) | 0;
    sumX[idx] += x * c; sumY[idx] += y * c; sumW[idx] += c; cnt[idx]++;
  }
  diag.outOfRangePct = decodedPx ? outOfRangePx / decodedPx : 0;
  const minCluster = opts.minBlobPx ?? Math.max(2, Math.round(maskIdx.length / 600));
  const pts: (Pt | null)[] = new Array(numLeds).fill(null);
  let found = 0;
  for (let idx = 0; idx < numLeds; idx++) {
    if (cnt[idx] >= minCluster && sumW[idx] > 0) {
      const cx = sumX[idx] / sumW[idx], cy = sumY[idx] / sumW[idx];
      pts[idx] = { x: cx / w, y: cy / h };
      debug.decoded.push({ x: cx, y: cy, idx });
      found++;
    }
  }
  diag.found = found;
  // Trim trailing gaps (indices beyond the highest decoded LED carry no information).
  let last = pts.length - 1; while (last >= 0 && pts[last] === null) last--;
  const out = pts.slice(0, last + 1);
  if (!found) return fail('strip found but no LEDs decoded — try dimmer calibration brightness / lower sensitivity');
  log(`decoded ${found} LEDs`);
  return { points: out, ok: true, reason: `decoded ${found} LEDs`, debug, diag };
}

// ---- adaptive auto-scan ------------------------------------------------------------------

export type AutoMapHooks = {
  // (re)start the device flashing. 'strobe' = ALL on/off (fast exposure tuning); 'full' = structured-light.
  startFlash: (brightness: number, mode: 'strobe' | 'full') => Promise<void>;
  stopFlash: () => Promise<void>;
  onProgress?: (msg: string, info: { attempt: number; best: number }) => void;
  onAttempt?: (res: DecodeResult, brightness: number) => void; // intermediate result (for live debug view)
  shouldStop?: () => boolean;                        // cancel hook (e.g. user closed the modal)
};

// Cheap exposure readout from a STROBE burst (all-LED on/off) — no decode. Drives the fast
// brightness-tuning phase: we only need the ON/OFF swing + clipping to know if we're over/under.
function analyzeExposure(frames: Frame[], relThr: number): { clippedPct: number; maxRange: number; maskPx: number } {
  if (frames.length < 2) return { clippedPct: 0, maxRange: 0, maskPx: 0 };
  const w = frames[0].w, h = frames[0].h, N = w * h, F = frames.length;
  const bg = new Float32Array(F);
  for (let fi = 0; fi < F; fi++) {
    const g = frames[fi].gray; const hist = new Int32Array(64);
    for (let i = 0; i < N; i++) hist[g[i] >> 2]++;
    let acc = 0, bin = 0; const half = N >> 1;
    for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= half) break; }
    bg[fi] = bin * 4 + 2;
  }
  const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
  for (let fi = 0; fi < F; fi++) for (let i = 0; i < N; i++) { let v = frames[fi].gray[i] - bg[fi] + 128; v = v < 0 ? 0 : v > 255 ? 255 : v; if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
  let maxRange = 0; for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; if (r > maxRange) maxRange = r; }
  const maskThr = Math.max(12, relThr * maxRange);
  let maskPx = 0, maxClipped = 0;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (pmax[i] - pmin[i] >= maskThr) { mask[i] = 1; maskPx++; }
  for (let fi = 0; fi < F; fi++) { let clip = 0; for (let i = 0; i < N; i++) if (mask[i] && frames[fi].gray[i] >= 250) clip++; if (clip > maxClipped) maxClipped = clip; }
  return { clippedPct: maskPx ? maxClipped / maskPx : 0, maxRange, maskPx };
}

export type AutoMapResult = DecodeResult & { attempts: number; brightness: number; coaching?: string };

// Decide the next move from a decode's diagnostics. Pure so it's unit-testable.
//   - over-exposed (clipping / out-of-range codes)  → flash dimmer
//   - under-exposed (no swing / nothing blinks)      → flash brighter
//   - region tiny / motion                           → coach the user, retry
//   - exposure ok but incomplete                     → raise sensitivity, then resolution
function planAdjustment(res: DecodeResult, numLeds: number, p: { brightness: number; relThr: number; procWidth: number }) {
  const d = res.diag;
  let { brightness, relThr, procWidth } = p;
  let coaching = '';
  const solid = res.ok && (res.diag?.found ?? 0) >= numLeds;
  if (solid) return { solid: true, brightness, relThr, procWidth, coaching: '' };

  const overExposed = !!d && (d.clippedPct > 0.3 || d.outOfRangePct > 0.12);
  const underExposed = !d || d.maxRange < 45 || (!res.ok && /blinking|lock onto/.test(res.reason));
  const tinyRegion = !!d && d.maskPx > 0 && d.maskPx < 120;
  const moving = !!d && d.motionPx > 18; // registration compensates translation up to ~this; beyond it, coach

  if (overExposed) { brightness = Math.max(6, Math.round(brightness * 0.55)); coaching = 'Too bright — dimming the LEDs.'; }
  else if (underExposed) { brightness = Math.min(220, Math.round(brightness * 1.7) + 4); coaching = 'Too dim — brightening the LEDs.'; }
  else if (tinyRegion) { coaching = 'Move closer / fill more of the frame with the strip.'; if (procWidth < 360) procWidth += 60; }
  else if (moving) { coaching = 'Hold the camera still.'; }
  else { // exposure & framing fine, decode just incomplete → get more sensitive, then sharper
    if (relThr > 0.18) relThr = Math.max(0.15, relThr - 0.07);
    else if (procWidth < 360) procWidth += 60;
    else brightness = Math.max(6, Math.round(brightness * 0.8)); // last resort: nudge dimmer
    coaching = 'Refining…';
  }
  return { solid: false, brightness, relThr, procWidth, coaching };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Foolproof scan, in two phases, up to `budgetMs`:
 *
 *  PHASE 1 — exposure lock (fast). The device STROBES all LEDs on/off; we grab a short burst and
 *  re-evaluate after each strobe (~1.5s, not a full decode), nudging flash brightness until the
 *  LEDs are crisp dots (strong ON/OFF swing, not clipping). This is the cheapest, strongest signal
 *  for "are the LEDs over/under-exposed?" — no need to decode bit-planes to find that out.
 *
 *  PHASE 2 — decode. With brightness locked, the device runs the full structured-light sequence;
 *  we decode, and keep refining (sensitivity, motion coaching, exposure drift) until all LEDs lock
 *  or the budget runs out. Returns the best attempt and reflects the brightness that worked back.
 */
export async function autoMap(
  video: HTMLVideoElement,
  base: { bits: number; frameMs: number; numLeds: number; brightness?: number; relThr?: number; procWidth?: number },
  hooks: AutoMapHooks,
  budgetMs = 60000,
): Promise<AutoMapResult> {
  const { bits, frameMs, numLeds } = base;
  let brightness = base.brightness ?? 40, relThr = base.relThr ?? 0.35, procWidth = base.procWidth ?? 240;
  const progress = hooks.onProgress ?? (() => {});
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  let best: DecodeResult | null = null;
  let attempt = 0, coaching = '';

  try {
    // ---- PHASE 1: strobe → lock exposure ----
    const exposureDeadline = Math.min(budgetMs * 0.45, 25000);
    let lastB = -1;
    while (elapsed() < exposureDeadline) {
      if (hooks.shouldStop?.()) break;
      attempt++;
      const reflash = brightness !== lastB;
      if (reflash) { await hooks.startFlash(brightness, 'strobe'); lastB = brightness; }
      await sleep(reflash ? 900 : 250);                        // let the camera auto-expose after a change
      const frames = await captureBurst(video, 1300, procWidth);
      if (hooks.shouldStop?.()) break;
      const ex = analyzeExposure(frames, relThr);
      progress(`Tuning exposure @ ${brightness} — swing ${ex.maxRange | 0}, clip ${(ex.clippedPct * 100) | 0}%`, { attempt, best: 0 });

      if (ex.maskPx < 40 && ex.maxRange < 12) {                // nothing is flashing
        if (brightness >= 200) { coaching = 'No flashing LEDs in view — aim at the strip and keep it calibrating.'; break; }
        brightness = Math.min(220, Math.round(brightness * 1.7) + 8); continue;
      }
      if (ex.clippedPct > 0.20) { brightness = Math.max(6, Math.round(brightness * 0.6)); coaching = 'Too bright — dimming.'; continue; }
      if (ex.maxRange < 70) { brightness = Math.min(220, Math.round(brightness * 1.5) + 4); coaching = 'Too dim — brightening.'; continue; }
      if (ex.maskPx < 120) coaching = 'Move closer / fill more of the frame.';
      break;                                                   // exposure good enough → decode
    }

    // ---- PHASE 2: full sequence → decode + refine ----
    let lastB2 = -1;
    while (elapsed() < budgetMs) {
      if (hooks.shouldStop?.()) break;
      attempt++;
      const bestFound = best?.diag?.found ?? 0;
      progress(coaching || 'Decoding…', { attempt, best: bestFound });
      const reflash = brightness !== lastB2;
      if (reflash) { await hooks.startFlash(brightness, 'full'); lastB2 = brightness; }
      await sleep(reflash ? 900 : 350);
      const res = await captureAndDecode(video, {
        bits, frameMs, numLeds, cycles: 2, relThr, procWidth, onLog: (m) => progress(m, { attempt, best: bestFound }),
      });
      if (hooks.shouldStop?.()) break;
      hooks.onAttempt?.(res, brightness);
      if ((res.diag?.found ?? 0) > (best?.diag?.found ?? -1)) best = res;

      const plan = planAdjustment(res, numLeds, { brightness, relThr, procWidth });
      coaching = plan.coaching;
      if (plan.solid) { best = res; break; }
      brightness = plan.brightness; relThr = plan.relThr; procWidth = plan.procWidth;
    }
  } finally {
    await hooks.stopFlash().catch(() => {});
  }

  const r = best ?? { points: [], ok: false, reason: 'no usable capture' };
  const found = r.diag?.found ?? 0;
  return {
    ...r,
    ok: found > 0,
    attempts: attempt,
    brightness,
    coaching,
    reason: found >= numLeds ? `mapped all ${numLeds} LEDs` : found > 0
      ? `mapped ${found}/${numLeds} LEDs (best effort)` : (r.reason || 'no LEDs found'),
  };
}
