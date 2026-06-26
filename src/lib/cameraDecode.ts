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

// Connected-component centroids of a binary mask (4-connectivity, iterative flood fill).
function blobs(mask: Uint8Array, w: number, h: number, minPx: number): { x: number; y: number; px: number }[] {
  const seen = new Uint8Array(w * h);
  const out: { x: number; y: number; px: number }[] = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    stack.length = 0; stack.push(p0); seen[p0] = 1;
    let sx = 0, sy = 0, n = 0;
    while (stack.length) {
      const p = stack.pop()!; const x = p % w, y = (p / w) | 0;
      sx += x; sy += y; n++;
      const nb = [p - 1, p + 1, p - w, p + w];
      if (x > 0 && mask[nb[0]] && !seen[nb[0]]) { seen[nb[0]] = 1; stack.push(nb[0]); }
      if (x < w - 1 && mask[nb[1]] && !seen[nb[1]]) { seen[nb[1]] = 1; stack.push(nb[1]); }
      if (y > 0 && mask[nb[2]] && !seen[nb[2]]) { seen[nb[2]] = 1; stack.push(nb[2]); }
      if (y < h - 1 && mask[nb[3]] && !seen[nb[3]]) { seen[nb[3]] = 1; stack.push(nb[3]); }
    }
    if (n >= minPx) out.push({ x: sx / n, y: sy / n, px: n });
  }
  return out;
}

function sampleAt(f: Frame, cx: number, cy: number, r = 2): number {
  let s = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(cx) + dx, y = Math.round(cy) + dy;
    if (x >= 0 && y >= 0 && x < f.w && y < f.h) { s += f.gray[y * f.w + x]; n++; }
  }
  return n ? s / n : 0;
}

/** What a decode produced (or why it didn't). points is empty unless LEDs were confidently seen. */
export type DecodeResult = { points: (Pt | null)[]; ok: boolean; reason: string; debug?: DecodeDebug };

/**
 * Decode the calibration burst. Captures several cycles, folds frames by cycle PHASE (so
 * which cycle a frame lands in doesn't matter) and averages per slot — robust to camera/
 * device framerate mismatch and noise. Gates on real ON-vs-OFF contrast both globally
 * (did a strip actually flash?) and per-blob (is this a real LED or sensor noise?), so an
 * empty/no-LED frame returns ok:false instead of fabricating a layout.
 */
export async function captureAndDecode(video: HTMLVideoElement, opts: DecodeOpts): Promise<DecodeResult> {
  const bits = opts.bits;
  const frameMs = opts.frameMs;
  const slots = 2 + bits;                       // [OFF][ON][bit0..]
  const cyclePeriod = slots * frameMs;
  const cycles = opts.cycles ?? 3;
  const captureMs = opts.captureMs ?? cyclePeriod * cycles + frameMs;
  const procWidth = opts.procWidth ?? 200;
  const relThr = opts.relThr ?? 0.4;
  const noiseFloor = opts.noiseFloor ?? 12;
  const log = opts.onLog ?? (() => {});

  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < slots) return { points: [], ok: false, reason: 'too few camera frames captured' };
  const w = frames[0].w, h = frames[0].h, N = w * h;
  const minBlobPx = opts.minBlobPx ?? Math.max(1, Math.round(N / 20000));
  log(`captured ${frames.length} frames @ ${w}x${h}`);

  // A bright flashing matrix makes the webcam restop its auto-exposure, so the WHOLE frame
  // pulses with the calibration. Cancel that: per frame, subtract a robust background level
  // (its median via a 64-bin histogram) so a global exposure swing → ~0 and only LOCAL
  // changes (the LEDs) remain. `nv()` = background-normalized brightness (centered at 128).
  const bg = new Float32Array(frames.length);
  for (let fi = 0; fi < frames.length; fi++) {
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

  // Per-pixel temporal swing of the NORMALIZED frames. LED pixels swing locally → big range;
  // background (now exposure-flat) → ~0.
  const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
  for (let fi = 0; fi < frames.length; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
  const range = new Uint8Array(N);
  let maxRange = 0;
  for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > maxRange) maxRange = r; }
  const debug: DecodeDebug = { w, h, range, blobs: [], decoded: [], frames: frames.length, roiCount: 0, maxRange };
  const fail = (reason: string): DecodeResult => ({ points: [], ok: false, reason, debug });

  if (maxRange < noiseFloor) return fail('nothing in view is blinking — is the strip calibrating and in frame?');

  // Detect LEDs straight from the RANGE image (phase-independent — robust): pixels swinging
  // more than a fraction of the strongest swing. This is the region AND the blob source.
  const roiThr = Math.max(noiseFloor, relThr * maxRange);
  const mask = new Uint8Array(N);
  let roiCount = 0;
  for (let i = 0; i < N; i++) if (range[i] >= roiThr) { mask[i] = 1; roiCount++; }
  debug.roiCount = roiCount;
  if (roiCount < minBlobPx) return fail('blinking region too small — move closer / fill more of the frame');
  const cand = blobs(mask, w, h, minBlobPx);
  debug.blobs = cand.map((b) => ({ x: b.x, y: b.y }));
  log(`${roiCount} blinking px, ${cand.length} LED blobs, maxSwing ${maxRange}`);
  if (!cand.length) return fail('no LED-sized spots found (try lower min-blob / higher resolution)');

  // Reference/phase from the blinking pixels only: brightest (normalized) = ALL-ON; darkest
  // = ALL-OFF (= phase-0 anchor).
  const roiSum = (fi: number) => { let s = 0; for (let i = 0; i < N; i++) if (mask[i]) s += nv(fi, i); return s; };
  let offAnchorT = 0, minRoi = Infinity;
  for (let fi = 0; fi < frames.length; fi++) { const s = roiSum(fi); if (s < minRoi) { minRoi = s; offAnchorT = frames[fi].t; } }
  // Per-slot averaged NORMALIZED image (fold all cycles into one period) for bit decoding.
  const slotSum = Array.from({ length: slots }, () => new Float32Array(N));
  const slotCnt = new Array(slots).fill(0);
  for (let fi = 0; fi < frames.length; fi++) {
    let ph = (frames[fi].t - offAnchorT) % cyclePeriod; if (ph < 0) ph += cyclePeriod;
    const slot = Math.min(slots - 1, Math.floor(ph / frameMs));
    const a = slotSum[slot];
    for (let i = 0; i < N; i++) a[i] += nv(fi, i);
    slotCnt[slot]++;
  }
  if (slotCnt.some((c) => c === 0)) return fail('capture too short — some calibration frames were missed (raise cycles)');
  const slotAvg = slotSum.map((s, k) => { const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = s[i] / slotCnt[k]; return a; });

  const sampleSlot = (k: number, cx: number, cy: number) => sampleAt({ gray: slotAvg[k], w, h, t: 0 }, cx, cy);
  const byIndex = new Map<number, { x: number; y: number; px: number; conf: number }>();
  for (const b of cand) {
    const on = sampleSlot(1, b.x, b.y), off = sampleSlot(0, b.x, b.y);
    if (on - off < noiseFloor) continue;               // blob shows no clear on/off → skip
    const mid = (on + off) / 2;                        // per-LED midpoint; the background cancels
    let idx = 0;
    for (let k = 0; k < bits; k++) if (sampleSlot(2 + k, b.x, b.y) > mid) idx |= (1 << k);
    const prev = byIndex.get(idx);
    if (!prev || b.px > prev.px) byIndex.set(idx, { x: b.x, y: b.y, px: b.px, conf: on - off });
  }
  debug.decoded = [...byIndex].map(([idx, b]) => ({ x: b.x, y: b.y, idx }));
  if (!byIndex.size) return fail('LED blobs found but none decoded confidently');
  log(`decoded ${byIndex.size} distinct LED indices`);

  // Sparse by LED index: UNDECODED LEDs are null (a gap), NOT (0,0) — otherwise every LED we
  // failed to read would pile into the top-left corner and look like a real cluster.
  const maxIdx = Math.max(...byIndex.keys());
  const pts: (Pt | null)[] = new Array(maxIdx + 1).fill(null);
  for (const [idx, b] of byIndex) pts[idx] = { x: b.x / w, y: b.y / h };
  return { points: pts, ok: true, reason: `decoded ${byIndex.size} LEDs`, debug };
}
