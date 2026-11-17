// Keys for keyed {#each} blocks over pattern lists. Svelte throws each_key_duplicate — taking the
// whole page down — if two items share a key, and pattern lists are built from data we don't
// fully control (a library merged from the cloud, a device's library read back over BLE while it
// was changing). The stores keep ids and names unique; this makes the rendering survive anyway.

/**
 * One key per item, unique by construction: the item's own key (id or name) when it has one,
 * suffixed on a repeat; its position when it has none.
 */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T) => string | null | undefined): string[] {
  const used = new Set<string>();
  return items.map((item, i) => {
    const base = keyOf(item);
    let key = base ? `k:${base}` : `i:${i}`;
    for (let n = 2; used.has(key); n++) key = base ? `k:${base}#${n}` : `i:${i}#${n}`;
    used.add(key);
    return key;
  });
}
