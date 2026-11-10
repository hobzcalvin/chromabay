// Every operator in the WASM engine (the same C++ the firmware compiles), checked headlessly:
//  - it renders at its defaults on a matrix and on a 1-row strip without trapping;
//  - the editor's input count for it (operatorArity.ts, which decides the input handles and
//    which connections are allowed) matches the inputs the C++ actually reads, found by
//    rendering it twice with different pictures on each input. A node that showed an input it
//    ignores, or hid one it reads, fails here instead of confusing someone in the editor;
//  - generators produce something (not all black) and, unless static by design, animate.
import { test, expect, describe } from 'vitest';
import { operatorInputCount } from '../operatorArity';

const m: any = globalThis.__wasmModule;

function names(): string[] {
  const n = m.ccall('getOperatorCount', 'number', [], []);
  return Array.from({ length: n }, (_, i) => m.ccall('getOperatorName', 'string', ['number'], [i]));
}

type Pic = (x: number, y: number) => [number, number, number];
const picA: Pic = (x, y) => [(x * 37) & 255, (y * 53) & 255, 128];
const picB: Pic = (x, y) => [255 - ((x * 11) & 255), 40, (y * 29 + x * 5) & 255];
const gradA: Pic = (x, y) => [x * 9, y * 17, 200 - x * 4];
const gradB: Pic = (x) => [255 - x * 9, 128, x * 3];

/** Render `frames` frames (fresh instance) and return each frame's bytes. */
function render(op: string, W: number, H: number, in1: Pic | null, in2: Pic | null, times = [0, 16, 33, 50, 500, 1500]) {
  const id = m.ccall('createOperatorInstance', 'number', ['string'], [op]);
  expect(id).toBeGreaterThanOrEqual(0);
  const N = W * H * 3;
  const fill = (pic: Pic | null) => {
    if (!pic) return 0;
    const p = m._malloc(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b] = pic(x, y); const i = p + (y * W + x) * 3;
      m.HEAPU8[i] = r & 255; m.HEAPU8[i + 1] = g & 255; m.HEAPU8[i + 2] = b & 255;
    }
    return p;
  };
  const a = fill(in1), b = fill(in2), o = m._malloc(N);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const t of times) {
    m.HEAPU8.fill(0, o, o + N);
    m.ccall('renderOperator', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [id, a, b, o, W, H, t, Math.max(1, t - prev)]);
    prev = t;
    out.push(m.HEAPU8.slice(o, o + N));
  }
  for (const p of [a, b, o]) if (p) m._free(p);
  m.ccall('destroyOperatorInstance', null, ['number'], [id]);
  return out;
}
const same = (x: Uint8Array[], y: Uint8Array[]) => x.every((f, k) => f.every((v, i) => v === y[k][i]));

// Operators whose output may legitimately ignore an input at their DEFAULT parameters, or
// that are random so two renders differ regardless: compare with the deterministic check off.
const RANDOM = new Set(['fire', 'raindrops', 'movingblob', 'static', 'glitch', 'particles']);
// Generators that hold still by default (no speed/animation at defaults).
const STATIC_BY_DEFAULT = new Set(['solid', 'shape', 'gradient', 'test', 'text', 'svgfill', 'symbol', 'venn', 'clock']);

describe('operators', () => {
  const ops = names();

  test('the engine lists the operators', () => {
    expect(ops.length).toBeGreaterThan(40);
    for (const o of ['osc', 'shape', 'solid', 'voronoi', 'quasicrystal', 'pinwheel', 'particles', 'kaleid',
      'pixelate', 'threshold', 'coloradjust', 'polar', 'rgbsplit', 'gradmap', 'displace']) expect(ops).toContain(o);
  });

  for (const op of ops) {
    test(`${op}: renders on a matrix and a strip; input count matches the editor`, () => {
      for (const [W, H] of [[24, 12], [60, 1], [1, 1]] as const) {
        render(op, W, H, picA, picB, [0, 16]);
      }
      if (RANDOM.has(op)) return;
      const W = 24, H = 12;
      const base = render(op, W, H, picA, picB);
      // Feed both a busy picture and a smooth gradient: some operators (e.g. Displace with a
      // map that happens to be symmetric) only show their dependence on one of them.
      const reads1 = !same(base, render(op, W, H, picB, picB)) || !same(render(op, W, H, gradA, gradB), render(op, W, H, gradB, gradB));
      const reads2 = !same(base, render(op, W, H, picA, picA)) || !same(render(op, W, H, gradA, gradB), render(op, W, H, gradA, gradA));
      const expected = reads2 ? 2 : reads1 ? 1 : 0;
      expect(operatorInputCount(op), `${op} reads input1=${reads1} input2=${reads2}`).toBe(expected);

      if (expected === 0) {
        const lit = base.some((f) => f.some((v) => v > 0));
        expect(lit, `${op} renders all black at its defaults`).toBe(true);
        if (!STATIC_BY_DEFAULT.has(op)) {
          const moves = base.some((f, k) => k > 0 && f.some((v, i) => v !== base[0][i]));
          expect(moves, `${op} doesn't animate at its defaults`).toBe(true);
        }
      }
    });
  }
});

// A two-input operator other than Blend: its second input must survive save/load (the
// serializer used to special-case `blend` by name and dropped `i2` for anything else).
import { serializePattern, deserializePattern } from '../patternSerializer';
test('displace keeps both inputs through a save/load round trip', () => {
  const src = { nodes: [{ t: 'plasma', o: 0 }, { t: 'osc', o: 1 }, { t: 'displace', o: 0, i: 0, i2: 1 }], meta: { output: 0 } } as any;
  const g = deserializePattern(src);
  const handles = g.edges.filter((e: any) => g.nodes.find((n: any) => n.id === e.target)?.data.type === 'displace')
    .map((e: any) => e.targetHandle).sort();
  expect(handles).toEqual(['input-1', 'input-2']);
  const again = serializePattern(g.nodes, g.edges, g.nodeParameters);
  const d = again.nodes.find((n: any) => n.t === 'displace')!;
  expect(d.i).toBeDefined();
  expect(d.i2).toBeDefined();
  expect(d.i).not.toBe(d.i2);
});
