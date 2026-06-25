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
  frameMs: number;        // device CALIB_FRAME_MS (220)
  cycles?: number;        // how many full flash cycles to capture (default 3)
  captureMs?: number;     // total capture window (default cycles × period + 1 frame)
  procWidth?: number;     // downscale width for processing (default 200)
  threshold?: number;     // ON luminance threshold over background, 0..255 (default 40)
  onLog?: (m: string) => void;
};

type Frame = { t: number; gray: Uint8Array; w: number; h: number };

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
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      frames.push({ t: performance.now() - t0, gray, w, h });
      if (performance.now() - t0 < captureMs) requestAnimationFrame(grab);
      else resolve(frames);
    };
    requestAnimationFrame(grab);
  });
}

function totalLum(f: Frame): number { let s = 0; for (let i = 0; i < f.gray.length; i++) s += f.gray[i]; return s; }

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
export type DecodeResult = { points: Pt[]; ok: boolean; reason: string };

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
  const thr = opts.threshold ?? 45;
  const log = opts.onLog ?? (() => {});

  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < slots) return { points: [], ok: false, reason: 'too few camera frames captured' };
  const w = frames[0].w, h = frames[0].h, N = w * h;
  log(`captured ${frames.length} frames @ ${w}x${h}`);

  // Global flash check: a real calibrating strip makes total luminance swing strongly between
  // its ALL-OFF and ALL-ON frames. A static scene (no LEDs) barely varies → bail early.
  const lums = frames.map(totalLum);
  const maxL = Math.max(...lums), minL = Math.min(...lums), avgL = lums.reduce((a, b) => a + b, 0) / lums.length;
  if (avgL <= 0 || (maxL - minL) / avgL < 0.06) {
    return { points: [], ok: false, reason: 'no flashing strip seen (scene barely changed) — is the lit strip filling the frame?' };
  }

  // Phase anchor: the darkest frame is an ALL-OFF reference (phase 0).
  const offAnchorT = frames[lums.indexOf(minL)].t;
  // Per-slot averaged grayscale image (fold all cycles into one period).
  const slotSum = Array.from({ length: slots }, () => new Float32Array(N));
  const slotCnt = new Array(slots).fill(0);
  for (const f of frames) {
    let ph = (f.t - offAnchorT) % cyclePeriod; if (ph < 0) ph += cyclePeriod;
    const slot = Math.min(slots - 1, Math.floor(ph / frameMs));
    const acc = slotSum[slot];
    for (let i = 0; i < N; i++) acc[i] += f.gray[i];
    slotCnt[slot]++;
  }
  if (slotCnt.some((c) => c === 0)) return { points: [], ok: false, reason: 'capture too short — some calibration frames were missed' };
  const slotAvg = slotSum.map((s, k) => { const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = s[i] / slotCnt[k]; return a; });
  const offA = slotAvg[0], onA = slotAvg[1];

  // LED blobs = pixels clearly brighter in the averaged ON slot than the OFF slot.
  let maxDelta = 0;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const d = onA[i] - offA[i]; if (d > maxDelta) maxDelta = d; mask[i] = d > thr ? 1 : 0; }
  if (maxDelta < thr) return { points: [], ok: false, reason: 'no LEDs detected (nothing lit up in sync)' };
  const cand = blobs(mask, w, h, Math.max(1, Math.round(N / 20000)));
  log(`found ${cand.length} candidate LED blobs`);
  if (!cand.length) return { points: [], ok: false, reason: 'no LED-sized bright spots found' };

  const sampleSlot = (k: number, cx: number, cy: number) => sampleAt({ gray: slotAvg[k], w, h, t: 0 }, cx, cy);
  const byIndex = new Map<number, { x: number; y: number; px: number; conf: number }>();
  for (const b of cand) {
    const on = sampleSlot(1, b.x, b.y), off = sampleSlot(0, b.x, b.y);
    if (on - off < thr * 0.6) continue;          // weak/uncertain blob → likely noise, skip
    const mid = (on + off) / 2;
    let idx = 0;
    for (let k = 0; k < bits; k++) if (sampleSlot(2 + k, b.x, b.y) > mid) idx |= (1 << k);
    const prev = byIndex.get(idx);
    if (!prev || b.px > prev.px) byIndex.set(idx, { x: b.x, y: b.y, px: b.px, conf: on - off });
  }
  if (!byIndex.size) return { points: [], ok: false, reason: 'LED blobs found but none decoded confidently' };
  log(`decoded ${byIndex.size} distinct LED indices`);

  const maxIdx = Math.max(...byIndex.keys());
  const pts: Pt[] = new Array(maxIdx + 1).fill(null).map(() => ({ x: 0, y: 0 }));
  for (const [idx, b] of byIndex) pts[idx] = { x: b.x / w, y: b.y / h };
  return { points: pts, ok: true, reason: `decoded ${byIndex.size} LEDs` };
}
