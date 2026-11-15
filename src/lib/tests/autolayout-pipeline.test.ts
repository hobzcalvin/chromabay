import { describe, expect, it } from 'vitest';
import { simulateCapture, scorePoints, scoreLedmap, layoutPositions, type SimScenario } from '../autoLayoutSim';
import { decodeStructuredLight, seqOn, seqLength, parity } from '../structuredLight';
import { runAutoScan } from '../autoScan';
import { buildLedmap, fitWiring, rectifyPoints } from '../autoLayout';

// End-to-end auto-layout on the synthetic camera (the full battery lives in
// automation/autolayout-sim.ts; this is the fast regression subset).

async function auto(sc: SimScenario) {
  let anc: any, mask: number[] | undefined, kind: any = 'strobe', bri = 40, seed = 7, last: any, first: any;
  const io = {
    flash: async (k: any, b: number, only?: number[], an?: any) => { kind = k; bri = b; mask = only; anc = an; },
    capture: async (ms: number) => { last = simulateCapture({ ...sc, seq: kind, ledLevel: (sc.ledLevel ?? 0.6) * bri / 40, durationMs: ms, seed: seed++, onlyLeds: mask, anchorLeds: anc?.leds, anchorScale: anc ? anc.brightness / bri : 1 }); if (kind !== 'strobe') first ??= last; return last.frames; },
  };
  const ref = simulateCapture({ ...sc, cycles: 1 });
  const r = await runAutoScan(io, { numLeds: ref.numLeds, bits: ref.bits, kind: 'comp', frameMs: 220 });
  return { r, ps: scorePoints(r.points, first.truth, ref.spacingPx, ref.frames[0].w), expected: ref.expected };
}

describe('structured light sequences', () => {
  it('inverse pairs: every LED blinks, each bit pair is complementary', () => {
    const bits = 6, L = seqLength('comp', bits);
    for (let i = 0; i < 64; i++) {
      expect(seqOn('comp', bits, 0, i)).toBe(true);
      expect(seqOn('comp', bits, 1, i)).toBe(false);
      for (let b = 0; b <= bits; b++) expect(seqOn('comp', bits, 2 + 2 * b, i)).toBe(!seqOn('comp', bits, 3 + 2 * b, i));
      expect(seqOn('comp', bits, 2 + 2 * bits, i)).toBe(parity(i) === 1);   // last pair = parity
    }
    expect(L).toBe(16);
  });
});

describe('auto-layout pipeline on the synthetic camera', () => {
  it('decodes a 10x10 in a bright, graded room exactly (comp)', () => {
    const sim = simulateCapture({ name: 't', layout: { kind: 'grid', cols: 10, rows: 10 }, ambient: 0.35, ambientGradient: 0.2, seq: 'comp' });
    const r = decodeStructuredLight(sim.frames, { kind: 'comp', bits: sim.bits, frameMs: 220, numLeds: sim.numLeds });
    expect(scorePoints(r.points, sim.truth, sim.spacingPx, sim.frames[0].w).correct).toBe(100);
    expect(scoreLedmap(buildLedmap(rectifyPoints(r.points), 1), sim.expected!).exact).toBe(true);
  });

  it('closed loop dims an over-exposed close-up until every LED reads', async () => {
    const { r, ps, expected } = await auto({ name: 't', layout: { kind: 'grid', cols: 8, rows: 8 }, coverage: 0.5, spotFrac: 0.3, bloom: 0.12, ledLevel: 1.5 });
    expect(ps.correct).toBe(64); expect(ps.wrong).toBe(0);
    expect(r.brightness).toBeLessThan(40);
    expect(scoreLedmap(buildLedmap(rectifyPoints(r.points), 1), expected!).exact).toBe(true);
  });

  it('maps a 150-LED straight strip to 150x1', () => {
    const want = layoutPositions({ kind: 'strip', n: 150, shape: 'line' }).expected!;
    const pts = Array.from({ length: 150 }, (_, i) => ({ x: 0.05 + i * 0.006, y: 0.3 }));
    expect(scoreLedmap(buildLedmap(rectifyPoints(pts), 1), want).exact).toBe(true);
  });

  it('even-sized grids are not one row/column too big (lattice origin bug)', () => {
    for (const n of [4, 8, 16]) {
      const { pts, expected } = layoutPositions({ kind: 'grid', cols: n, rows: n });
      const lm = buildLedmap(pts.map((p) => ({ x: p.x / 40, y: p.y / 40 })), 1);
      expect([lm.width, lm.height]).toEqual([n, n]);
      expect(scoreLedmap(lm, expected!).exact).toBe(true);
    }
  });
});

describe('harsh conditions', () => {
  it('a floor reflection never steals an LED', () => {
    const sim = simulateCapture({ name: 't', layout: { kind: 'grid', cols: 10, rows: 6 }, coverage: 0.45, reflection: { strength: 0.5, mirrorY: 0.82 }, seq: 'comp', ledLevel: 0.12 });
    const r = decodeStructuredLight(sim.frames, { kind: 'comp', bits: sim.bits, frameMs: 220, numLeds: sim.numLeds });
    const ps = scorePoints(r.points, sim.truth, sim.spacingPx, sim.frames[0].w);
    expect(ps.wrong).toBe(0); expect(ps.correct).toBe(60);
  });

  it('dim/occluded LEDs are recovered by the targeted pass', async () => {
    const { r, ps } = await auto({ name: 't', layout: { kind: 'grid', cols: 10, rows: 10 }, occludeFrac: 0.2 });
    expect(ps.wrong).toBe(0); expect(r.found).toBe(100);
  }, 60000);   // several passes, incl. the targeted one

  it('wiring fit: exact from a jittered, perspective, 30%-missing serpentine', () => {
    const sim = simulateCapture({ name: 't', layout: { kind: 'grid', cols: 32, rows: 8, serpentine: true }, posJitter: 0.15, tilt: 0.3, rotDeg: 20, cycles: 1 });
    const pts = sim.truth.map((p, i) => (i % 10 < 3 ? null : { x: p.x / 320, y: p.y / 320 }));
    const f = fitWiring(pts, sim.numLeds)!;
    expect([f.cols, f.rows, f.serpentine]).toEqual([32, 8, true]);
    expect(scoreLedmap(f.ledmap, sim.expected!).exact).toBe(true);
  });

  it('wiring fit declines free-form layouts instead of guessing', () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: 0.5 + 0.3 * Math.cos(i * 2.4) * Math.sqrt(i / 100), y: 0.5 + 0.3 * Math.sin(i * 2.4) * Math.sqrt(i / 100) }));
    expect(fitWiring(pts, 100)).toBeNull();
  });
});
