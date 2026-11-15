#!/usr/bin/env node
// Offline auto-layout bench: render each scenario with the synthetic camera, run the REAL decoder
// (src/lib/cameraDecode.ts decodeFrames) + layout builder, score against ground truth.
//
//   node automation/autolayout-sim.ts            # whole battery
//   node automation/autolayout-sim.ts dense      # scenarios whose name contains "dense"
//   node automation/autolayout-sim.ts --json     # machine-readable
import { decodeFrames } from '../src/lib/cameraDecode.ts';
import { buildLedmap, rectifyPoints } from '../src/lib/autoLayout.ts';
import { simulateCapture, scorePoints, scoreLedmap, type SimScenario } from '../src/lib/autoLayoutSim.ts';
import { SCENARIOS } from './autolayout-scenarios.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const filt = args.filter((a) => !a.startsWith('--'));
const list: SimScenario[] = SCENARIOS.filter((s) => !filt.length || filt.some((f) => s.name.includes(f)));

const rows: any[] = [];
for (const sc of list) {
  const t0 = performance.now();
  const sim = simulateCapture(sc);
  const res = decodeFrames(sim.frames, { bits: sim.bits, frameMs: sc.frameMs ?? 220, numLeds: sim.numLeds });
  const ps = scorePoints(res.points, sim.truth, sim.spacingPx, sim.frames[0].w);
  let layout = '-';
  if (sim.expected && res.points.length) {
    const lm = buildLedmap(rectifyPoints(res.points), 1);
    const s = scoreLedmap(lm, sim.expected);
    layout = s.exact ? 'EXACT' : `${lm.width}x${lm.height} ${(s.cellMatch * 100).toFixed(0)}%`;
  }
  const r = { name: sc.name, n: sim.numLeds, correct: ps.correct, wrong: ps.wrong, missing: ps.missing,
    errPx: +ps.meanErrPx.toFixed(2), spacingPx: +sim.spacingPx.toFixed(1), layout, reason: res.ok ? '' : res.reason,
    ms: Math.round(performance.now() - t0) };
  rows.push(r);
  if (!json) console.log(`${r.name.padEnd(34)} n=${String(r.n).padStart(4)}  ok ${String(r.correct).padStart(4)}  wrong ${String(r.wrong).padStart(3)}  miss ${String(r.missing).padStart(4)}  pitch ${String(r.spacingPx).padStart(5)}px  layout ${String(layout).padEnd(12)} ${r.reason}`);
}
const tot = rows.reduce((a, r) => ({ n: a.n + r.n, ok: a.ok + r.correct, wrong: a.wrong + r.wrong, exact: a.exact + (r.layout === 'EXACT' ? 1 : 0) }), { n: 0, ok: 0, wrong: 0, exact: 0 });
if (json) console.log(JSON.stringify({ rows, tot }, null, 1));
else console.log(`\nTOTAL  ${tot.ok}/${tot.n} correct (${(100 * tot.ok / tot.n).toFixed(1)}%), ${tot.wrong} wrong, ${tot.exact}/${rows.filter((r) => r.layout !== '-').length} layouts exact`);
