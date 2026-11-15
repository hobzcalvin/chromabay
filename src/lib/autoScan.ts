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

export type ScanIO = {
  /** Start the device flashing `kind` at per-channel `brightness` (1..255). */
  flash(kind: 'strobe' | 'legacy' | 'comp', brightness: number): Promise<void>;
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

  // ---- DECODE (+ up to 2 retries dimmer if clipped and incomplete) ----
  const L = seqLength(o.kind, o.bits);
  const decMs = Math.round((L * (o.cycles ?? 2) + 1.5) * o.frameMs * 1.05);
  let best: ScanResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await io.flash(o.kind, b);
    say(`mapping @${b}…`);
    const fr = await io.capture(decMs); captureMs += decMs;
    const r = decodeStructuredLight(fr, { kind: o.kind, bits: o.bits, frameMs: o.frameMs, numLeds: o.numLeds });
    const res: ScanResult = { ok: r.ok, reason: r.reason, points: r.points, found: r.diag.found, brightness: b, captureMs, probes, diag: r.diag };
    if (!best || res.found > best.found) best = res;
    if (r.diag.found >= o.numLeds) break;
    if (r.diag.clippedPct > 0.3) b = clampB(b * 0.5);
    else if (r.diag.maxContrast < 2 * CONTRAST_MIN) b = clampB(b * 1.8);
    else break;                                         // exposure looks fine — retrying won't help
  }
  best!.captureMs = captureMs;
  return best!;
}
