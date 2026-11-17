import { describe, it, expect } from 'vitest';
import { patternKey } from '../patternKey';

describe('patternKey', () => {
  it('uses meta.id, then meta.name', () => {
    expect(patternKey({ nodes: [], meta: { id: 'a', name: 'n', output: 1 } } as any, 0)).toBe('k:a');
    expect(patternKey({ nodes: [], meta: { name: 'n', output: 1 } } as any, 0)).toBe('k:n');
    expect(patternKey({ nodes: [], meta: { id: 'a', name: 'n', output: 1 } } as any, 0, 'name')).toBe('k:n');
  });

  it('gives unnamed patterns unique keys (no each_key_duplicate)', () => {
    const lib = [{ nodes: [] }, { nodes: [], meta: { output: 1 } }, { nodes: [], meta: { name: '', output: 1 } }] as any[];
    for (const by of ['id', 'name'] as const) {
      const keys = lib.map((p, i) => patternKey(p, i, by));
      expect(keys.every((k) => k !== undefined)).toBe(true);
      expect(new Set(keys).size).toBe(lib.length);
    }
  });
});
