// Online pattern gallery (documentation/PATTERN_LIFECYCLE.md). Author-scoped: patterns show as
// "Name · by author"; publishing upserts by (author, name). Importing copies into your
// library attributed to the original author — editing it (which rebuilds meta without
// `author`) makes it yours, so an *unchanged* import stays "by <author>" and isn't a
// second copy you own. Adopting also registers an upvote. Public read; publish needs auth.
import { get } from 'svelte/store';
import { supabase } from './supabase';
import { authUser } from './stores/authStore';
import { importLibraryPattern, updateImportedPattern } from './stores/patternsStore';
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

export type GallerySort = 'top' | 'new';

/**
 * Browse public gallery patterns (search by name). `top` = most upvoted first, `new` = newest
 * first. Throws on a network/database error so the caller can say so instead of silently
 * showing nothing (a swallowed error used to look exactly like an empty gallery).
 */
export async function browseGallery(
  opts: { search?: string; limit?: number; sort?: GallerySort } = {},
): Promise<GalleryPattern[]> {
  if (!supabase) return [];
  let q = supabase
    .from('patterns')
    .select('id,author,name,blob,content_hash,upvote_count,created_at,profiles(handle,display_name)');
  q = opts.sort === 'new'
    ? q.order('created_at', { ascending: false })
    : q.order('upvote_count', { ascending: false }).order('created_at', { ascending: false });
  q = q.limit(opts.limit ?? 60);
  // PostgREST `ilike` treats % and _ as wildcards; escape them so a search is literal.
  const term = opts.search?.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  if (term) q = q.ilike('name', `%${term}%`);
  const { data, error } = await q;
  if (error) {
    console.warn('[gallery] browse failed:', error.message);
    throw new Error(error.message);
  }
  return (data || [])
    // A row without a usable blob can't be previewed or imported; skip it rather than crash.
    .filter((r: any) => r?.blob && Array.isArray(r.blob.nodes))
    .map((r: any) => ({
      ...r,
      handle: r.profiles?.handle || r.profiles?.display_name || 'anon',
    }));
}

/** Remove one of YOUR published patterns from the gallery (RLS: author only). */
export async function unpublishPattern(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Cloud not configured' };
  const uid = get(authUser)?.id;
  if (!uid) return { ok: false, error: 'Sign in to unpublish' };
  const { error } = await supabase.from('patterns').delete().eq('id', id).eq('author', uid);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * When someone opens a share LINK for a pattern that's also published in the gallery, count it as
 * an upvote (adoption = upvote, same as importing from the gallery). Matches by content hash, so it
 * works for any copy of the same pattern; no-op if the pattern isn't published or the user is signed
 * out. Fire-and-forget.
 */
export async function upvoteSharedIfPublished(p: SerializedPattern): Promise<void> {
  if (!supabase) return;
  const uid = get(authUser)?.id;
  if (!uid) return;
  try {
    const hash = p.meta?.sourceHash || (await contentHash(p));
    const { data } = await supabase.from('patterns').select('id').eq('content_hash', hash).limit(1);
    const id = data?.[0]?.id;
    if (id) await supabase.from('upvotes').upsert({ user_id: uid, pattern_id: id });
  } catch (e: any) {
    console.warn('[gallery] shared-link upvote failed:', e?.message);
  }
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
  // A newer version of something you imported (and haven't edited) replaces that copy rather
  // than landing next to it as "Name 2".
  const updated = await updateImportedPattern(incoming);
  const res = updated ? { name: updated.name, collided: false } : await importLibraryPattern(incoming);
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
