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
