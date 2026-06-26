#!/usr/bin/env node
// Offline decode harness for a recorded calibration capture (the .bin the Auto-map "Record"
// button downloads). Mirrors src/lib/cameraDecode.ts captureAndDecode(): ON-anchored timing,
// per-pixel OFF derived from the bit frames, translation registration for handheld motion,
// per-pixel decode + cluster-by-code.
//
//   node automation/decode-capture.mjs <capture.bin> [relThr] [minCluster]
//
// .bin format ('CBC1'): u16 w,h,bits,frameMs,numLeds,frameCount (LE), then per frame:
//   f32 t (LE) + w*h grayscale bytes. Sequence per cycle is [ALL-ON][bit0..bit(bits-1)].
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node automation/decode-capture.mjs <capture.bin> [relThr] [minCluster]'); process.exit(1); }
const relThr = process.argv[3] ? parseFloat(process.argv[3]) : 0.35;
const minClusterArg = process.argv[4] ? parseInt(process.argv[4]) : null;

const buf = readFileSync(path);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, false) !== 0x43424331) { console.error('not a CBC1 capture'); process.exit(1); }
const w = dv.getUint16(4, true), h = dv.getUint16(6, true), bits = dv.getUint16(8, true);
const frameMs = dv.getUint16(10, true), numLeds = dv.getUint16(12, true), n = dv.getUint16(14, true);
const N = w * h;
console.log(`capture: ${w}x${h}, ${n} frames, bits=${bits}, frameMs=${frameMs}, numLeds=${numLeds}, relThr=${relThr}`);

const frames = [];
let off = 16;
for (let i = 0; i < n; i++) { const t = dv.getFloat32(off, true); off += 4; frames.push({ t, gray: new Uint8Array(buf.buffer, buf.byteOffset + off, N) }); off += N; }

// (1) per-frame background (histogram median) -> normalized value
const bg = new Float32Array(n);
for (let fi = 0; fi < n; fi++) { const g = frames[fi].gray, hi = new Int32Array(64); for (let i = 0; i < N; i++) hi[g[i] >> 2]++; let a = 0, b = 0; for (; b < 64; b++) { a += hi[b]; if (a >= N >> 1) break; } bg[fi] = b * 4 + 2; }
const nv = (fi, i) => { const v = frames[fi].gray[i] - bg[fi] + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };

// (2) LED mask from temporal swing
const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
for (let fi = 0; fi < n; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
let maxRange = 0; for (let i = 0; i < N; i++) maxRange = Math.max(maxRange, pmax[i] - pmin[i]);
const maskIdx = []; for (let i = 0; i < N; i++) if (pmax[i] - pmin[i] >= Math.max(12, relThr * maxRange)) maskIdx.push(i);
let peakSat = 0; for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] >= 250) c++; peakSat = Math.max(peakSat, c); }
const satPct = maskIdx.length ? (peakSat / maskIdx.length * 100) : 0;
console.log(`maxRange=${maxRange} maskPx=${maskIdx.length} clipped=${satPct.toFixed(0)}%${satPct > 25 ? ' <-- OVER-EXPOSED' : ''}`);

// (3) ON intervals (all LEDs lit -> lit-count peaks)
const litC = new Int32Array(n);
for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] - bg[fi] + 128 > 175) c++; litC[fi] = c; }
let maxLit = 0; for (const c of litC) maxLit = Math.max(maxLit, c);
const onInt = []; { let s = -1; for (let fi = 0; fi < n; fi++) { if (litC[fi] >= 0.7 * maxLit) { if (s < 0) s = fi; } else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.4) onInt.push([s, fi - 1]); s = -1; } } } if (s >= 0 && frames[n - 1].t - frames[s].t > frameMs * 0.4) onInt.push([s, n - 1]); }
console.log(`ON intervals: ${onInt.map(([a, b]) => `${frames[a].t.toFixed(0)}-${frames[b].t.toFixed(0)}`).join(' ') || '(none!)'}`);
if (onInt.length < 2) { console.error('FAIL: need >=2 ALL-ON anchors.'); process.exit(2); }

// translation registration from ON-frame centroids
const onCent = onInt.map(([a, b]) => { let sx = 0, sy = 0, sw = 0; for (let fi = a; fi <= b; fi++) for (const i of maskIdx) { const v = nv(fi, i); if (v > 170) { sx += (i % w) * v; sy += ((i / w) | 0) * v; sw += v; } } return { t: (frames[a].t + frames[b].t) / 2, x: sw ? sx / sw : 0, y: sw ? sy / sw : 0 }; });
const refX = onCent[0].x, refY = onCent[0].y; let motionPx = 0; for (const c of onCent) motionPx = Math.max(motionPx, Math.hypot(c.x - refX, c.y - refY));
const shiftAt = (t) => { let cx = onCent[0].x, cy = onCent[0].y; if (t >= onCent[onCent.length - 1].t) { cx = onCent[onCent.length - 1].x; cy = onCent[onCent.length - 1].y; } else if (t > onCent[0].t) for (let k = 0; k < onCent.length - 1; k++) if (t >= onCent[k].t && t <= onCent[k + 1].t) { const f = (t - onCent[k].t) / ((onCent[k + 1].t - onCent[k].t) || 1); cx = onCent[k].x + (onCent[k + 1].x - onCent[k].x) * f; cy = onCent[k].y + (onCent[k + 1].y - onCent[k].y) * f; break; } return { dx: Math.round(cx - refX), dy: Math.round(cy - refY) }; };
const nvS = (fi, x, y) => { const sh = shiftAt(frames[fi].t); const xx = x + sh.dx, yy = y + sh.dy; return xx < 0 || yy < 0 || xx >= w || yy >= h ? 128 : nv(fi, yy * w + xx); };

// references (registered)
const onRef = new Float32Array(N); let onc = 0;
for (const [a, b] of onInt) { const sp = frames[b].t - frames[a].t || 1; for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / sp; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) onRef[i] += nvS(fi, i % w, (i / w) | 0); onc++; } }
const bitRef = Array.from({ length: bits }, () => new Float32Array(N)); const bc = new Int32Array(bits); let cyclesUsed = 0;
for (let k = 0; k < onInt.length - 1; k++) { const aS = onInt[k][1] + 1, aE = onInt[k + 1][0] - 1, t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0; if (aE <= aS || dur < bits * 30) continue; cyclesUsed++; for (let fi = aS; fi <= aE; fi++) { const f = (frames[fi].t - t0) / dur * bits, s = Math.min(bits - 1, Math.floor(f)), fr = f - s; if (fr < 0.2 || fr > 0.8) continue; for (const i of maskIdx) bitRef[s][i] += nvS(fi, i % w, (i / w) | 0); bc[s]++; } }
console.log(`cycles=${cyclesUsed} onFrames=${onc} bitFrames=[${[...bc]}] drift=${motionPx.toFixed(1)}px`);
if (!onc || !cyclesUsed || [...bc].some((c) => c === 0)) { console.error('FAIL: missing sub-slots.'); process.exit(2); }
for (const i of maskIdx) onRef[i] /= onc;
for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef[b][i] /= bc[b];
const offRef = new Float32Array(N); for (const i of maskIdx) { let mn = Infinity; for (let b = 0; b < bits; b++) mn = Math.min(mn, bitRef[b][i]); offRef[i] = mn; }

// (4) DETECT LED blobs on the clean ALL-ON contrast image, then READ each blob's bit-code
let maxC = 0; for (const i of maskIdx) maxC = Math.max(maxC, onRef[i] - offRef[i]);
const contrastThr = Math.max(12, 0.25 * maxC);
const cimg = new Uint8Array(N); for (const i of maskIdx) { const c = onRef[i] - offRef[i]; cimg[i] = c <= 0 ? 0 : c > 255 ? 255 : c; }
function detectBlobs(gray, thresh, minPx, maxPx) {
  const seen = new Uint8Array(N), out = [], st = [];
  for (let p0 = 0; p0 < N; p0++) { if (gray[p0] < thresh || seen[p0]) continue; st.length = 0; st.push(p0); seen[p0] = 1; let sx = 0, sy = 0, c = 0;
    while (st.length) { const p = st.pop(), x = p % w, y = (p / w) | 0; sx += x; sy += y; c++;
      if (x > 0 && gray[p - 1] >= thresh && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
      if (x < w - 1 && gray[p + 1] >= thresh && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
      if (y > 0 && gray[p - w] >= thresh && !seen[p - w]) { seen[p - w] = 1; st.push(p - w); }
      if (y < h - 1 && gray[p + w] >= thresh && !seen[p + w]) { seen[p + w] = 1; st.push(p + w); } }
    if (c >= minPx && c <= maxPx) out.push({ x: sx / c, y: sy / c, n: c }); }
  return out;
}
const blobs = detectBlobs(cimg, Math.max(12, 0.4 * maxC), minClusterArg ?? Math.max(2, Math.round(N / 30000)), Math.round(N / 12));
const samp = (img, cx, cy, r = 2) => { let s = 0, c = 0, x0 = Math.round(cx), y0 = Math.round(cy); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < w && y < h) { s += img[y * w + x]; c++; } } return c ? s / c : 0; };
const byIdx = new Map(); let decodedN = 0, oorN = 0;
for (const b of blobs) { const on = samp(onRef, b.x, b.y), off = samp(offRef, b.x, b.y); const c = on - off; if (c < contrastThr) continue; const mid = (on + off) / 2; let idx = 0; for (let bb = 0; bb < bits; bb++) if (samp(bitRef[bb], b.x, b.y) > mid) idx |= (1 << bb); decodedN++; if (idx >= numLeds) { oorN++; continue; } const p = byIdx.get(idx); if (!p || c > p.c) byIdx.set(idx, { x: b.x, y: b.y, c }); }
const pts = []; let found = 0;
for (const [idx, b] of byIdx) { pts.push({ idx, x: b.x, y: b.y }); found++; }
console.log(`blobs=${blobs.length} -> LEDs located: ${found}/${numLeds} (outOfRange=${decodedN ? (oorN / decodedN * 100).toFixed(0) : 0}%)`);

if (pts.length) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
  const side = Math.round(Math.sqrt(numLeds));
  console.log(`\nplacement (a sequential matrix should read 0..${numLeds - 1} in raster order):`);
  const grid = Array.from({ length: side }, () => Array(side).fill(' .'));
  for (const p of pts) { const cx = Math.min(side - 1, Math.round((p.x - mnx) / ((mxx - mnx) || 1) * (side - 1))); const cy = Math.min(side - 1, Math.round((p.y - mny) / ((mxy - mny) || 1) * (side - 1))); grid[cy][cx] = String(p.idx).padStart(2); }
  for (const r of grid) console.log('  ' + r.join(' '));
}
