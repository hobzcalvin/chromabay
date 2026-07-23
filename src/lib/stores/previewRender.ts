// Shared preview-render registry. The old PatternPreview ran a FULL render pipeline
// (hidden SvelteFlow graph + WASM operators) per instance, so the same pattern shown in
// several places (My Patterns list + Per Device + …) rendered N times — wasteful, and the
// copies could drift out of sync. Now each UNIQUE pattern renders ONCE: a single
// PatternRenderSource per key produces frames here, and every visible PatternPreview just
// blits the latest frame to its own <canvas>. Keyed by content hash, so identical patterns
// share a source and an edit (new content) naturally gets its own.
import { writable } from 'svelte/store';
import type { SerializedPattern } from '$lib/patternSerializer';

export interface PreviewEntry {
  key: string;
  pattern: SerializedPattern;
  refCount: number;
  frame: ImageData | null; // latest rendered output; consumers poll this in their own rAF
}

const entries = new Map<string, PreviewEntry>();
// List of live entries (changes only on acquire/release) — drives the host that mounts one
// render source per entry. Frames are NOT pushed through the store (that would churn 60×/s);
// consumers read entry.frame directly.
export const activePreviews = writable<PreviewEntry[]>([]);
const publishList = () => activePreviews.set([...entries.values()]);

// Cheap stable key for a pattern's content (djb2 over its JSON). Same content → same key →
// one shared source; editing changes the content → a new key.
function keyFor(p: SerializedPattern): string {
  let s: string;
  try { s = JSON.stringify(p); } catch { s = 'x' + Math.random(); }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

/** Register interest in rendering `pattern`; returns its key. Call releasePreview(key) later. */
export function acquirePreview(pattern: SerializedPattern): string {
  const key = keyFor(pattern);
  let e = entries.get(key);
  if (!e) { e = { key, pattern, refCount: 0, frame: null }; entries.set(key, e); publishList(); }
  e.refCount++;
  return key;
}

export function releasePreview(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  if (--e.refCount <= 0) { entries.delete(key); publishList(); }
}

/** A render source publishes its latest output frame for a key. */
export function publishPreviewFrame(key: string, frame: ImageData): void {
  const e = entries.get(key);
  if (e) e.frame = frame;
}

export function previewEntry(key: string): PreviewEntry | undefined { return entries.get(key); }
