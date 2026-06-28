#!/usr/bin/env node
// Offline decode harness for a recorded calibration capture (the ⏺ button's .bin). Mirrors
// src/lib/cameraDecode.ts captureAndDecode(): locate LED blobs on a clean contrast image, then
// read each blob's bit-code anchored on the periodic ALL-ON pulse (firmware emits [ALL-ON][bit0..]
// with no dark frame), sampling ~1px/blob to avoid crosstalk. Prints located count + a placement grid.
//
//   node automation/decode-capture.mjs <capture.bin> [minBlobPx]
//
// .bin ('CBC1'): u16 w,h,bits,frameMs,numLeds,frameCount (LE), then per frame f32 t + w*h gray.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node automation/decode-capture.mjs <capture.bin> [minBlobPx]'); process.exit(1); }
const minBlobArg = process.argv[3] ? parseInt(process.argv[3]) : null;
const buf = readFileSync(path);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, false) !== 0x43424331) { console.error('not a CBC1 capture'); process.exit(1); }
const w = dv.getUint16(4, true), h = dv.getUint16(6, true), bits = dv.getUint16(8, true);
const frameMs = dv.getUint16(10, true), numLeds = dv.getUint16(12, true), n = dv.getUint16(14, true);
const N = w * h, frames = [];
let off = 16;
for (let i = 0; i < n; i++) { const t = dv.getFloat32(off, true); off += 4; frames.push({ t, gray: new Uint8Array(buf.buffer, buf.byteOffset + off, N) }); off += N; }
console.log(`capture: ${w}x${h}, ${n} frames, bits=${bits}, frameMs=${frameMs}, numLeds=${numLeds}, dur=${(frames[n - 1].t - frames[0].t).toFixed(0)}ms`);

const bg = new Float32Array(n);
for (let fi = 0; fi < n; fi++) { const g = frames[fi].gray, hi = new Int32Array(64); for (let i = 0; i < N; i++) hi[g[i] >> 2]++; let a = 0, b = 0; for (; b < 64; b++) { a += hi[b]; if (a >= N >> 1) break; } bg[fi] = b * 4 + 2; }
const nv = (fi, i) => { const v = frames[fi].gray[i] - bg[fi] + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };
const pmin = new Float32Array(N).fill(255), pmax = new Float32Array(N);
for (let fi = 0; fi < n; fi++) for (let i = 0; i < N; i++) { const v = nv(fi, i); if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; }
let maxRange = 0; for (let i = 0; i < N; i++) maxRange = Math.max(maxRange, pmax[i] - pmin[i]);
const maskIdx = []; for (let i = 0; i < N; i++) if (pmax[i] - pmin[i] >= Math.max(12, 0.35 * maxRange)) maskIdx.push(i);
let peakClip = 0; for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (frames[fi].gray[i] >= 250) c++; peakClip = Math.max(peakClip, c); }
console.log(`maxRange=${maxRange} maskPx=${maskIdx.length} clipped=${(peakClip / maskIdx.length * 100 | 0)}%`);

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
const disc = (fi, cx, cy, r) => { let s = 0, c = 0, x0 = Math.round(cx), y0 = Math.round(cy); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < w && y < h) { s += nv(fi, y * w + x); c++; } } return c ? s / c : 0; };

// PASS 1: clean contrast image → blobs. Rough ON anchors (lit-pixel) build onRef + per-bit refs;
// offRef = min over bit refs (suppresses the bloom halo, which is lit in some bit frames) so only
// the LED cores survive in onRef−offRef.
const litPx = new Int32Array(n); for (let fi = 0; fi < n; fi++) { let c = 0; for (const i of maskIdx) if (nv(fi, i) > 175) c++; litPx[fi] = c; }
let mlp = 0; for (const c of litPx) mlp = Math.max(mlp, c);
const onI1 = []; { let s = -1; for (let fi = 0; fi < n; fi++) { if (litPx[fi] >= 0.7 * mlp) { if (s < 0) s = fi; } else { if (s >= 0) { if (frames[fi - 1].t - frames[s].t > frameMs * 0.4) onI1.push([s, fi - 1]); s = -1; } } } }
const onRef = new Float32Array(N); let oc = 0;
for (const [a, b] of onI1) { const sp = frames[b].t - frames[a].t || 1; for (let fi = a; fi <= b; fi++) { const fr = (frames[fi].t - frames[a].t) / sp; if (fr < 0.25 || fr > 0.85) continue; for (const i of maskIdx) onRef[i] += nv(fi, i); oc++; } }
if (oc) for (const i of maskIdx) onRef[i] /= oc;
const bitRef0 = Array.from({ length: bits }, () => new Float32Array(N)), bc0 = new Int32Array(bits);
for (let q = 0; q < onI1.length - 1; q++) { const aS = onI1[q][1] + 1, aE = onI1[q + 1][0] - 1, t0 = frames[aS]?.t ?? 0, dur = (frames[aE]?.t ?? 0) - t0; if (aE <= aS || dur < bits * 40) continue; for (let fi = aS; fi <= aE; fi++) { const f = (frames[fi].t - t0) / dur * bits, sl = Math.min(bits - 1, Math.floor(f)), fr = f - sl; if (fr < 0.2 || fr > 0.8) continue; for (const i of maskIdx) bitRef0[sl][i] += nv(fi, i); bc0[sl]++; } }
for (let b = 0; b < bits; b++) for (const i of maskIdx) bitRef0[b][i] /= bc0[b] || 1;
const offRef = new Float32Array(N); for (const i of maskIdx) { let mn = 1e9; for (let b = 0; b < bits; b++) mn = Math.min(mn, bitRef0[b][i]); offRef[i] = mn; }
let maxC = 0; const cimg = new Uint8Array(N); for (const i of maskIdx) { const c = onRef[i] - offRef[i]; cimg[i] = c <= 0 ? 0 : c > 255 ? 255 : c; if (c > maxC) maxC = c; }
const blobs = detectBlobs(cimg, Math.max(12, 0.4 * maxC), minBlobArg ?? Math.max(2, Math.round(N / 80000)), Math.round(N / 12));
const M = blobs.length;
console.log(`located ${M} candidate blobs`);

// PASS 2: per-blob ALL-ON-anchored decode. Sample ~1px/blob (sampleR) — a wider disc bleeds into
// tightly-spaced neighbours on a dense grid and corrupts the bit read.
const blobNs = blobs.map((b) => b.n).sort((a, b) => a - b);
const sampleR = (blobNs[blobNs.length >> 1] || 1) > 24 ? 1 : 0;
const S = blobs.map((b) => { const a = new Float32Array(n); for (let fi = 0; fi < n; fi++) a[fi] = disc(fi, b.x, b.y, sampleR); return a; });
const bMid = blobs.map((_, k) => { let mn = 255, mx = 0; for (let fi = 0; fi < n; fi++) { const v = S[k][fi]; if (v < mn) mn = v; if (v > mx) mx = v; } return (mn + mx) / 2; });
const litB = new Int32Array(n); for (let fi = 0; fi < n; fi++) { let c = 0; for (let k = 0; k < M; k++) if (S[k][fi] > bMid[k]) c++; litB[fi] = c; }
// ALL-ON anchor: peak of lit-blob count (95th pct); a cycle runs from one ALL-ON start to the next.
const litMax = [...litB].sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))] || M;
const onThr = Math.max(0.6 * M, 0.82 * litMax);
const onInt = []; { let s = -1; for (let fi = 0; fi < n; fi++) { if (litB[fi] >= onThr) { if (s < 0) s = fi; } else { if (s >= 0) { onInt.push([s, fi - 1]); s = -1; } } } if (s >= 0) onInt.push([s, n - 1]); }
const onStarts = []; for (const [a] of onInt) { if (!onStarts.length || frames[a].t - frames[onStarts[onStarts.length - 1]].t > frameMs * 0.5) onStarts.push(a); }
if (onStarts.length < 2) { console.error('FAIL: need >=2 ALL-ON anchors.'); process.exit(2); }
// Derive sub-slots/cycle from the measured anchor period (median = robust to a missed pulse). Current
// firmware = [ALL-ON][bit0..] (SUB=1+bits); a legacy build prepended [ALL-OFF], so the ALL-ON→ALL-ON
// span is 2+bits with a trailing dark slot. Either way slots 1..bits are the bit planes.
const gaps = []; for (let q = 1; q < onStarts.length; q++) gaps.push(frames[onStarts[q]].t - frames[onStarts[q - 1]].t);
gaps.sort((a, b) => a - b); const period = gaps[gaps.length >> 1] || (1 + bits) * frameMs;
const SUB = Math.max(1 + bits, Math.round(period / frameMs));
console.log(`ALL-ON anchors: ${onStarts.length}, period=${period | 0}ms → SUB=${SUB} (bits=${bits}, litMax=${litMax}/${M})`);
const onSum = new Float64Array(M), bitSum = Array.from({ length: bits }, () => new Float64Array(M)), bitCnt = new Int32Array(bits);
let onCnt = 0, cyc = 0;
for (let q = 0; q < onStarts.length - 1; q++) { const aS = onStarts[q], aE = onStarts[q + 1] - 1, t0 = frames[aS].t, dur = frames[aE + 1] ? frames[aE + 1].t - t0 : 0; if (aE <= aS || dur < period * 0.6 || dur > period * 1.4) continue; cyc++;
  for (let fi = aS; fi <= aE; fi++) { const f = (frames[fi].t - t0) / dur * SUB, sl = Math.min(SUB - 1, Math.floor(f)), fr = f - sl; if (fr < 0.2 || fr > 0.8) continue; if (sl === 0) { for (let k = 0; k < M; k++) onSum[k] += S[k][fi]; onCnt++; } else if (sl - 1 < bits) { for (let k = 0; k < M; k++) bitSum[sl - 1][k] += S[k][fi]; bitCnt[sl - 1]++; } } }
const onAvg = onSum.map((v) => v / (onCnt || 1)), bitAvg = bitSum.map((bs, b) => bs.map((v) => v / (bitCnt[b] || 1)));
const byIdx = new Map(); let dN = 0, oN = 0;
for (let k = 0; k < M; k++) { const on = onAvg[k]; let offv = Infinity; for (let b = 0; b < bits; b++) offv = Math.min(offv, bitAvg[b][k]); const c = on - offv; if (c < Math.max(3, 0.12 * on)) continue; const mid = (on + offv) / 2; let idx = 0; for (let b = 0; b < bits; b++) if (bitAvg[b][k] > mid) idx |= (1 << b); dN++; if (idx >= numLeds) { oN++; continue; } const p = byIdx.get(idx); if (!p || c > p.c) byIdx.set(idx, { x: blobs[k].x, y: blobs[k].y, c }); }
console.log(`cycles=${cyc} -> LEDs located: ${byIdx.size}/${numLeds} (outOfRange=${dN ? (oN / dN * 100 | 0) : 0}%)`);

const loc = [...byIdx].map(([idx, b]) => ({ idx, ...b }));
if (loc.length) {
  const xs = loc.map((p) => p.x), ys = loc.map((p) => p.y), mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys), side = Math.round(Math.sqrt(numLeds));
  console.log(`\nplacement (a sequential matrix reads 0..${numLeds - 1} in raster order, modulo rotation):`);
  const g = Array.from({ length: side }, () => Array(side).fill(' .'));
  for (const p of loc) { const cx = Math.min(side - 1, Math.round((p.x - mnx) / ((mxx - mnx) || 1) * (side - 1))), cy = Math.min(side - 1, Math.round((p.y - mny) / ((mxy - mny) || 1) * (side - 1))); g[cy][cx] = String(p.idx).padStart(2); }
  for (const r of g) console.log('  ' + r.join(' '));
}
