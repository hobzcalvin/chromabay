// Online pattern gallery (PATTERN_LIFECYCLE.md). Author-scoped: patterns show as
// "Name · by author"; publishing upserts by (author, name). Importing copies into your
// library attributed to the original author — editing it (which rebuilds meta without
// `author`) makes it yours, so an *unchanged* import stays "by <author>" and isn't a
// second copy you own. Adopting also registers an upvote. Public read; publish needs auth.
import { get } from 'svelte/store';
import { supabase } from './supabase';
import { authUser } from './stores/authStore';
import { importLibraryPattern } from './stores/patternsStore';
import type { SerializedPattern } from './patternSerializer';

/** Hash the pattern's *content* (nodes + output), independent of name/id/timestamps. */
export async function contentHash(p: SerializedPattern): Promise<string> {
  const norm = JSON.stringify({ nodes: p.nodes ?? [], output: p.meta?.output ?? 1 });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type GalleryPattern = {
  id: string;
  author: string | null;
  name: string;
  blob: SerializedPattern;
  content_hash: string | null;
  upvote_count: number;
  created_at: string;
  handle?: string; // author display name/handle, resolved from profiles
};

/** Publish the current pattern to the gallery (upsert by author+name). */
export async function publishPattern(p: SerializedPattern): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Cloud not configured' };
  const uid = get(authUser)?.id;
  if (!uid) return { ok: false, error: 'Sign in to publish' };
  const { error } = await supabase
    .from('patterns')
    .upsert(
      { author: uid, name: p.meta?.name || 'Untitled', blob: p, content_hash: await contentHash(p) },
      { onConflict: 'author,name' },
    );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Browse public gallery patterns (search by name; newest-highest-voted first). */
export async function browseGallery(opts: { search?: string; limit?: number } = {}): Promise<GalleryPattern[]> {
  if (!supabase) return [];
  let q = supabase
    .from('patterns')
    .select('id,author,name,blob,content_hash,upvote_count,created_at,profiles(handle,display_name)')
    .order('upvote_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 60);
  if (opts.search?.trim()) q = q.ilike('name', `%${opts.search.trim()}%`);
  const { data, error } = await q;
  if (error) { console.warn('[gallery] browse failed:', error.message); return []; }
  return (data || []).map((r: any) => ({
    ...r,
    handle: r.profiles?.handle || r.profiles?.display_name || 'anon',
  }));
}

/** Copy a gallery pattern into the local library (attributed to its author) + upvote it. */
export async function importGalleryPattern(g: GalleryPattern): Promise<{ name: string; collided: boolean }> {
  const incoming: SerializedPattern = {
    nodes: g.blob?.nodes ?? [],
    meta: {
      name: g.name,
      output: g.blob?.meta?.output ?? 1,
      author: g.author ?? undefined,
      sourceHash: g.content_hash ?? undefined,
    },
  };
  const res = await importLibraryPattern(incoming);
  // Adopting a pattern is an upvote (idempotent per user).
  const uid = get(authUser)?.id;
  if (supabase && uid) {
    await supabase.from('upvotes').upsert({ user_id: uid, pattern_id: g.id }).then(
      () => {},
      (e: any) => console.warn('[gallery] upvote failed:', e?.message),
    );
  }
  return res;
}
