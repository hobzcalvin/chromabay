// Closed-loop auto-layout scan: pick a flash brightness the camera can read, then decode.
// Transport- and camera-agnostic: the caller supplies `io` (the app wires BLE + getUserMedia; the
// bench wires the synthetic camera), so the exact same control logic is what gets benchmarked.
//
// Why a loop at all: the flash level that works spans ~40× across setups. A close-up dense panel
// blooms into one blob at the default level and needs ~1/10 of it; a lit room drowns LEDs at the
// default and needs more. Clipping alone is not the signal (a well-spaced grid decodes fine at 75%
// clipped cores); contrast alone isn't either. So:
//   PROBE  — strobe ALL-OFF/ALL-ON briefly at a level; measure LED-core clipping + ON−OFF contrast.
//            Step geometrically (dimmer if clipped, brighter if faint) to a level that is neither.
//   DECODE — run the full structured-light sequence at that level; if LEDs are missing and cores
//            are clipping, dim and retry once or twice; keep the best result.
import type { Frame } from './cameraDecode';
import type { Pt } from './autoLayout';
import { decodeStructuredLight, seqLength, type DecodeV2Diag } from './structuredLight';
import { fitWiring } from './autoLayout';

export type ScanIO = {
  /** Start the device flashing `kind` at per-channel `brightness` (1..255); `onlyLeds` = just
   *  these LEDs take part (targeted pass), the rest stay dark. */
  flash(kind: 'strobe' | 'legacy' | 'comp', brightness: number, onlyLeds?: number[], anchors?: { leds: number[]; brightness: number }): Promise<void>;
  /** Capture `ms` of camera frames (grayscale max-channel at processing resolution). */
  capture(ms: number): Promise<Frame[]>;
};

export type ScanOpts = {
  numLeds: number;
  bits: number;
  kind: 'legacy' | 'comp';
  frameMs: number;
  startBrightness?: number;   // default 40 (firmware default)
  maxProbes?: number;         // default 7
  cycles?: number;            // flash cycles per decode capture (default 2)
  targeted?: boolean;         // allow the targeted pass for missed LEDs (needs firmware feat>=9; default true for 'comp')
  onStatus?: (m: string) => void;
};

export type ProbeStats = { clipPct: number; contrast: number; corePx: number };
export type ScanResult = {
  ok: boolean; reason: string; points: (Pt | null)[]; found: number;
  brightness: number; captureMs: number; probes: { brightness: number; stats: ProbeStats }[];
  diag?: DecodeV2Diag;
};

const CLIP_MAX = 0.15, CONTRAST_MIN = 30;

/** From a strobe burst: how clipped the LED cores are, and how much they swing. */
export function analyzeProbe(frames: Frame[]): ProbeStats {
  if (frames.length < 4) return { clipPct: 0, contrast: 0, corePx: 0 };
  const N = frames[0].w * frames[0].h, F = frames.length;
  const mn = new Uint8Array(N).fill(255), mx = new Uint8Array(N);
  for (const f of frames) { const g = f.gray; for (let i = 0; i < N; i++) { const v = g[i]; if (v < mn[i]) mn[i] = v; if (v > mx[i]) mx[i] = v; } }
  let top = 0; for (let i = 0; i < N; i++) top = Math.max(top, mx[i] - mn[i]);
  if (top < 8) return { clipPct: 0, contrast: top, corePx: 0 };
  const core: number[] = []; for (let i = 0; i < N; i++) if (mx[i] - mn[i] >= 0.5 * top) core.push(i);
  // Contrast: median core swing between its brightest and darkest third of frames (robust to the
  // odd transition frame); clipping: share of core pixels that hit 250+ in their bright frames.
  const sw: number[] = []; let clip = 0;
  const vals = new Uint8Array(F);
  for (const i of core) {
    for (let f = 0; f < F; f++) vals[f] = frames[f].gray[i];
    const s = Array.from(vals).sort((a, b) => a - b);
    const lo = s[Math.floor(F * 0.15)], hi = s[Math.floor(F * 0.85)];
    sw.push(hi - lo); if (hi >= 250) clip++;
  }
  sw.sort((a, b) => a - b);
  return { clipPct: clip / core.length, contrast: sw[sw.length >> 1], corePx: core.length };
}

export async function runAutoScan(io: ScanIO, o: ScanOpts): Promise<ScanResult> {
  const say = o.onStatus ?? (() => {});
  let b = o.startBrightness ?? 40, captureMs = 0;
  const probes: ScanResult['probes'] = [];
  const clampB = (v: number) => Math.max(1, Math.min(255, Math.round(v)));
  const PROBE_MS = Math.round(o.frameMs * 2 * 3.2);   // ~3 strobe periods

  // ---- PROBE: bracket a readable level ----
  let lo = 0, hi = 256;                                  // known too-dim / too-bright bounds
  for (let p = 0; p < (o.maxProbes ?? 7); p++) {
    await io.flash('strobe', b);
    const fr = await io.capture(PROBE_MS); captureMs += PROBE_MS;
    const st = analyzeProbe(fr); probes.push({ brightness: b, stats: st });
    say(`probe @${b}: contrast ${st.contrast}, clipped ${(st.clipPct * 100).toFixed(0)}%`);
    let next = b;
    if (st.clipPct > CLIP_MAX && st.contrast >= CONTRAST_MIN) { hi = b; next = lo ? Math.sqrt(lo * b) : b * 0.45; }
    else if (st.contrast < CONTRAST_MIN && st.clipPct <= CLIP_MAX) { lo = b; next = hi < 256 ? Math.sqrt(hi * b) : b * 2.2; }
    else if (st.contrast < CONTRAST_MIN) { lo = b; next = b * 1.5; }   // faint AND clipped: mostly ambient — go brighter
    else break;                                                       // readable
    next = clampB(next);
    if (next === b || next <= lo || next >= hi) break;
    b = next;
  }

  // ---- DECODE, then fill in: up to 3 passes, merged (HDR-style) ----
  // One flash level can't serve every LED when they differ a lot in brightness (off-axis fairy
  // lights, partly hidden ones, mixed batches). Each later pass only ADDS LEDs the earlier ones
  // missed, and never one that lands on an LED already placed. Clipped + incomplete → dimmer
  // (bloom is hiding neighbours); unclipped + incomplete → brighter (the dim ones are too faint).
  const L = seqLength(o.kind, o.bits);
  const decMs = Math.round((L * (o.cycles ?? 2) + 1.5) * o.frameMs * 1.05);
  const pts: (Pt | null)[] = new Array(o.numLeds).fill(null);
  let found = 0, firstDiag: DecodeV2Diag | undefined, lastReason = '', okAny = false;
  const tried = new Set<number>();
  for (let pass = 0; pass < 3 && !tried.has(b); pass++) {
    tried.add(b);
    await io.flash(o.kind, b);
    say(pass ? `filling in missed LEDs @${b}… (${found}/${o.numLeds} so far)` : `mapping @${b}…`);
    const fr = await io.capture(decMs); captureMs += decMs;
    const r = decodeStructuredLight(fr, { kind: o.kind, bits: o.bits, frameMs: o.frameMs, numLeds: o.numLeds });
    lastReason = r.reason; firstDiag ??= r.diag; okAny ||= r.ok;
    if (r.ok) {
      // A handheld camera moves between passes: map this pass into the first pass's frame via the
      // LEDs both passes found (affine least squares; translation only if too few in common).
      const map = found ? registration(r.points, pts) : (p: Pt) => p;
      if (!map) {
        // Can't line this pass up with what we have: either the camera moved a lot, or one of the
        // two passes is bad. Keep whichever read more LEDs and carry on from there.
        if (r.diag.found > found) { say('passes disagree — keeping the stronger one'); pts.fill(null); found = 0; for (let i = 0; i < o.numLeds; i++) if (r.points[i]) { pts[i] = r.points[i]; found++; } }
        else say('passes disagree — keeping the earlier one');
      } else {
      const gap = typicalGap(pts.some(Boolean) ? pts : r.points);
      for (let i = 0; i < o.numLeds; i++) {
        const p0 = r.points[i]; if (!p0 || pts[i]) continue;
        const p = map(p0);
        if (gap > 0 && pts.some((q) => q && Math.hypot(q.x - p.x, q.y - p.y) < gap / 3)) continue;
        pts[i] = p; found++;
      }
      }
    }
    if (found >= o.numLeds) break;
    // Which way to go: dimmer only if bloom plausibly hides LEDs (clipped AND many missing) — a
    // clipped majority with a few missing usually means the missing ones are the DIM ones (occluded,
    // off-axis), which need brighter. Third pass tries whichever direction is still untried.
    const b0 = [...tried][0];
    const triedDim = [...tried].some((x) => x < b0), triedBright = [...tried].some((x) => x > b0);
    const wantDim = r.diag.clippedPct > 0.3 && found < 0.8 * o.numLeds;
    if (pass === 0) b = clampB(wantDim ? b0 * 0.5 : b0 * 2.5);
    else if (!triedBright) b = clampB(b0 * 2.5);
    else if (!triedDim) b = clampB(b0 * 0.5);
    else break;
  }
  // ---- TARGETED PASS: flash only what's still missing, at full level ----
  // A dim LED between bright neighbours is buried in their glow at ANY shared level — brighter
  // raises the glow too. With the found ones dark, it is the only light in its neighbourhood.
  // Worth it when a minority is missing (a majority missing is framing/focus, not dim LEDs).
  const missing = pts.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  if ((o.targeted ?? o.kind === 'comp') && o.kind === 'comp' && found >= 4 && missing.length && missing.length <= 0.5 * o.numLeds) {
    // Also light ~12 found LEDs spread across the array as ANCHORS, so this pass can be registered
    // to the earlier ones like any other (a handheld camera drifts). Skip any whose wiring
    // neighbour is missing — it's likely physically next to a dim LED and would glow over it.
    // Where should each missing LED be? From the recognised wiring if any, else between its found
    // wiring neighbours. Anchors must stay ≥3 gaps from all of those, or their glow (and the
    // exposure drop they cause) buries the very LEDs this pass is for.
    const gap0 = typicalGap(pts);
    const expected: Pt[] = [];
    const wf = fitWiring(pts, o.numLeds);
    if (wf?.predict) for (const i of missing) expected.push(wf.predict(i));
    else for (const i of missing) { const nb = [pts[i - 1], pts[i + 1]].filter((q): q is Pt => !!q); if (nb.length) expected.push({ x: nb.reduce((a, q) => a + q.x, 0) / nb.length, y: nb.reduce((a, q) => a + q.y, 0) / nb.length }); }
    const missSet = new Set(missing);
    const cand = pts.map((p, i) => (p && !missSet.has(i - 1) && !missSet.has(i + 1) && expected.every((e) => Math.hypot(e.x - p.x, e.y - p.y) > 3 * gap0) ? i : -1)).filter((i) => i >= 0);
    const anchors: number[] = [];
    if (cand.length) {                                  // farthest-point sampling
      anchors.push(cand[0]);
      while (anchors.length < Math.min(12, cand.length)) {
        let bi = -1, bd = -1;
        for (const i of cand) { let d = Infinity; for (const a of anchors) d = Math.min(d, Math.hypot(pts[i]!.x - pts[a]!.x, pts[i]!.y - pts[a]!.y)); if (d > bd) { bd = d; bi = i; } }
        anchors.push(bi);
      }
    }
    say(`targeted pass: flashing the ${missing.length} LEDs not yet found…`);
    await io.flash(o.kind, 255, missing, { leds: anchors, brightness: [...tried][0] });   // anchors at the main pass's level
    const fr = await io.capture(decMs); captureMs += decMs;
    const r = decodeStructuredLight(fr, { kind: o.kind, bits: o.bits, frameMs: o.frameMs, numLeds: o.numLeds });
    const map = r.ok ? registration(r.points, pts) : null;
    if (r.ok && map) {
      const gap = typicalGap(pts);
      for (const i of missing) {
        const p0 = r.points[i]; if (!p0) continue;
        const p = map(p0);
        if (gap > 0 && pts.some((q) => q && Math.hypot(q.x - p.x, q.y - p.y) < gap / 3)) continue;
        pts[i] = p; found++;
      }
    }
  }
  const best: ScanResult = { ok: okAny && found > 0, reason: found ? `decoded ${found}/${o.numLeds} LEDs` : lastReason, points: pts, found,
    brightness: [...tried][0], captureMs, probes, diag: firstDiag };
  return best;
}

// Map `from`'s coordinate frame onto `to`'s using IDs present in both. null if they disagree too much.
function registration(from: (Pt | null)[], to: (Pt | null)[]): ((p: Pt) => Pt) | null {
  const pairs: [Pt, Pt][] = [];
  for (let i = 0; i < from.length; i++) if (from[i] && to[i]) pairs.push([from[i]!, to[i]!]);
  if (!pairs.length) return null;
  if (pairs.length < 6) {
    const dx = median(pairs.map(([a, b]) => b.x - a.x)), dy = median(pairs.map(([a, b]) => b.y - a.y));
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }
  // x' = a·x + b·y + c, y' = d·x + e·y + f (normal equations, 3×3 each)
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, n = 0, Xx = 0, Xy = 0, X = 0, Yx = 0, Yy = 0, Y = 0;
  for (const [a, b] of pairs) { Sxx += a.x * a.x; Sxy += a.x * a.y; Syy += a.y * a.y; Sx += a.x; Sy += a.y; n++; Xx += b.x * a.x; Xy += b.x * a.y; X += b.x; Yx += b.y * a.x; Yy += b.y * a.y; Y += b.y; }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const sol = (r: number[]) => solve3(M, r);
  const [a, b, c] = sol([Xx, Xy, X]), [d, e, f] = sol([Yx, Yy, Y]);
  const T = (p: Pt) => ({ x: a * p.x + b * p.y + c, y: d * p.x + e * p.y + f });
  // Sanity: residuals must be small next to the LED spacing, or this isn't the same scene.
  const res = median(pairs.map(([p, q]) => { const t = T(p); return Math.hypot(t.x - q.x, t.y - q.y); }));
  return res < 0.25 * (typicalGap(to) || Infinity) ? T : null;
}
function median(v: number[]): number { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1] ?? 0; }
function solve3(M: number[][], r: number[]): number[] {
  const A = M.map((row, i) => [...row, r[i]]);
  for (let i = 0; i < 3; i++) {
    let pv = i; for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[pv][i])) pv = k;
    [A[i], A[pv]] = [A[pv], A[i]];
    for (let k = 0; k < 3; k++) { if (k === i) continue; const f = A[k][i] / (A[i][i] || 1e-12); for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]; }
  }
  return [A[0][3] / (A[0][0] || 1e-12), A[1][3] / (A[1][1] || 1e-12), A[2][3] / (A[2][2] || 1e-12)];
}

// 75th-percentile nearest-neighbour distance among placed points (the typical LED gap).
function typicalGap(pts: (Pt | null)[]): number {
  const q = pts.filter((p): p is Pt => !!p);
  const nn = q.map((p) => { let m = Infinity; for (const r of q) if (r !== p) m = Math.min(m, Math.hypot(p.x - r.x, p.y - r.y)); return m; }).filter(Number.isFinite).sort((a, b) => a - b);
  return nn.length ? nn[Math.floor(nn.length * 0.75)] : 0;
}
