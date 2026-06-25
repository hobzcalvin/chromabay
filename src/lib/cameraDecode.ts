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
  captureMs?: number;     // total capture window (default ~2 cycles)
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

/** Decode the calibration burst into points[ledIndex] = {x,y} in [0,1]. Best-effort. */
export async function captureAndDecode(video: HTMLVideoElement, opts: DecodeOpts): Promise<Pt[]> {
  const bits = opts.bits;
  const frameMs = opts.frameMs;
  const captureMs = opts.captureMs ?? (2 + bits) * frameMs * 2 + frameMs;
  const procWidth = opts.procWidth ?? 200;
  const thr = opts.threshold ?? 40;
  const log = opts.onLog ?? (() => {});

  const frames = await captureBurst(video, captureMs, procWidth);
  if (frames.length < bits + 2) { log('too few frames captured'); return []; }
  const w = frames[0].w, h = frames[0].h;
  log(`captured ${frames.length} frames @ ${w}x${h}`);

  // Find the ALL-ON (brightest) and ALL-OFF (darkest) reference frames.
  let onIdx = 0, offIdx = 0, onL = -1, offL = Infinity;
  const lums = frames.map(totalLum);
  for (let i = 0; i < frames.length; i++) { if (lums[i] > onL) { onL = lums[i]; onIdx = i; } if (lums[i] < offL) { offL = lums[i]; offIdx = i; } }
  const onF = frames[onIdx], offF = frames[offIdx];

  // LED blobs = pixels much brighter in ON than OFF.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = (onF.gray[i] - offF.gray[i]) > thr ? 1 : 0;
  const cand = blobs(mask, w, h, Math.max(1, Math.round((w * h) / 20000)));
  log(`found ${cand.length} candidate LED blobs`);
  if (!cand.length) return [];

  // Locate the bit-frames: the device holds each frame ~frameMs, so after the ON frame the
  // next `bits` held frames are bit0..bit(bits-1). Pick the captured frame nearest each
  // expected time onF.t + frameMs*(k+1).
  const bitFrames: Frame[] = [];
  for (let k = 0; k < bits; k++) {
    const target = onF.t + frameMs * (k + 1);
    let best = frames[0], bd = Infinity;
    for (const f of frames) { const d = Math.abs(f.t - target); if (d < bd) { bd = d; best = f; } }
    bitFrames.push(best);
  }

  // Decode each blob's index; keep the brightest blob per index.
  const mid = (cx: number, cy: number) => (sampleAt(onF, cx, cy) + sampleAt(offF, cx, cy)) / 2;
  const byIndex = new Map<number, { x: number; y: number; px: number }>();
  for (const b of cand) {
    const m = mid(b.x, b.y);
    let idx = 0;
    for (let k = 0; k < bits; k++) if (sampleAt(bitFrames[k], b.x, b.y) > m) idx |= (1 << k);
    const prev = byIndex.get(idx);
    if (!prev || b.px > prev.px) byIndex.set(idx, b);
  }
  log(`decoded ${byIndex.size} distinct LED indices`);

  // Assemble points[ledIndex] normalized to [0,1].
  const maxIdx = Math.max(...byIndex.keys());
  const pts: Pt[] = new Array(maxIdx + 1).fill(null).map(() => ({ x: 0, y: 0 }));
  for (const [idx, b] of byIndex) pts[idx] = { x: b.x / w, y: b.y / h };
  return pts;
}
