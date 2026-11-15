#!/usr/bin/env node
// Replay a recorded calibration capture (the auto-layout ⏺ Record button's .bin) through the v2
// decoder + layout builder, and optionally check it against the layout you expect.
//
//   node --import ./automation/ts-resolve.mjs automation/replay-capture.ts <capture.bin> [--expect=16x16[s]]
//
// .bin: 'CBC1' (legacy [ON][bits] sequence) or 'CBC2' (inverse pairs), then u16 w,h,bits,frameMs,
// numLeds,frameCount (LE), then per frame f32 t + w*h gray. --expect=WxH grid, row-major from LED 0;
// add 's' for serpentine wiring. Compared up to rotation/mirror.
import { readFileSync } from 'node:fs';
import { decodeStructuredLight } from '../src/lib/structuredLight.ts';
import { buildLedmap, fitWiring, rectifyPoints } from '../src/lib/autoLayout.ts';
import { layoutPositions, scoreLedmap } from '../src/lib/autoLayoutSim.ts';

const path = process.argv[2];
if (!path) { console.error('usage: replay-capture.ts <capture.bin> [--expect=WxH[s]]'); process.exit(2); }
const buf = readFileSync(path), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const magic = dv.getUint32(0, false);
if (magic !== 0x43424331 && magic !== 0x43424332) { console.error('not a CBC1/CBC2 capture'); process.exit(2); }
const kind = magic === 0x43424332 ? 'comp' : 'legacy';
const w = dv.getUint16(4, true), h = dv.getUint16(6, true), bits = dv.getUint16(8, true);
const frameMs = dv.getUint16(10, true), numLeds = dv.getUint16(12, true), n = dv.getUint16(14, true);
const frames = []; let off = 16;
for (let i = 0; i < n; i++) { const t = dv.getFloat32(off, true); off += 4; frames.push({ t, gray: new Uint8Array(buf.buffer, buf.byteOffset + off, w * h), w, h }); off += w * h; }
console.log(`${kind} capture ${w}x${h}, ${n} frames, bits=${bits}, frameMs=${frameMs}, numLeds=${numLeds}`);
const r = decodeStructuredLight(frames, { kind, bits, frameMs, numLeds, onLog: (m) => console.log('  ' + m) });
console.log(r.reason, r.diag);
if (!r.ok) process.exit(1);
const wf = fitWiring(r.points, numLeds);
const lm = wf?.ledmap ?? buildLedmap(rectifyPoints(r.points), 1);
console.log(`layout ${lm.width}x${lm.height}${wf ? ` (recognised ${wf.cols}x${wf.rows}${wf.serpentine ? ' serpentine' : ''} wiring, residual ${wf.residual.toFixed(2)} pitch)` : ' (generic grid fit)'}`);
for (let y = 0; y < lm.height; y++) console.log('  ' + Array.from({ length: lm.width }, (_, x) => { const v = lm.map[y * lm.width + x]; return v < 0 ? '  .' : String(v).padStart(3); }).join(' '));
const ex = process.argv.find((a) => a.startsWith('--expect='))?.slice(9);
if (ex) {
  const m = /^(\d+)x(\d+)(s?)$/.exec(ex); if (!m) { console.error('bad --expect'); process.exit(2); }
  const want = layoutPositions({ kind: 'grid', cols: +m[1], rows: +m[2], serpentine: !!m[3] }).expected!;
  const s = scoreLedmap(lm, want);
  console.log(s.exact ? 'MATCH: layout is exactly as expected' : `MISMATCH: ${(s.cellMatch * 100).toFixed(0)}% of cells agree (best rotation/mirror)`);
  process.exit(s.exact ? 0 : 1);
}
