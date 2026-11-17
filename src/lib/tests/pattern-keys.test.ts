// Sentry CHROMABAY-APP-X: the Patterns page threw each_key_duplicate. Root cause: savePattern and
// renameCurrentPattern found the stored pattern by NAME, so with two patterns of the same name
// (cloud sync brings one made elsewhere) saving the selected one overwrote the OTHER entry with
// its id — two entries, one id, and the list is keyed by id.
import { test, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { uniqueKeys } from '$lib/patternKey';
import { patterns, currentPattern, savePattern, renameCurrentPattern, loadPatterns } from '$lib/stores/patternsStore';

const pat = (id: string, name: string, t = 'rainbow') => ({ nodes: [{ t, o: 0 }], meta: { id, name, output: 0, updatedAt: 1 } }) as any;
const ids = () => get(patterns).map((p) => p.meta?.id);

beforeEach(() => localStorage.clear());

test('saving one of two same-named patterns updates THAT one, not the other', async () => {
  localStorage.setItem('patterns', JSON.stringify([pat('A', 'Fire'), pat('B', 'Fire')]));
  await loadPatterns();
  await savePattern(pat('B', 'Fire', 'plasma'));
  expect(ids()).toEqual(['A', 'B']);
  expect(get(patterns).find((p) => p.meta?.id === 'B')!.nodes[0].t).toBe('plasma');
  expect(get(patterns).find((p) => p.meta?.id === 'A')!.nodes[0].t).toBe('rainbow');
});

test('renaming one of two same-named patterns renames THAT one', async () => {
  localStorage.setItem('patterns', JSON.stringify([pat('A', 'Fire'), pat('B', 'Fire')]));
  await loadPatterns();
  currentPattern.set(get(patterns)[1]);
  await renameCurrentPattern('Fire 2');
  expect(get(patterns).map((p) => `${p.meta?.id}:${p.meta?.name}`)).toEqual(['A:Fire', 'B:Fire 2']);
});

test('a library already holding a duplicate id is repaired on load', async () => {
  localStorage.setItem('patterns', JSON.stringify([pat('A', 'Fire'), pat('A', 'Fire'), pat('C', 'Ice')]));
  await loadPatterns();
  const list = ids();
  expect(new Set(list).size).toBe(3);
  expect(list[0]).toBe('A');
  expect(JSON.parse(localStorage.getItem('patterns')!).map((p: any) => p.meta.id)).toEqual(list); // persisted
});

test('saving a pattern without an id still matches by name (save-as overwrite)', async () => {
  localStorage.setItem('patterns', JSON.stringify([pat('A', 'Fire')]));
  await loadPatterns();
  await savePattern({ nodes: [{ t: 'plasma', o: 0 }], meta: { name: 'Fire', output: 0 } } as any);
  expect(get(patterns)).toHaveLength(1);
});

test('uniqueKeys never repeats, whatever the input', () => {
  const items = [{ k: 'a' }, { k: 'a' }, { k: undefined }, { k: '' }, { k: 'a#2' }, { k: 'a' }] as any[];
  const keys = uniqueKeys(items, (x) => x.k);
  expect(new Set(keys).size).toBe(items.length);
  expect(keys[0]).toBe('k:a');
  expect(uniqueKeys([{ k: 'x' }, { k: 'y' }], (x) => x.k)).toEqual(['k:x', 'k:y']); // stable for normal lists
});
