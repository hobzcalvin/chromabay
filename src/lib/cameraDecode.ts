// Camera structured-light decode (FIRST PASS — the part to tune on real hardware).
// The device flashes [ALL-ON][bit0..bit(bits-1)] repeating (no dark frame — it only made the
// camera re-expose); we capture a dense burst of frames, locate LED blobs on a clean contrast
// image, anchor on the periodic ALL-ON pulse, then read each blob's on/off across the bit-frames
// to recover its LED index, and return points[ledIndex] = {x,y} normalized to [0,1].
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
  fill: number;           // lit area ÷ bounding box — high (>~0.2) => LEDs bloomed into a solid blob
  motionPx: number;       // camera drift during the capture (px) — high => hold still
  cyclesUsed: number;     // flash cycles successfully folded
};

// Diagnostic data so the UI can show what the decoder actually saw.
export type DecodeDebug = {
  w: number; h: number;
  range: Uint8Array;                 // per-pixel temporal swing (what blinked — phase-independent)
  blobs: { x: number; y: number }[]; // detected candidate LED centroids
  decoded: { x: number; y: number; idx: number }[];
  onImage?: Uint8Array;              // a representative ALL-ON frame (grayscale w×h) — for the result overlay
  frames: number; roiCount: number; maxRange: number;
};

// How visible the blinking strip is right now — drives the brightness ramp. Strobe the strip,
// grab a short window, and measure the per-pixel temporal swing + how many distinct blobs blink.
export async function measureSwing(video: HTMLVideoElement, captureMs: number, procWidth = 320):
  Promise<{ maxRange: number; maskPx: number; blobs: number }> {
  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < 3) return { maxRange: 0, maskPx: 0, blobs: 0 };
  const w = frames[0].w, h = frames[0].h, N = w * h;
  const pmin = new Uint8Array(N).fill(255), pmax = new Uint8Array(N);
  for (const f of frames) for (let i = 0; i < N; i++) { const v = f.gray[i]; if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
  const range = new Uint8Array(N); let mx = 0;
  for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > mx) mx = r; }
  if (mx < 18) return { maxRange: mx, maskPx: 0, blobs: 0 };
  const thr = Math.max(18, 0.4 * mx);
  let maskPx = 0; for (let i = 0; i < N; i++) if (range[i] >= thr) maskPx++;
  const blobs = detectBlobs(range, w, h, { thresh: thr, minPx: Math.max(2, Math.round(N / 80000)) }).length;
  return { maxRange: mx, maskPx, blobs };
}

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

export type Blob = { x: number; y: number; n: number };

// Find bright blobs (LED dots) in a grayscale image via thresholded connected components.
// Robust + cheap; used both for the live detection overlay and to locate LEDs before reading
// their codes. `thresh` defaults to half the peak; size filters reject sensor noise and
// background/bloom mega-blobs.
export function detectBlobs(gray: Uint8Array, w: number, h: number,
  opts?: { thresh?: number; minPx?: number; maxPx?: number }): Blob[] {
  const N = w * h;
  let mx = 0; for (let i = 0; i < N; i++) if (gray[i] > mx) mx = gray[i];
  const thresh = opts?.thresh ?? Math.max(60, mx * 0.5);
  const minPx = opts?.minPx ?? Math.max(2, Math.round(N / 40000));
  const maxPx = opts?.maxPx ?? Math.round(N / 12);          // a single LED shouldn't fill the frame
  const seen = new Uint8Array(N), out: Blob[] = [], st: number[] = [];
  for (let p0 = 0; p0 < N; p0++) {
    if (gray[p0] < thresh || seen[p0]) continue;
    st.length = 0; st.push(p0); seen[p0] = 1; let sx = 0, sy = 0, n = 0;
    while (st.length) {
      const p = st.pop()!; const x = p % w, y = (p / w) | 0; sx += x; sy += y; n++;
      if (x > 0 && gray[p - 1] >= thresh && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
      if (x < w - 1 && gray[p + 1] >= thresh && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
      if (y > 0 && gray[p - w] >= thresh && !seen[p - w]) { seen[p - w] = 1; st.push(p - w); }
      if (y < h - 1 && gray[p + w] >= thresh && !seen[p + w]) { seen[p + w] = 1; st.push(p + w); }
    }
    if (n >= minPx && n <= maxPx) out.push({ x: sx / n, y: sy / n, n });
  }
  return out;
}

/**
 * Decode the calibration burst into points[ledIndex] = {x,y} (normalized 0..1), null = gap.
 *
 * Two passes (validated on real hardware captures, see automation/decode-capture.mjs):
 *  PASS 1 — LOCATE: per-frame background subtraction cancels the camera's exposure pulsing; the
 *    per-pixel temporal swing gives a LED mask; a clean ALL-ON-minus-OFF contrast image is built
 *    from rough anchors and `detectBlobs` finds each LED as a bright dot. (Bright distinct dots are
 *    trivial to find; per-pixel decode + clustering was not robust on real data.)
 *  PASS 2 — READ: for each blob we take its own brightness time-series (sampled at ~1 px to avoid
 *    neighbour crosstalk on dense grids). The device cycles [ALL-ON][bit0..]; we anchor on the
 *    periodic ALL-ON pulse (counting LIT BLOBS, not pixels — robust to the iOS camera's exposure
 *    hunting), split each cycle into 1+bits sub-slots = [ALL-ON][bit0..], and read each blob's
 *    bit-code from its own per-slot brightness against its ALL-ON vs darkest-bit levels.
 *
 * NOTE: keep the LEDs dim enough that they read as distinct dots (not one bloomed blob), and hold
 * reasonably steady so a fixed blob position stays on its LED across the capture.
 */
export async function captureAndDecode(video: HTMLVideoElement, opts: DecodeOpts): Promise<DecodeResult> {
  const bits = opts.bits, frameMs = opts.frameMs;
  const cycles = opts.cycles ?? 5;
  const captureMs = opts.captureMs ?? (2 + bits) * frameMs * cycles + frameMs; // device emits OFF + ON + bits
  const procWidth = opts.procWidth ?? 320;
  const noiseFloor = opts.noiseFloor ?? 12;
  const log = opts.onLog ?? (() => {});

  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < 12) return { points: [], ok: false, reason: 'too few camera frames captured' };
  const w = frames[0].w, h = frames[0].h, N = w * h, F = frames.length;
  log(`captured ${F} frames @ ${w}x${h}`);

  // Per-frame background (histogram median) → exposure-flat normalized value nv().
  const bg = new Float32Array(F);
  for (let fi = 0; fi < F; fi++) {
    const g = frames[fi].gray; const hist = new Int32Array(64);
    for (let i = 0; i < N; i++) hist[g[i] >> 2]++;
    let acc = 0, bin = 0; const half = N >> 1;
    for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= half) break; }
    bg[fi] = bin * 4 + 2;
  }
  const nv = (fi: number, i: number) => { const v = frames[fi].gray[i] - bg[fi] + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };

  // Per-pixel temporal swing → LED mask + per-pixel min (the dark/off level).
  const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
  for (let fi = 0; fi < F; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
  const range = new Uint8Array(N); let maxRange = 0;
  for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > maxRange) maxRange = r; }
  const maskIdx: number[] = []; for (let i = 0; i < N; i++) if (range[i] >= Math.max(noiseFloor, 0.35 * maxRange)) maskIdx.push(i);

  const debug: DecodeDebug = { w, h, range, blobs: [], decoded: [], frames: F, roiCount: maskIdx.length, maxRange };
  const diag: DecodeDiag = { found: 0, maskPx: maskIdx.length, maxRange, clippedPct: 0, outOfRangePct: 0, fill: maskFill(maskIdx, w, h), motionPx: 0, cyclesUsed: 0 };
  const fail = (reason: string): DecodeResult => ({ points: [], ok: false, reason, debug, diag });
  if (maxRange < noiseFloor) return fail('nothing in view is blinking — is the strip calibrating and in frame?');
  if (maskIdx.length < 8) return fail('blinking region too small — move closer / fill more of the frame');
  { let mc = 0; for (let fi = 0; fi < F; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] >= 250) c++; if (c > mc) mc = c; } diag.clippedPct = mc / maskIdx.length; }

  // ---- PASS 1: locate the LED blobs on a clean contrast image ----
  // Rough ON anchors (lit-pixel peaks) → onRef (avg ALL-ON); split active regions into bit refs;
  // offRef = min over bit refs. The bloom HALO between LEDs is lit in some bit frames, so its
  // min(bitRef) ≈ onRef → it cancels in onRef−offRef and only the LED cores remain as blobs.
  const litPx = new Int32Array(F);
  for (let fi = 0; fi < F; fi++) { let c = 0; for (const i of maskIdx) if (nv(fi, i) > 175) c++; litPx[fi] = c; }
  let maxLitPx = 0, onFrameIdx = 0; for (let fi = 0; fi < F; fi++) if (litPx[fi] > maxLitPx) { maxLitPx = litPx[fi]; onFrameIdx = fi; }
  debug.onImage = frames[onFrameIdx].gray;   // brightest (ALL-ON) frame → result overlay backdrop
  const onI1: [number, number][] = [];
  { let s = -1;
    for (let fi = 0; fi < F; fi++) { if (litPx[fi] >= 0.7 * maxLitPx) { if (s < 0) s = fi; } else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.4) onI1.push([s, fi - 1]); s = -1; } } }
  }
  const onRef = new Float32Array(N); let onPxCnt = 0;
  for (const [a, b] of onI1) { const sp = frames[b].t - frames[a].t || 1; for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / sp; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) onRef[i] += nv(fi, i); onPxCnt++; } }
  if (onPxCnt) for (const i of maskIdx) onRef[i] /= onPxCnt;
  const bitRef0 = Array.from({ length: bits }, () => new Float32Array(N)); const bc0 = new Int32Array(bits);
  for (let q = 0; q < onI1.length - 1; q++) {
    const aS = onI1[q][1] + 1, aE = onI1[q + 1][0] - 1, t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0;
    if (aE <= aS || dur < bits * 40) continue;
    for (let fi = aS; fi <= aE; fi++) { const f = ((frames[fi].t - t0) / dur) * bits, sl = Math.min(bits - 1, Math.floor(f)), fr = f - sl; if (fr < 0.2 || fr > 0.8) continue; for (const i of maskIdx) bitRef0[sl][i] += nv(fi, i); bc0[sl]++; }
  }
  for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef0[b][i] /= bc0[b] || 1;
  const offRef0 = new Float32Array(N); for (const i of maskIdx) { let mn = Infinity; for (let b = 0; b < bits; b++) if (bitRef0[b][i] < mn) mn = bitRef0[b][i]; offRef0[i] = onPxCnt ? mn : pmin[i]; }
  let maxContrast = 0; const cimg = new Uint8Array(N);
  for (const i of maskIdx) { const c = onRef[i] - offRef0[i]; cimg[i] = c <= 0 ? 0 : c > 255 ? 255 : c; if (c > maxContrast) maxContrast = c; }
  const blobs = detectBlobs(cimg, w, h, {
    thresh: Math.max(noiseFloor, 0.4 * maxContrast),
    minPx: opts.minBlobPx ?? Math.max(2, Math.round(N / 80000)),   // ~2px: a far/dense LED is a tiny dot
  });
  debug.blobs = blobs.map((b) => ({ x: b.x, y: b.y }));
  if (blobs.length < 2) return fail('no LED dots found — adjust brightness so the LEDs are distinct dots');
  const M = blobs.length;
  log(`located ${M} candidate LEDs`);

  // ---- PASS 2: per-blob, ALL-ON-anchored bit-code read ----
  // Sample each blob at (essentially) a single pixel on its centroid. A wider disc bleeds into
  // tightly-spaced neighbours on a dense grid and corrupts the bit read (validated: r=2 → ~50%
  // crosstalk loss on a 20×20, r=0 → clean). Only average a tiny core when blobs are clearly large.
  const blobNs = blobs.map((b) => b.n).sort((a, b) => a - b);
  const medN = blobNs[blobNs.length >> 1] || 1;
  const sampleR = medN > 24 ? 1 : 0;
  const discNv = (fi: number, cx: number, cy: number, r = sampleR) => {
    let s = 0, c = 0; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < w && y < h) { s += nv(fi, y * w + x); c++; } }
    return c ? s / c : 0;
  };
  // Each blob's brightness over time + its own lit threshold (midway between its min and max).
  const series: Float32Array[] = blobs.map((b) => { const a = new Float32Array(F); for (let fi = 0; fi < F; fi++) a[fi] = discNv(fi, b.x, b.y); return a; });
  const bMid = blobs.map((_, k) => { let mn = 255, mx = 0; for (let fi = 0; fi < F; fi++) { const v = series[k][fi]; if (v < mn) mn = v; if (v > mx) mx = v; } return (mn + mx) / 2; });
  const litBlob = new Int32Array(F);
  for (let fi = 0; fi < F; fi++) { let c = 0; for (let k = 0; k < M; k++) if (series[k][fi] > bMid[k]) c++; litBlob[fi] = c; }

  // ALL-ON anchor: the firmware sequence is [ALL-ON][bit0..bit(bits-1)] with NO dark frame, so we
  // anchor on the ALL-ON pulse (nearly every blob lit at once) — crisp and periodic regardless of
  // LED count. (Earlier OFF-anchoring failed on dense arrays, which never go dark enough to detect.)
  const litSorted = Array.from(litBlob).sort((a, b) => a - b);
  const litMax = litSorted[Math.floor(0.95 * (F - 1))] || M;
  const onThr = Math.max(0.6 * M, 0.82 * litMax);
  const onIntervals: [number, number][] = [];
  { let s = -1;
    for (let fi = 0; fi < F; fi++) {
      if (litBlob[fi] >= onThr) { if (s < 0) s = fi; }
      else { if (s >= 0) { onIntervals.push([s, fi - 1]); s = -1; } }
    }
    if (s >= 0) onIntervals.push([s, F - 1]);
  }
  // Cycle anchors = the start of each ALL-ON pulse (debounced against frame jitter).
  const onStarts: number[] = [];
  for (const [a] of onIntervals) { if (!onStarts.length || frames[a].t - frames[onStarts[onStarts.length - 1]].t > frameMs * 0.5) onStarts.push(a); }
  if (onStarts.length < 2) return fail('could not find the ALL-ON reference frames — hold steadier / capture more cycles');

  // Sub-slots per cycle, derived from the measured anchor period (median = robust to a missed pulse).
  // Current firmware is [ALL-ON][bit0..] (SUB=1+bits); a legacy build prepended a (long) [ALL-OFF], so
  // the ALL-ON→ALL-ON span is wider with trailing dark slots. Either way slots 1..bits are the bit
  // planes and slot 0 is ALL-ON, so deriving SUB decodes both without assuming the sequence length.
  const gaps: number[] = [];
  for (let q = 1; q < onStarts.length; q++) gaps.push(frames[onStarts[q]].t - frames[onStarts[q - 1]].t);
  gaps.sort((a, b) => a - b);
  const period = gaps[gaps.length >> 1] || (1 + bits) * frameMs;
  const SUB = Math.max(1 + bits, Math.round(period / frameMs));
  const onSum = new Float64Array(M); let onCnt = 0;
  const bitSum = Array.from({ length: bits }, () => new Float64Array(M)); const bitCnt = new Int32Array(bits);
  let cyclesUsed = 0;
  for (let q = 0; q < onStarts.length - 1; q++) {
    const aS = onStarts[q], aE = onStarts[q + 1] - 1;
    const t0 = frames[aS].t, dur = frames[aE + 1] ? frames[aE + 1].t - t0 : 0;
    if (aE <= aS || dur < period * 0.6 || dur > period * 1.4) continue;   // skip a span that swallowed a missed cycle
    cyclesUsed++;
    for (let fi = aS; fi <= aE; fi++) {
      const f = ((frames[fi].t - t0) / dur) * SUB;
      const sl = Math.min(SUB - 1, Math.floor(f)); const fr = f - sl;
      if (fr < 0.2 || fr > 0.8) continue;               // middle of the sub-slot only
      if (sl === 0) { for (let k = 0; k < M; k++) onSum[k] += series[k][fi]; onCnt++; }
      else if (sl - 1 < bits) { for (let k = 0; k < M; k++) bitSum[sl - 1][k] += series[k][fi]; bitCnt[sl - 1]++; }
    }
  }
  diag.cyclesUsed = cyclesUsed;
  if (!cyclesUsed || !onCnt || bitCnt.some((c) => c === 0)) return fail('capture too short — missed calibration frames (hold steadier)');
  const onAvg = onSum.map((v) => v / onCnt);
  const bitAvg = bitSum.map((bs, b) => bs.map((v) => v / bitCnt[b]));

  const numLeds = opts.numLeds ?? (1 << bits);
  const byIdx = new Map<number, { x: number; y: number; contrast: number }>();
  let decodedN = 0, oorN = 0;
  for (let k = 0; k < M; k++) {
    const on = onAvg[k]; let off = Infinity; for (let b = 0; b < bits; b++) if (bitAvg[b][k] < off) off = bitAvg[b][k];
    // Per-blob contrast floor (× the blob's own ALL-ON level), not a single global cutoff — on a dim
    // capture a few bright blobs would otherwise inflate a global threshold and reject the dim majority.
    const c = on - off; if (c < Math.max(3, 0.12 * on)) continue;
    const mid = (on + off) / 2; let idx = 0;
    for (let b = 0; b < bits; b++) if (bitAvg[b][k] > mid) idx |= (1 << b);
    decodedN++;
    if (idx >= numLeds) { oorN++; continue; }
    const prev = byIdx.get(idx);
    if (!prev || c > prev.contrast) byIdx.set(idx, { x: blobs[k].x, y: blobs[k].y, contrast: c });
  }
  diag.outOfRangePct = decodedN ? oorN / decodedN : 0;
  // Normalize x and y by the SAME factor (width) so aspect ratio is preserved — otherwise a
  // square LED grid becomes non-square in point space and the lattice fitter mis-counts rows.
  const pts: (Pt | null)[] = new Array(numLeds).fill(null);
  let found = 0;
  for (const [idx, b] of byIdx) { pts[idx] = { x: b.x / w, y: b.y / w }; debug.decoded.push({ x: b.x, y: b.y, idx }); found++; }
  diag.found = found;
  let last = pts.length - 1; while (last >= 0 && pts[last] === null) last--;
  const out = pts.slice(0, last + 1);
  if (!found) return fail('LED dots found but none decoded — try adjusting brightness, then Map again');
  log(`decoded ${found}/${numLeds} LEDs`);
  return { points: out, ok: true, reason: `decoded ${found}/${numLeds} LEDs`, debug, diag };
}

// Bounding-box fill ratio of a binary mask = litPx / bboxArea. THE bloom metric: well-exposed
// LEDs are distinct dots with dark gaps (low fill ~0.05-0.15); bloomed LEDs merge into a solid
// filled blob (high fill ~0.3+). Validated on real captures (good=0.06, bloomed=0.34).
function maskFill(maskIdx: number[], w: number, h: number): number {
  if (!maskIdx.length) return 0;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (const i of maskIdx) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return maskIdx.length / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
}
