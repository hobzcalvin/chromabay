// A Random/Perlin automation's seed is saved with the pattern (`sd`). Node ids are regenerated on
// every load, so the seed must come back from the saved value rather than being re-derived —
// otherwise the automation changes after every reload and previews disagree with the device.
import { test, expect } from 'vitest';
import { serializePattern, deserializePattern, type SerializedPattern } from '../patternSerializer';
import { NODE_TYPES } from '../flowStore';

test('a saved automation seed survives load → save → load', async () => {
  const def = NODE_TYPES.find((n) => n.type === 'rainbow')!;
  const param = def.params.find((p) => p.type === 'float' || p.type === 'integer')!.name;
  const stored = {
    nodes: [{ t: 'rainbow', o: 1, m: { [param]: { s: 4, lo: 0, hi: 1, pr: 1, sd: 12345 } } }],
    meta: { output: 1 },
  } as unknown as SerializedPattern;

  const first = deserializePattern(stored);
  const saved = serializePattern(first.nodes, first.edges, first.nodeParameters, 'x');
  expect((saved.nodes[0].m as any)[param].sd).toBe(12345);

  await new Promise((r) => setTimeout(r, 5)); // node ids embed Date.now()
  const second = deserializePattern(saved);
  const again = serializePattern(second.nodes, second.edges, second.nodeParameters, 'x');
  expect((again.nodes[0].m as any)[param].sd).toBe(12345);
});
