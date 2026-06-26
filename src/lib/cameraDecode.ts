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
  cycles?: number;        // how many full flash cycles to capture (default 3)
  captureMs?: number;     // total capture window (default cycles × period + 1 frame)
  procWidth?: number;     // downscale width for processing (default 200; higher separates merged dots)
  relThr?: number;        // detection threshold as a FRACTION of the observed swing, 0..1 (default 0.4).
                          // Lower = more sensitive. This is the differential/adaptive knob — no
                          // absolute brightness, so a dark background isn't required.
  noiseFloor?: number;    // absolute min swing to count as "blinking" (reject sensor noise; default 12)
  minBlobPx?: number;     // min connected pixels for an LED blob (default ~N/20000; lower splits merges)
  onLog?: (m: string) => void;
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
export type DecodeResult = { points: (Pt | null)[]; ok: boolean; reason: string; debug?: DecodeDebug };

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
  const slots = 2 + bits;                       // [OFF][ON][bit0..]
  const cycles = opts.cycles ?? 4;
  // The device holds OFF longer than other slots, so a cycle runs longer than slots×frameMs.
  // Capture generously (2× nominal) so we get the requested number of full cycles.
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
  const fail = (reason: string): DecodeResult => ({ points: [], ok: false, reason, debug });
  if (maxRange < noiseFloor) return fail('nothing in view is blinking — is the strip calibrating and in frame?');

  const maskThr = Math.max(noiseFloor, relThr * maxRange);
  const maskIdx: number[] = [];
  for (let i = 0; i < N; i++) if (range[i] >= maskThr) maskIdx.push(i);
  debug.roiCount = maskIdx.length;
  if (maskIdx.length < (opts.minBlobPx ?? 3)) return fail('blinking region too small — move closer / fill more of the frame');

  // (3) Recover timing: count lit mask-pixels per frame, find the long dark OFF intervals,
  // and treat the frames between them as one ACTIVE region = [ON][bit0..bit(bits-1)].
  const litC = new Int32Array(F);
  for (let fi = 0; fi < F; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] - bg[fi] + 128 > 175) c++; litC[fi] = c; }
  let maxLit = 0; for (let fi = 0; fi < F; fi++) if (litC[fi] > maxLit) maxLit = litC[fi];
  const offThr = 0.2 * maxLit;
  const offInt: [number, number][] = [];
  { let s = -1;
    for (let fi = 0; fi < F; fi++) {
      if (litC[fi] < offThr) { if (s < 0) s = fi; }
      else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.6) offInt.push([s, fi - 1]); s = -1; } }
    }
    if (s >= 0 && frames[F - 1].t - frames[s].t > frameMs * 0.6) offInt.push([s, F - 1]);
  }
  if (offInt.length < 2) return fail('could not find the OFF reference frames — capture more cycles / hold steadier');

  // Accumulate per-pixel reference images. offRef from the OFF intervals; ON + each bit from the
  // matching sub-slot of every active region (use the middle of each window to dodge transitions).
  const SUB = bits + 1;
  const offRef = new Float32Array(N), onRef = new Float32Array(N);
  const bitRef = Array.from({ length: bits }, () => new Float32Array(N));
  let offCnt = 0; const subCnt = new Int32Array(SUB);
  for (const [a, b] of offInt) {
    const span = frames[b].t - frames[a].t || 1;
    for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / span; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) offRef[i] += nv(fi, i); offCnt++; }
  }
  let cyclesUsed = 0;
  for (let k = 0; k < offInt.length - 1; k++) {
    const aS = offInt[k][1] + 1, aE = offInt[k + 1][0] - 1;
    const t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0;
    if (aE <= aS || dur < SUB * 40) continue;
    cyclesUsed++;
    for (let fi = aS; fi <= aE; fi++) {
      const f = ((frames[fi].t - t0) / dur) * SUB;
      const s = Math.min(SUB - 1, Math.floor(f));
      const fr = f - s; if (fr < 0.2 || fr > 0.8) continue;   // middle of the sub-slot only
      const tgt = s === 0 ? onRef : bitRef[s - 1];
      for (const i of maskIdx) tgt[i] += nv(fi, i);
      subCnt[s]++;
    }
  }
  if (!cyclesUsed || subCnt.some((c) => c === 0)) return fail('capture too short — missed calibration frames (raise cycles / hold steadier)');
  for (const i of maskIdx) { offRef[i] /= offCnt || 1; onRef[i] /= subCnt[0]; }
  for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef[b][i] /= subCnt[b + 1];
  log(`${cyclesUsed} cycles, ${maskIdx.length} strip px, swing ${maxRange}`);

  // (4) Per-pixel decode, then cluster pixels by their decoded index → one centroid per LED.
  let maxContrast = 0; for (const i of maskIdx) { const c = onRef[i] - offRef[i]; if (c > maxContrast) maxContrast = c; }
  const contrastThr = Math.max(noiseFloor, 0.25 * maxContrast);
  const codes = 1 << bits;
  const sumX = new Float64Array(codes), sumY = new Float64Array(codes), sumW = new Float64Array(codes), cnt = new Int32Array(codes);
  for (const i of maskIdx) {
    const c = onRef[i] - offRef[i];
    if (c < contrastThr) continue;                       // not on a lit LED
    const mid = (onRef[i] + offRef[i]) / 2;
    let idx = 0;
    for (let b = 0; b < bits; b++) if (bitRef[b][i] > mid) idx |= (1 << b);
    const x = i % w, y = (i / w) | 0;
    sumX[idx] += x * c; sumY[idx] += y * c; sumW[idx] += c; cnt[idx]++;
  }
  const minCluster = opts.minBlobPx ?? Math.max(2, Math.round(maskIdx.length / 600));
  const pts: (Pt | null)[] = new Array(codes).fill(null);
  let found = 0;
  for (let idx = 0; idx < codes; idx++) {
    if (cnt[idx] >= minCluster && sumW[idx] > 0) {
      const cx = sumX[idx] / sumW[idx], cy = sumY[idx] / sumW[idx];
      pts[idx] = { x: cx / w, y: cy / h };
      debug.decoded.push({ x: cx, y: cy, idx });
      found++;
    }
  }
  // Trim trailing gaps (indices beyond the highest decoded LED carry no information).
  let last = pts.length - 1; while (last >= 0 && pts[last] === null) last--;
  const out = pts.slice(0, last + 1);
  if (!found) return fail('strip found but no LEDs decoded — try dimmer calibration brightness / lower sensitivity');
  log(`decoded ${found} LEDs`);
  return { points: out, ok: true, reason: `decoded ${found} LEDs`, debug };
}
