#!/usr/bin/env node
// Offline decode harness for a recorded calibration capture (the .bin the Auto-map "Record"
// button downloads). Lets us iterate the LED-mapping decode against REAL footage with ground
// truth, instead of guessing from screenshots. Prints an ASCII heatmap of the temporal-range
// image + detected/decoded LEDs and the derived ledmap.
//
//   node automation/decode-capture.mjs <capture.bin> [relThr] [minBlobPx]
//
// .bin format: 'CBC1', u16 w,h,bits,frameMs,numLeds,frameCount (LE), then per frame:
//              f32 t (LE) + w*h grayscale bytes (max-channel brightness).
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node automation/decode-capture.mjs <capture.bin> [relThr] [minBlobPx]'); process.exit(1); }
const relThr = process.argv[3] ? parseFloat(process.argv[3]) : 0.5;
const minBlobPxArg = process.argv[4] ? parseInt(process.argv[4]) : null;

const buf = readFileSync(path);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, false) !== 0x43424331) { console.error('not a CBC1 capture'); process.exit(1); }
const w = dv.getUint16(4, true), h = dv.getUint16(6, true), bits = dv.getUint16(8, true);
const frameMs = dv.getUint16(10, true), numLeds = dv.getUint16(12, true), n = dv.getUint16(14, true);
const N = w * h, slots = 2 + bits, cyclePeriod = slots * frameMs;
const minBlobPx = minBlobPxArg ?? Math.max(1, Math.round(N / 20000));
console.log(`capture: ${w}x${h}, ${n} frames, bits=${bits}, frameMs=${frameMs}, numLeds=${numLeds}, relThr=${relThr}, minBlobPx=${minBlobPx}`);

const frames = [];
let off = 16;
for (let i = 0; i < n; i++) {
  const t = dv.getFloat32(off, true); off += 4;
  const gray = new Uint8Array(buf.buffer, buf.byteOffset + off, N); off += N;
  frames.push({ t, gray });
}

// --- per-frame background level (histogram median) for exposure normalization ---
const bg = new Float32Array(n);
for (let fi = 0; fi < n; fi++) {
  const g = frames[fi].gray, hist = new Int32Array(64);
  for (let i = 0; i < N; i++) hist[g[i] >> 2]++;
  let acc = 0, bin = 0; const half = N >> 1;
  for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= half) break; }
  bg[fi] = bin * 4 + 2;
}
const nv = (fi, i) => { const v = frames[fi].gray[i] - bg[fi] + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };

// --- temporal range of normalized frames ---
const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
for (let fi = 0; fi < n; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
const range = new Uint8Array(N);
let maxRange = 0;
for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > maxRange) maxRange = r; }
console.log(`maxRange=${maxRange}`);

// --- ASCII heatmap of the range image (downscaled) ---
function ascii(img, label, marks = []) {
  const cols = 64, rows = Math.round(cols * h / w / 2);
  const chars = ' .:-=+*#%@';
  const markSet = new Set(marks.map((m) => `${Math.round(m.x / w * cols)},${Math.round(m.y / h * rows)}`));
  console.log(`\n${label} (${w}x${h} -> ${cols}x${rows}):`);
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      if (markSet.has(`${rx},${ry}`)) { line += 'O'; continue; }
      const x0 = Math.floor(rx / cols * w), x1 = Math.floor((rx + 1) / cols * w);
      const y0 = Math.floor(ry / rows * h), y1 = Math.floor((ry + 1) / rows * h);
      let mx = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mx = Math.max(mx, img[y * w + x]);
      line += chars[Math.min(chars.length - 1, Math.floor(mx / 256 * chars.length))];
    }
    console.log(line);
  }
}

// --- connected-component blobs on a mask ---
function blobs(mask, minPx) {
  const seen = new Uint8Array(N), out = [], st = [];
  for (let p0 = 0; p0 < N; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    st.length = 0; st.push(p0); seen[p0] = 1; let sx = 0, sy = 0, c = 0;
    while (st.length) {
      const p = st.pop(), x = p % w, y = (p / w) | 0; sx += x; sy += y; c++;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; st.push(q); }
    }
    if (c >= minPx) out.push({ x: sx / c, y: sy / c, px: c });
  }
  return out;
}

const roiThr = Math.max(12, relThr * maxRange);
const mask = new Uint8Array(N);
let roiCount = 0;
for (let i = 0; i < N; i++) if (range[i] >= roiThr) { mask[i] = 1; roiCount++; }
const cand = blobs(mask, minBlobPx);
console.log(`roiThr=${roiThr.toFixed(0)}, blinking px=${roiCount}, blobs=${cand.length}`);

ascii(range, 'TEMPORAL RANGE  (O = detected blob)', cand);

// --- phase + bit decode (so we can see how many indices decode) ---
const roiSum = (fi) => { let s = 0; for (let i = 0; i < N; i++) if (mask[i]) s += nv(fi, i); return s; };
let offT = 0, minR = Infinity;
for (let fi = 0; fi < n; fi++) { const s = roiSum(fi); if (s < minR) { minR = s; offT = frames[fi].t; } }
const slotSum = Array.from({ length: slots }, () => new Float32Array(N)), slotCnt = new Array(slots).fill(0);
for (let fi = 0; fi < n; fi++) {
  let ph = (frames[fi].t - offT) % cyclePeriod; if (ph < 0) ph += cyclePeriod;
  const s = Math.min(slots - 1, Math.floor(ph / frameMs)); const a = slotSum[s];
  for (let i = 0; i < N; i++) a[i] += nv(fi, i); slotCnt[s]++;
}
console.log('slot frame counts:', slotCnt.join(','));
const slotAvg = slotSum.map((s, k) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = s[i] / (slotCnt[k] || 1); return a; });
const samp = (img, cx, cy) => { let s = 0, c = 0; const r = 2; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = Math.round(cx) + dx, y = Math.round(cy) + dy; if (x >= 0 && y >= 0 && x < w && y < h) { s += img[y * w + x]; c++; } } return c ? s / c : 0; };
const byIdx = new Map();
for (const b of cand) {
  const on = samp(slotAvg[1], b.x, b.y), o = samp(slotAvg[0], b.x, b.y);
  if (on - o < 12) continue;
  const mid = (on + o) / 2; let idx = 0;
  for (let k = 0; k < bits; k++) if (samp(slotAvg[2 + k], b.x, b.y) > mid) idx |= (1 << k);
  if (!byIdx.has(idx) || b.px > byIdx.get(idx).px) byIdx.set(idx, b);
}
console.log(`decoded ${byIdx.size}/${numLeds} distinct indices: [${[...byIdx.keys()].sort((a, b) => a - b).join(',')}]`);
