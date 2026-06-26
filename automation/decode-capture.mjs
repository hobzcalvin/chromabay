#!/usr/bin/env node
// Offline decode harness for a recorded calibration capture (the .bin the Auto-map "Record"
// button downloads). Iterate the LED-mapping decode against REAL footage with ground truth,
// instead of guessing from screenshots. Mirrors src/lib/cameraDecode.ts captureAndDecode().
//
//   node automation/decode-capture.mjs <capture.bin> [relThr] [minCluster]
//
// .bin format: 'CBC1', u16 w,h,bits,frameMs,numLeds,frameCount (LE), then per frame:
//              f32 t (LE) + w*h grayscale bytes (max-channel brightness).
//
// Prints: recovered timing (OFF intervals / cycles), per-pixel decode stats, the located LED
// count, and an ASCII placement grid (for a sequential matrix this should read 0,1,2,.. in
// raster order). See SESSION NOTE at the bottom for what good vs bad footage looks like.
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
for (let i = 0; i < n; i++) {
  const t = dv.getFloat32(off, true); off += 4;
  const gray = new Uint8Array(buf.buffer, buf.byteOffset + off, N); off += N;
  frames.push({ t, gray });
}

// (1) per-frame background (histogram median) -> exposure-flat normalized value
const bg = new Float32Array(n);
for (let fi = 0; fi < n; fi++) {
  const g = frames[fi].gray, hist = new Int32Array(64);
  for (let i = 0; i < N; i++) hist[g[i] >> 2]++;
  let acc = 0, bin = 0; for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= N >> 1) break; }
  bg[fi] = bin * 4 + 2;
}
const nv = (fi, i) => { const v = frames[fi].gray[i] - bg[fi] + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };

// (2) LED mask from per-pixel temporal swing
const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
for (let fi = 0; fi < n; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
let maxRange = 0; const range = new Uint8Array(N);
for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > maxRange) maxRange = r; }
const maskThr = Math.max(12, relThr * maxRange);
const maskIdx = []; for (let i = 0; i < N; i++) if (range[i] >= maskThr) maskIdx.push(i);
console.log(`maxRange=${maxRange} maskPixels=${maskIdx.length}`);

// saturation check — the #1 cause of failure
let satFrames = 0, peakSat = 0;
for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] >= 250) c++; if (c > peakSat) peakSat = c; }
const satPct = maskIdx.length ? (peakSat / maskIdx.length * 100) : 0;
console.log(`peak clipped (>=250) strip px: ${peakSat}/${maskIdx.length} (${satPct.toFixed(0)}%)${satPct > 25 ? '  <-- OVER-EXPOSED: lower flash brightness!' : ''}`);

// (3) recover timing via long OFF intervals
const litC = new Int32Array(n);
for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] - bg[fi] + 128 > 175) c++; litC[fi] = c; }
let maxLit = 0; for (let fi = 0; fi < n; fi++) if (litC[fi] > maxLit) maxLit = litC[fi];
const offThr = 0.2 * maxLit, offInt = [];
{ let s = -1;
  for (let fi = 0; fi < n; fi++) { if (litC[fi] < offThr) { if (s < 0) s = fi; } else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.6) offInt.push([s, fi - 1]); s = -1; } } }
  if (s >= 0 && frames[n - 1].t - frames[s].t > frameMs * 0.6) offInt.push([s, n - 1]);
}
console.log(`OFF intervals: ${offInt.map(([a, b]) => `${frames[a].t.toFixed(0)}-${frames[b].t.toFixed(0)}`).join(' ') || '(none!)'}`);
if (offInt.length < 2) { console.error('FAIL: need >=2 OFF intervals (>=1 full cycle).'); process.exit(2); }

// references
const SUB = bits + 1;
const offRef = new Float32Array(N), onRef = new Float32Array(N), bitRef = Array.from({ length: bits }, () => new Float32Array(N));
let offCnt = 0; const subCnt = new Int32Array(SUB);
for (const [a, b] of offInt) { const span = frames[b].t - frames[a].t || 1; for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / span; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) offRef[i] += nv(fi, i); offCnt++; } }
let cyclesUsed = 0; const onCentroids = [];
for (let k = 0; k < offInt.length - 1; k++) {
  const aS = offInt[k][1] + 1, aE = offInt[k + 1][0] - 1, t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0;
  if (aE <= aS || dur < SUB * 40) continue; cyclesUsed++;
  let cxs = 0, cys = 0, cw = 0;
  for (let fi = aS; fi <= aE; fi++) { const f = (frames[fi].t - t0) / dur * SUB, s = Math.min(SUB - 1, Math.floor(f)), fr = f - s; if (fr < 0.2 || fr > 0.8) continue; const tgt = s === 0 ? onRef : bitRef[s - 1]; for (const i of maskIdx) { const v = nv(fi, i); tgt[i] += v; if (s === 0 && v > 175) { cxs += (i % w) * v; cys += ((i / w) | 0) * v; cw += v; } } subCnt[s]++; }
  if (cw > 0) onCentroids.push({ x: cxs / cw, y: cys / cw });
}
let motionPx = 0;
if (onCentroids.length >= 2) { let mx = 0, my = 0; for (const c of onCentroids) { mx += c.x; my += c.y; } mx /= onCentroids.length; my /= onCentroids.length; for (const c of onCentroids) motionPx = Math.max(motionPx, Math.hypot(c.x - mx, c.y - my)); }
console.log(`cycles=${cyclesUsed} onFrames=${subCnt[0]} bitFrames=[${[...subCnt].slice(1)}] offFrames=${offCnt}`);
if (!cyclesUsed || [...subCnt].some((c) => c === 0)) { console.error('FAIL: missing sub-slots.'); process.exit(2); }
for (const i of maskIdx) { offRef[i] /= offCnt || 1; onRef[i] /= subCnt[0]; }
for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef[b][i] /= subCnt[b + 1];

// (4) per-pixel decode + cluster by code
let maxC = 0; for (const i of maskIdx) { const c = onRef[i] - offRef[i]; if (c > maxC) maxC = c; }
const contrastThr = Math.max(12, 0.25 * maxC);
const codes = 1 << bits;
const sX = new Float64Array(codes), sY = new Float64Array(codes), sW = new Float64Array(codes), cn = new Int32Array(codes);
let decodedPx = 0, outOfRangePx = 0;
for (const i of maskIdx) { const c = onRef[i] - offRef[i]; if (c < contrastThr) continue; const mid = (onRef[i] + offRef[i]) / 2; let idx = 0; for (let b = 0; b < bits; b++) if (bitRef[b][i] > mid) idx |= (1 << b); decodedPx++; if (idx >= numLeds) { outOfRangePx++; continue; } const x = i % w, y = (i / w) | 0; sX[idx] += x * c; sY[idx] += y * c; sW[idx] += c; cn[idx]++; }
const outOfRangePct = decodedPx ? outOfRangePx / decodedPx : 0;
const minCluster = minClusterArg ?? Math.max(2, Math.round(maskIdx.length / 600));
const pts = []; let found = 0;
for (let idx = 0; idx < numLeds; idx++) { if (cn[idx] >= minCluster && sW[idx] > 0) { pts.push({ idx, x: sX[idx] / sW[idx], y: sY[idx] / sW[idx], px: cn[idx] }); found++; } }
console.log(`LEDs located: ${found}/${numLeds} (minCluster=${minCluster}, contrastThr=${contrastThr.toFixed(0)})`);
console.log(`diag: clipped=${(satPct).toFixed(0)}% outOfRange=${(outOfRangePct * 100).toFixed(0)}% motion=${motionPx.toFixed(1)}px maskPx=${maskIdx.length} maxRange=${maxRange}`);

const loc = pts.filter((p) => p.x != null);
if (loc.length) {
  const xs = loc.map((p) => p.x), ys = loc.map((p) => p.y);
  const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
  const side = Math.round(Math.sqrt(numLeds));
  console.log(`\nplacement (a sequential matrix should read 0..${numLeds - 1} in raster order):`);
  const grid = Array.from({ length: side }, () => Array(side).fill(' .'));
  for (const p of loc) {
    const cx = Math.min(side - 1, Math.round((p.x - mnx) / ((mxx - mnx) || 1) * (side - 1)));
    const cy = Math.min(side - 1, Math.round((p.y - mny) / ((mxy - mny) || 1) * (side - 1)));
    grid[cy][cx] = String(p.idx).padStart(2);
  }
  for (const r of grid) console.log('  ' + r.join(' '));
}

// SESSION NOTE: the first real capture (strip2, 25 LEDs, full-brightness white) was 69% clipped
// — the matrix saturated into one bloomed blob and decode collapsed (placement scrambled, codes
// 0/15/23 became attractors). The fix was firmware-side: flash calibration DIM (CRGB ~40) so LEDs
// stay distinct dots. On dim footage this pipeline should land a clean raster.
