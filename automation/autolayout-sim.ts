#!/usr/bin/env node
// Offline auto-layout bench: render each scenario with the synthetic camera, run the decoder(s) +
// layout builder, and score against ground truth. Three pipelines are compared side by side:
//   v1        cameraDecode.decodeFrames on today's firmware sequence ([ON][bits])
//   v2-legacy structuredLight decoder on the same sequence
//   v2-comp   structuredLight decoder on the inverse-pair sequence ([ON][OFF][b][¬b]..)
//
//   node --import ./automation/ts-resolve.mjs automation/autolayout-sim.ts [nameFilter...] [--only=auto] [--seed=N] [--json]
import { decodeFrames } from '../src/lib/cameraDecode.ts';
import { decodeStructuredLight, type SeqKind } from '../src/lib/structuredLight.ts';
import { buildLedmap, rectifyPoints, type Pt } from '../src/lib/autoLayout.ts';
import { simulateCapture, scorePoints, scoreLedmap, type SimScenario } from '../src/lib/autoLayoutSim.ts';
import { SCENARIOS } from './autolayout-scenarios.ts';
import { runAutoScan } from '../src/lib/autoScan.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const seedArg = +(args.find((a) => a.startsWith('--seed='))?.slice(7) ?? 0);   // re-roll every random draw
const filt = args.filter((a) => !a.startsWith('--'));
const list: SimScenario[] = SCENARIOS.filter((s) => !filt.length || filt.some((f) => s.name.includes(f))).map((s) => (seedArg ? { ...s, seed: (s.seed ?? 1) + 1000 * seedArg } : s));
const PIPES: { name: string; seq: SeqKind; run: (sim: any, sc: SimScenario) => { points: (Pt | null)[]; reason: string } }[] = [
  { name: 'v1', seq: 'legacy', run: (sim, sc) => { const r = decodeFrames(sim.frames, { bits: sim.bits, frameMs: sc.frameMs ?? 220, numLeds: sim.numLeds }); return { points: r.points, reason: r.ok ? '' : r.reason }; } },
  { name: 'v2-legacy', seq: 'legacy', run: (sim, sc) => { const r = decodeStructuredLight(sim.frames, { kind: 'legacy', bits: sim.bits, frameMs: sc.frameMs ?? 220, numLeds: sim.numLeds }); return { points: r.points, reason: r.ok ? '' : r.reason }; } },
  { name: 'v2-comp', seq: 'comp', run: (sim, sc) => { const r = decodeStructuredLight(sim.frames, { kind: 'comp', bits: sim.bits, frameMs: sc.frameMs ?? 220, numLeds: sim.numLeds }); return { points: r.points, reason: r.ok ? '' : r.reason }; } },
  // The full closed loop the app runs: brightness probe → comp decode (→ dim + retry).
  { name: 'auto', seq: 'comp', run: (sim, sc) => autoRun(sim, sc) },
].filter((p) => !only || p.name === only);

// Bench IO for runAutoScan: each capture renders the scenario at the brightness the loop chose.
// Firmware brightness b scales LED radiance linearly; the scenario's ledLevel is the level at 40.
function autoRun(sim0: any, sc: SimScenario) {
  let kind: any = 'strobe', bri = 40, seed = 100 + 1000 * seedArg, last: any = sim0;
  const io = {
    flash: async (k: any, b: number) => { kind = k; bri = b; },
    capture: async (ms: number) => { last = simulateCapture({ ...sc, seq: kind, ledLevel: (sc.ledLevel ?? 0.6) * bri / 40, durationMs: ms, seed: seed++ }); return last.frames; },
  };
  let out: any;
  // runAutoScan is async but every await above resolves immediately; drain it synchronously-ish.
  const p = runAutoScan(io, { numLeds: sim0.numLeds, bits: sim0.bits, kind: 'comp', frameMs: sc.frameMs ?? 220 }).then((r) => { out = r; });
  return { p, get: () => ({ points: out.points, reason: out.ok ? `b=${out.brightness} ${(out.captureMs / 1000).toFixed(1)}s` : out.reason, truth: last.truth }) };
}

const rows: any[] = [];
const tot: Record<string, { n: number; ok: number; wrong: number; exact: number; layouts: number }> = {};
for (const sc of list) {
  const sims: Record<string, any> = {};
  const line: string[] = [sc.name.padEnd(30)];
  for (const pipe of PIPES) {
    const sim = sims[pipe.seq] ??= simulateCapture({ ...sc, seq: pipe.seq });
    let res: any = pipe.run(sim, sc), truth = sim.truth;
    if (res.p) { await res.p; res = res.get(); truth = res.truth; }
    const ps = scorePoints(res.points, truth, sim.spacingPx, sim.frames[0].w);
    let layout = '-';
    const t = tot[pipe.name] ??= { n: 0, ok: 0, wrong: 0, exact: 0, layouts: 0 };
    if (sim.expected) {
      t.layouts++;
      if (res.points.some(Boolean)) {
        const lm = buildLedmap(rectifyPoints(res.points), 1);
        const s = scoreLedmap(lm, sim.expected);
        layout = s.exact ? 'EXACT' : `${(s.cellMatch * 100).toFixed(0)}%`;
        if (s.exact) t.exact++;
      }
    }
    t.n += sim.numLeds; t.ok += ps.correct; t.wrong += ps.wrong;
    rows.push({ scenario: sc.name, pipe: pipe.name, n: sim.numLeds, ...ps, layout, reason: res.reason });
    line.push(`${pipe.name}: ${String(ps.correct).padStart(4)}/${String(sim.numLeds).padEnd(4)} w${String(ps.wrong).padEnd(3)} ${layout.padEnd(5)}${pipe.name === 'auto' ? ' ' + res.reason : ''}`);
  }
  if (!json) console.log(line.join(' | '));
}
if (json) console.log(JSON.stringify({ rows, tot }, null, 1));
else for (const [k, t] of Object.entries(tot)) console.log(`${k.padEnd(10)} ${t.ok}/${t.n} correct (${(100 * t.ok / t.n).toFixed(1)}%), ${t.wrong} wrong, ${t.exact}/${t.layouts} layouts exact`);
