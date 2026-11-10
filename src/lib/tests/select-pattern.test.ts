// Two quick taps on different patterns, where the first tap's "leave Cycle" step is slow (a BLE
// write to a busy device) and the second's is fast. The selection the user made LAST must win in
// every store: the current name, and the graph in the editor (which is what gets pushed to the
// devices and what the next autosave writes under that name). Run independently, as the
// selections used to, the slow first tap finished last and left the editor on the wrong pattern.
import { test, expect } from 'vitest';
import { get } from 'svelte/store';
import { selectPattern, flowNodes } from '../flowStore';
import { patterns, currentPatternName } from '../stores/patternsStore';

const A = { nodes: [{ t: 'plasma', o: 0 }], meta: { name: 'A', output: 0 } } as any;
const B = { nodes: [{ t: 'fire', o: 0 }, { t: 'blur', o: 0, i: 0 }], meta: { name: 'B', output: 0 } } as any;
const sleep = (ms: number) => () => new Promise((r) => setTimeout(r, ms));
const editorTypes = () => get(flowNodes).map((n: any) => n.data.type).filter((t: string) => t !== 'output').sort();

test('the last of two quick selections wins, even when the first is slower', async () => {
  patterns.set([A, B]);
  const first = selectPattern(A, sleep(150));
  const second = selectPattern(B, sleep(5));
  await Promise.all([first, second]);
  expect(get(currentPatternName)).toBe('B');
  expect(editorTypes()).toEqual(['blur', 'fire']);

  // And back again, three taps deep.
  await Promise.all([selectPattern(B, sleep(80)), selectPattern(A, sleep(40)), selectPattern(B, sleep(1)), selectPattern(A, sleep(1))]);
  expect(get(currentPatternName)).toBe('A');
  expect(editorTypes()).toEqual(['plasma']);
});
