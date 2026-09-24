// Nodes share lanes (buffers), and a modifier writes back into its source's lane. Execution
// order therefore matters beyond data dependencies: an in-place writer must not run before a
// reader of the value it overwrites, and the node feeding Output must be the LAST writer of its
// lane (the device shows whatever that lane holds at the end of the frame). Both graphs below
// are accepted by the editor's own connection check, and both used to come back rewired after a
// save/load round trip — which is also what the device was rendering.
import { test, expect } from 'vitest';
import { serializePattern, deserializePattern } from '../patternSerializer';
import { LANES, isValidConnectionWithBuffers } from '../flowStore';

const N = (id: string, type: string, x: number, y: number) =>
  ({ id, type: 'pattern', position: { x, y }, data: { type, label: type } }) as any;
const E = (s: string, t: string, th = 'input') =>
  ({ id: `e${s}-${t}-${th}`, source: s, target: t, sourceHandle: 'output', targetHandle: th }) as any;

function roundTrip(nodes: any[], edgeList: any[]): string[] {
  const edges: any[] = [];
  for (const e of edgeList) {
    expect(isValidConnectionWithBuffers(e, nodes, edges)).toBe(true);
    edges.push(e);
  }
  const g = deserializePattern(serializePattern(nodes, edges, new Map(), 't'), { applyInteractiveParameters: false });
  const typeOf = (id: string) => g.nodes.find((n) => n.id === id)!.data.type;
  return g.edges.map((e) => `${typeOf(e.source)}-${e.targetHandle}->${typeOf(e.target)}`).sort();
}

test('an in-place modifier runs after every other reader of the lane it overwrites', () => {
  // rainbow G feeds both invert X (in place, LEFT lane) and blend Z's first input.
  const nodes = [
    N('G', 'rainbow', LANES.LEFT, 0), N('X', 'invert', LANES.LEFT, 100),
    N('V', 'plasma', LANES.CENTER, 0), N('W', 'invert', LANES.CENTER, 100),
    N('Z', 'blend', LANES.RIGHT, 200), N('O', 'output', LANES.RIGHT, 300),
  ];
  const sig = roundTrip(nodes, [E('G', 'X'), E('V', 'W'), E('G', 'Z', 'input-1'), E('W', 'Z', 'input-2'), E('Z', 'O')]);
  expect(sig).toContain('rainbow-input-1->blend');
  expect(sig).not.toContain('invert-input-1->blend');
});

test('the node feeding Output is the last writer of its lane', () => {
  // Displayed chain rainbow → invert → Output; an unconnected plasma → mirror chain shares the lane.
  const nodes = [
    N('G', 'rainbow', LANES.LEFT, 0), N('X', 'invert', LANES.LEFT, 100),
    N('Y', 'plasma', LANES.LEFT, 300), N('Z', 'mirror', LANES.LEFT, 400),
    N('O', 'output', LANES.LEFT, 500),
  ];
  const sig = roundTrip(nodes, [E('G', 'X'), E('X', 'O'), E('Y', 'Z')]);
  expect(sig.some((s) => s.startsWith('invert-') && s.endsWith('->output'))).toBe(true);
  expect(sig.some((s) => s.startsWith('mirror-') && s.endsWith('->output'))).toBe(false);
});

// What the device shows: run the serialized nodes in order over the three lane buffers.
function displayed(nodes: any[], edges: any[]): string {
  for (const [i, e] of edges.entries()) expect(isValidConnectionWithBuffers(e, nodes, edges.slice(0, i))).toBe(true);
  const p = serializePattern(nodes, edges, new Map(), 't');
  const buf = ['', '', ''];
  for (const n of p.nodes) {
    const a = n.i === undefined ? '' : buf[n.i], b = n.i2 === undefined ? '' : buf[n.i2];
    buf[n.o] = n.t === 'blend' ? `blend(${a},${b})` : a ? `${n.t}(${a})` : n.t;
  }
  return buf[p.meta.output];
}

test('an unrelated generator in the Output lane runs before the node feeding Output', () => {
  // The level-based reader-first pass used to move gradient B ahead of fire F, across the
  // ordering edge that says F must run first, so the device showed fire.
  const nodes = [
    N('M', 'blur', LANES.RIGHT, 0), N('A', 'gradient', LANES.RIGHT, 100),
    N('B', 'gradient', LANES.CENTER, 200), N('F', 'fire', LANES.CENTER, 300),
    N('O', 'output', LANES.RIGHT, 400),
  ];
  expect(displayed(nodes, [E('A', 'M'), E('B', 'O')])).toBe('gradient');
});

test('a second reader of a value runs before an in-place writer, even across lanes', () => {
  // rainbow R feeds invert X (other lane) and mirror Y (in place, displayed); plasma P shares R's lane.
  const nodes = [
    N('R', 'rainbow', LANES.CENTER, 0), N('P', 'plasma', LANES.CENTER, 100),
    N('Y', 'mirror', LANES.CENTER, 200), N('X', 'invert', LANES.RIGHT, 200),
    N('O', 'output', LANES.CENTER, 300),
  ];
  expect(displayed(nodes, [E('R', 'X'), E('Y', 'O'), E('R', 'Y')])).toBe('mirror(rainbow)');
});

test('when no order can honour every connection, the displayed chain wins', () => {
  // blend Z overwrites rainbow's lane in place, so mirror M must read rainbow first; M then
  // writes the lane invert V is waiting in. Something has to give: not the display.
  const nodes = [
    N('V', 'invert', LANES.RIGHT, 0), N('M', 'mirror', LANES.RIGHT, 100),
    N('Z', 'blend', LANES.LEFT, 200), N('R', 'rainbow', LANES.LEFT, 0),
    N('O', 'output', LANES.RIGHT, 300),
  ];
  expect(displayed(nodes, [E('M', 'O'), E('V', 'Z', 'input-2'), E('R', 'Z', 'input-1'), E('R', 'M')])).toBe('mirror(rainbow)');
});
