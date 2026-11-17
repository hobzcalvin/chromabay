import type { SerializedPattern } from './patternSerializer';

/**
 * A key for a keyed `{#each}` over patterns that is never `undefined`. Patterns normally carry
 * a unique `meta.id` (My Patterns) or `meta.name` (device libraries, keyed by name on the
 * device), but entries without either (e.g. read back from a device that stored them without a
 * name) would all key to `undefined`, and Svelte throws `each_key_duplicate` for the whole page.
 * Those fall back to their position in the list.
 */
export function patternKey(
  p: SerializedPattern | null | undefined,
  index: number,
  by: 'id' | 'name' = 'id',
): string {
  const meta = p?.meta;
  const k = by === 'id' ? (meta?.id || meta?.name) : meta?.name;
  return k ? `k:${k}` : `idx:${index}`;
}
