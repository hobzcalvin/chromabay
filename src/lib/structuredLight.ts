// Auto-layout structured light, v2: the flash sequences the firmware can run, and a decoder that
// recovers each LED's image position from a camera burst of them. Pure (no DOM): the browser
// capture path, the synthetic bench (autoLayoutSim.ts) and recorded captures all go through it.
//
// Design (see documentation/AUTO_LAYOUT.md "v2 decoder" for the why):
//  1. TIMING  — the device clock is free-running and drifts vs. the nominal frame time, and the
//               camera is not synchronised to it. Every pattern change moves many pixels at once,
//               so frame-to-frame change energy spikes at each device frame edge. Fit the edge
//               train (period P, phase t0) to those spikes, then keep only frames well inside a
//               slot (edge frames are blends, and with a rolling shutter, half-and-half).
//  2. PHASE   — which slot of the cycle is which: correlate each slot's mean brightness with the
//               fraction of LEDs the sequence lights in it (ALL-ON = 1, ALL-OFF = 0, bits ≈ ½).
//  3. PER-PIXEL READ — average every pixel over all clean frames of each slot class (all cycles),
//               then read its code. In the 'comp' sequence each bit is sent as pattern + inverse,
//               so a bit is just "brighter in b than in ¬b" — no threshold, ambient cancels, and a
//               pixel lit by two LEDs (bloom halo) reads ~equal on the bits they differ in, so it
//               comes out LOW-CONFIDENCE instead of as a wrong code (Scharstein & Szeliski 2003).
//  4. CLUSTER — pixels sharing a confident code form that LED's spot; contrast-weighted centroid
//               gives a sub-pixel position. LEDs separate in code space even where spots touch.
import type { Pt } from './autoLayout';
import type { Frame } from './cameraDecode';

/** 'legacy' = firmware mode 1: [ALL-ON][bit0..bit(b-1)].
 *  'comp'   = firmware mode 3: [ALL-ON][ALL-OFF][bit0][¬bit0]..[bit(b-1)][¬bit(b-1)][par][¬par],
 *             par = XOR of the ID's bits — any single misread bit fails the check and the pixel is
 *             dropped instead of landing on a neighbour's ID (the dominant error under hard light). */
export type SeqKind = 'legacy' | 'comp' | 'strobe';   // strobe = firmware mode 0: [ALL-OFF][ALL-ON]

export function seqLength(kind: SeqKind, bits: number): number { return kind === 'comp' ? 2 + 2 * (bits + 1) : kind === 'strobe' ? 2 : 1 + bits; }

export function parity(i: number): number { let p = 0; while (i) { p ^= i & 1; i >>>= 1; } return p; }

/** Is LED `i` lit in slot `s` of the cycle? (Mirrors esp32 renderCalibrationFrame.) */
export function seqOn(kind: SeqKind, bits: number, s: number, i: number): boolean {
  if (kind === 'strobe') return s === 1;
  if (kind === 'legacy') return s === 0 ? true : ((i >> (s - 1)) & 1) === 1;
  if (s === 0) return true;
  if (s === 1) return false;
  const b = (s - 2) >> 1, inv = (s - 2) & 1;
  const v = b < bits ? (i >> b) & 1 : parity(i);   // pair `bits` is the parity bit
  return (v === 1) !== (inv === 1);
}

/** Bits needed so no LED's code is all-ones (an all-ones LED never blinks in 'legacy'). */
export function bitsFor(numLeds: number): number { let b = 1; while ((1 << b) - 1 < numLeds) b++; return b; }

export type DecodeV2Opts = {
  kind: 'legacy' | 'comp';
  bits: number;
  frameMs: number;           // nominal device frame time (the fit searches −8%..+15% around it)
  numLeds: number;
  noiseFloor?: number;       // min ALL-ON − ALL-OFF contrast to consider a pixel (8-bit units, default 10)
  minConf?: number;          // min per-bit margin ÷ contrast to trust a pixel's code (default 0.18)
  onLog?: (m: string) => void;
};

export type DecodeV2Diag = {
  found: number; frames: number; cleanFrames: number; cycles: number;
  periodMs: number;          // fitted device frame period
  edgeSharpness: number;     // 0..1 — how cleanly frame edges were found (low ⇒ timing unreliable)
  maskPx: number; codedPx: number; maxContrast: number;
  clippedPct: number;        // fraction of LED pixels at 255 in ALL-ON — high ⇒ bloom, flash dimmer
  outOfRange: number;        // confident codes ≥ numLeds — corruption signal
  duplicates: number;        // codes seen at >1 separate place (reflections)
  parityRejects: number;     // pixels whose code failed the parity check (comp)
  collisions: number;        // IDs dropped for sitting on another ID's spot
};

export type DecodeV2Result = {
  ok: boolean; reason: string;
  points: (Pt | null)[];     // points[led] in image px / image width (same convention as v1)
  conf: number[];            // per-LED decode weight (0 = not found)
  diag: DecodeV2Diag;
  debug?: { w: number; h: number; contrast: Float32Array; code: Int32Array };
};

export function decodeStructuredLight(frames: Frame[], o: DecodeV2Opts): DecodeV2Result {
  const log = o.onLog ?? (() => {});
  const L = seqLength(o.kind, o.bits);
  const F = frames.length;
  const diag: DecodeV2Diag = { found: 0, frames: F, cleanFrames: 0, cycles: 0, periodMs: 0, edgeSharpness: 0, maskPx: 0, codedPx: 0, maxContrast: 0, clippedPct: 0, outOfRange: 0, duplicates: 0, parityRejects: 0, collisions: 0 };
  const fail = (reason: string): DecodeV2Result => ({ ok: false, reason, points: [], conf: [], diag });
  if (F < 3 * L) return fail('capture too short for one full flash cycle');
  const w = frames[0].w, h = frames[0].h, N = w * h;

  // Exposure-flatten. Auto-exposure scales the whole frame (gain is multiplicative, and roughly
  // still so after the camera's gamma), so estimate each frame's gain as the median ratio to a
  // temporal-median reference image and divide it out. (Subtracting each frame's median, as v1
  // does, leaves residual swings across any lit/graded background — in a bright room the whole
  // frame then "blinks" and buries the LEDs.) LED pixels are a small minority: the median ignores them.
  const inv = new Float32Array(F);
  {
    const step = Math.max(1, Math.floor(N / 20000)), S = Math.ceil(N / step);
    const K = Math.min(F, 15), ref = new Float32Array(S), col = new Float32Array(K);
    for (let j = 0; j < S; j++) { for (let k = 0; k < K; k++) col[k] = frames[Math.floor((k * F) / K)].gray[j * step]; col.sort(); ref[j] = col[K >> 1]; }
    const ratios: number[] = [];
    for (let f = 0; f < F; f++) {
      ratios.length = 0; const g = frames[f].gray;
      for (let j = 0; j < S; j++) if (ref[j] >= 16 && ref[j] <= 240) ratios.push(g[j * step] / ref[j]);
      ratios.sort((a, b) => a - b);
      const r = ratios.length > 50 ? ratios[ratios.length >> 1] : 1;
      inv[f] = r > 0.05 ? 1 / r : 1;
    }
  }
  // Candidate pixels: anything with a real temporal swing.
  const pmin = new Float32Array(N).fill(1e9), pmax = new Float32Array(N).fill(-1e9);
  for (let f = 0; f < F; f++) { const g = frames[f].gray, m = inv[f]; for (let i = 0; i < N; i++) { const v = g[i] * m; if (v < pmin[i]) pmin[i] = v; if (v > pmax[i]) pmax[i] = v; } }
  let maxSwing = 0; for (let i = 0; i < N; i++) maxSwing = Math.max(maxSwing, pmax[i] - pmin[i]);
  const noise = o.noiseFloor ?? 10;
  if (maxSwing < noise) return fail('nothing in view is blinking — is the device calibrating and in frame?');
  const mask: number[] = []; for (let i = 0; i < N; i++) if (pmax[i] - pmin[i] >= Math.max(noise, 0.12 * maxSwing)) mask.push(i);
  diag.maskPx = mask.length;
  if (mask.length < 2) return fail('blinking region too small — move closer');
  const M = mask.length;

  // ---- 1. TIMING: edge energy between consecutive frames, then fit the device edge train ----
  // Timing/phase use only the strongest-swinging pixels (the LED cores), capped for cost.
  const strong = mask.filter((i) => pmax[i] - pmin[i] >= 0.35 * maxSwing);
  const tmask = strong.length > 6000 ? strong.filter((_, k) => k % Math.ceil(strong.length / 6000) === 0) : strong;
  const eT: number[] = [], eV: number[] = [];
  for (let f = 1; f < F; f++) {
    const a = frames[f - 1].gray, b = frames[f].gray, ma = inv[f - 1], mb = inv[f]; let s = 0;
    for (const i of tmask) s += Math.abs(b[i] * mb - a[i] * ma);
    eT.push((frames[f].t + frames[f - 1].t) / 2); eV.push(s);
  }
  // Robust baseline: subtract the median energy so only edge spikes vote.
  const eMed = [...eV].sort((x, y) => x - y)[eV.length >> 1];
  const eW = eV.map((v) => Math.max(0, v - eMed));
  const PB = 40;
  let best = { score: -1, P: o.frameMs, t0: 0 };
  for (let P = o.frameMs * 0.92; P <= o.frameMs * 1.15; P += 0.25) {
    const hb = new Float64Array(PB); let tot = 0;
    for (let k = 0; k < eT.length; k++) { const ph = ((eT[k] % P) + P) % P; hb[Math.floor((ph / P) * PB) % PB] += eW[k]; tot += eW[k]; }
    // Edge train = a sharp peak in phase. Score with a 3-bin window (frame-time quantisation).
    for (let b = 0; b < PB; b++) {
      const s = hb[(b + PB - 1) % PB] + hb[b] + hb[(b + 1) % PB];
      if (s > best.score) {
        // refine phase: weighted circular mean inside the window
        let cx = 0, cy = 0; for (let d = -1; d <= 1; d++) { const bb = (b + d + PB) % PB, ang = ((bb + 0.5) / PB) * 2 * Math.PI; cx += hb[bb] * Math.cos(ang); cy += hb[bb] * Math.sin(ang); }
        const ang = (Math.atan2(cy, cx) + 2 * Math.PI) % (2 * Math.PI);
        best = { score: s, P, t0: (ang / (2 * Math.PI)) * P };
        diag.edgeSharpness = tot ? s / tot : 0;
      }
    }
  }
  const P = best.P, t0 = best.t0;
  diag.periodMs = +P.toFixed(1);
  log(`timing: period ${P.toFixed(1)}ms (nominal ${o.frameMs}), edge sharpness ${(diag.edgeSharpness * 100).toFixed(0)}%`);

  // Slot index per frame (frames near an edge are dropped).
  const margin = Math.min(0.3, 45 / P);
  const slotOf = new Int32Array(F).fill(-1);
  let kMin = Infinity, kMax = -Infinity;
  for (let f = 0; f < F; f++) {
    const x = (frames[f].t - t0) / P, k = Math.floor(x), fr = x - k;
    if (fr < margin || fr > 1 - margin) continue;
    slotOf[f] = k; kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
  }
  const nSlots = kMax - kMin + 1;
  if (!(nSlots >= L)) return fail('could not lock onto the flash timing — hold steady, or the device may not be flashing');

  // ---- 2+3. PER-PIXEL READ, then PHASE ----
  // Average every mask pixel over all clean frames of each slot position (slot mod L, all cycles).
  const Araw = new Float32Array(M * L), Craw = new Int32Array(L);
  for (let f = 0; f < F; f++) {
    if (slotOf[f] < 0) continue; const r = ((slotOf[f] % L) + L) % L; Craw[r]++;
    const g = frames[f].gray, m = inv[f];
    for (let k = 0; k < M; k++) Araw[k * L + r] += g[mask[k]] * m;
  }
  if (Craw.some((c) => c === 0)) return fail(`capture missed some of the ${L} flash frames — capture longer`);
  for (let k = 0; k < M; k++) for (let r = 0; r < L; r++) Araw[k * L + r] /= Craw[r];
  // Which raw position is slot 0 (ALL-ON)? Test each rotation against the sequence's STRUCTURE on
  // the LED-core pixels, not just overall brightness (that was too weak a signal under a lit
  // background + fighting auto-exposure: bit slots are all ~½ lit).
  //   comp:   ON−OFF > 0, and every (bit, ¬bit) pair sums to ON+OFF.
  //   legacy: ON is each pixel's brightest slot.
  const core: number[] = []; { const strongSet = new Set(tmask); for (let k = 0; k < M; k++) if (strongSet.has(mask[k])) core.push(k); }
  let bestPh = 0, bestS = -Infinity;
  for (let ph = 0; ph < L; ph++) {
    let sc = 0; const at = (k: number, cls: number) => Araw[k * L + ((cls + ph) % L)];
    for (const k of core) {
      const on = at(k, 0);
      if (o.kind === 'comp') {
        const off = at(k, 1), sw = on - off; let dev = 0;
        for (let bb = 0; bb <= o.bits; bb++) dev += Math.abs(at(k, 2 + 2 * bb) + at(k, 3 + 2 * bb) - on - off);
        sc += sw - dev / (o.bits + 1);
      } else { let mx = -Infinity; for (let c = 1; c < L; c++) mx = Math.max(mx, at(k, c)); sc += on - mx; }
    }
    if (sc > bestS) { bestS = sc; bestPh = ph; }
  }
  const A = new Float32Array(M * L), C = new Int32Array(L);
  for (let c = 0; c < L; c++) { const r = (c + bestPh) % L; C[c] = Craw[r]; for (let k = 0; k < M; k++) A[k * L + c] = Araw[k * L + r]; }
  const classOf = (k: number) => (((k % L) + L) % L - bestPh + L) % L;
  diag.cycles = Math.floor(nSlots / L);
  diag.cleanFrames = C.reduce((a2, b2) => a2 + b2, 0);

  // Clipping in ALL-ON (raw values, not flattened) — the bloom signal for the brightness loop.
  { let clip = 0, onF = 0; for (let f = 0; f < F; f++) if (slotOf[f] >= 0 && classOf(slotOf[f]) === 0) { onF++; for (const i of tmask) if (frames[f].gray[i] >= 250) clip++; } diag.clippedPct = onF ? clip / (onF * tmask.length) : 0; }

  const minConf = o.minConf ?? 0.18;
  const contrast = new Float32Array(N), code = new Int32Array(N).fill(-1);
  const pixW = new Float32Array(N);
  let maxC = 0;
  for (let k = 0; k < M; k++) {
    const r = k * L; let on = A[r], off: number;
    if (o.kind === 'comp') off = A[r + 1];
    else { off = Infinity; for (let b = 0; b < o.bits; b++) off = Math.min(off, A[r + 1 + b]); }
    const con = on - off; if (con > maxC) maxC = con;
    contrast[mask[k]] = con;
  }
  diag.maxContrast = maxC;
  const minContrast = Math.max(noise, 0.08 * maxC);
  let coded = 0, parityRejects = 0;
  for (let k = 0; k < M; k++) {
    const p = mask[k], con = contrast[p]; if (con < minContrast) continue;
    const r = k * L; let id = 0, conf = Infinity;
    for (let b = 0; b < o.bits; b++) {
      let d: number;
      if (o.kind === 'comp') d = A[r + 2 + 2 * b] - A[r + 3 + 2 * b];
      else { const mid = (A[r] + (A[r] - con)) / 2; d = 2 * (A[r + 1 + b] - mid); }
      if (d > 0) id |= 1 << b;
      conf = Math.min(conf, Math.abs(d) / con);
    }
    if (conf < minConf) continue;
    if (o.kind === 'comp') {                        // parity pair: a single misread bit fails here
      const d = A[r + 2 + 2 * o.bits] - A[r + 3 + 2 * o.bits];
      if (Math.abs(d) / con < minConf || (d > 0 ? 1 : 0) !== parity(id)) { parityRejects++; continue; }
    }
    code[p] = id; pixW[p] = con * Math.min(1, conf); coded++;
  }
  diag.codedPx = coded;

  // ---- 4. CLUSTER: 8-connected same-code components; strongest component per code wins ----
  const seen = new Uint8Array(N), st: number[] = [];
  type Comp = { id: number; sw: number; sx: number; sy: number; n: number; px: number[] };
  const byId = new Map<number, Comp[]>();
  for (let p0 = 0; p0 < N; p0++) {
    if (code[p0] < 0 || seen[p0]) continue;
    const id = code[p0]; const cp: Comp = { id, sw: 0, sx: 0, sy: 0, n: 0, px: [] };
    st.length = 0; st.push(p0); seen[p0] = 1;
    while (st.length) {
      const p = st.pop()!, x = p % w, y = (p / w) | 0, wt = pixW[p];
      cp.sw += wt; cp.sx += wt * x; cp.sy += wt * y; cp.n++; cp.px.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (!seen[q] && code[q] === id) { seen[q] = 1; st.push(q); }
      }
    }
    const arr = byId.get(id); if (arr) arr.push(cp); else byId.set(id, [cp]);
  }
  // Noise floor for a real LED: a fraction of the typical (median) LED weight.
  const strongest = [...byId.values()].map((cs) => Math.max(...cs.map((c) => c.sw))).sort((a, b) => a - b);
  const medW = strongest.length ? strongest[strongest.length >> 1] : 0;
  const points: (Pt | null)[] = new Array(o.numLeds).fill(null), conf = new Array(o.numLeds).fill(0);
  for (const [id, cs] of byId) {
    // Several places carry this code (a reflection in a floor/window/glossy wall, or a halo split
    // off its LED): take the SHARPEST — highest peak contrast — among the substantial ones. A
    // reflection is diffuse, so it can out-weigh the real LED in total light but never in peak.
    const maxSw = Math.max(...cs.map((q) => q.sw));
    const real = cs.filter((q) => q.sw >= 0.12 * medW && q.sw >= 0.3 * maxSw);   // sharp-but-tiny fragments don't qualify
    if (!real.length) continue;
    const peakOf = (q: Comp) => { let m = 0; for (const p of q.px) m = Math.max(m, contrast[p]); return m; };
    real.sort((a, b) => peakOf(b) - peakOf(a)); const c = real[0];
    if (id >= o.numLeds) { diag.outOfRange++; continue; }
    if (real.length > 1) diag.duplicates++;
    // Position from the CORE only (pixels above half the component's peak contrast). The bloom halo
    // beyond an edge/corner LED is lit by that LED alone, so it decodes cleanly as its code — and,
    // being large and one-sided, dragged the whole-component centroid ~½ pitch outward (all four
    // corners of a bloomy close-up came out misplaced).
    let peak = 0; for (const p of c.px) peak = Math.max(peak, contrast[p]);
    let qw = 0, qx = 0, qy = 0;
    for (const p of c.px) { const e = contrast[p] - 0.5 * peak; if (e <= 0) continue; qw += e; qx += e * (p % w); qy += e * ((p / w) | 0); }
    points[id] = qw > 0 ? { x: qx / qw / w, y: qy / qw / w } : { x: c.sx / c.sw / w, y: c.sy / c.sw / w }; conf[id] = c.sw;
    diag.found++;
  }
  // Two IDs on the same spot: one is a misread of the other (a bit error the parity didn't catch, or
  // legacy mode which has none). Keep the stronger. "Same spot" = closer than ⅓ of the typical gap.
  {
    const ids = points.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const nn = ids.map((i) => { let m = Infinity; for (const j of ids) if (j !== i) m = Math.min(m, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)); return m; }).filter(Number.isFinite).sort((a, b) => a - b);
    const gap = nn.length ? nn[Math.floor(nn.length * 0.75)] : 0;
    if (gap > 0) for (const i of ids) for (const j of ids) {
      if (j <= i || !points[i] || !points[j]) continue;
      if (Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y) < gap / 3) {
        const drop = conf[i] >= conf[j] ? j : i; points[drop] = null; conf[drop] = 0; diag.found--; diag.collisions++;
      }
    }
  }
  diag.parityRejects = parityRejects;
  log(`decoded ${diag.found}/${o.numLeds} (${coded} coded px of ${M}, ${parityRejects} px failed parity, ${diag.cycles} cycles, ${diag.cleanFrames} clean frames)`);
  if (!diag.found) return fail('LEDs blink but no codes could be read — try a dimmer flash');
  return { ok: true, reason: `decoded ${diag.found}/${o.numLeds} LEDs`, points, conf, diag, debug: { w, h, contrast, code } };
}
