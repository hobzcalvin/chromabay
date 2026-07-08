// Cloud sync for the pattern library (PATTERN_LIFECYCLE.md). When signed in, the local library
// syncs to Supabase's private `library_patterns` table and down to the user's other clients —
// last-writer-wins by `updated_ms`, with tombstones so deletes propagate and don't resurrect.
// Local-first: with no account (or no Supabase), this is inert and the app is unchanged.
import { get } from 'svelte/store';
import { browser } from '$app/environment';
import { supabase } from './supabase';
import { authUser } from './stores/authStore';
import {
  getStoredPatterns, getTombstones, applyRemoteLibrary, setLibraryChangeHook,
} from './stores/patternsStore';

let syncing = false;
let pending = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

type RemoteRow = { id: string; name: string; blob: any; deleted: boolean; updated_ms: number };

/** One full reconcile: pull remote → merge (LWW+tombstones) → push anything locally newer. */
export async function syncNow(): Promise<void> {
  if (!browser || !supabase) return;
  const uid = get(authUser)?.id;
  if (!uid) return;
  if (syncing) { pending = true; return; }
  syncing = true;
  try {
    // 1. Pull the user's rows (RLS scopes to this user).
    const { data, error } = await supabase
      .from('library_patterns')
      .select('id,name,blob,deleted,updated_ms');
    if (error) { console.warn('[sync] pull failed:', error.message); return; }
    const remote: RemoteRow[] = (data || []).map((r: any) => ({
      id: r.id, name: r.name, blob: r.blob, deleted: r.deleted, updated_ms: Number(r.updated_ms),
    }));

    // 2. Merge remote into the local store.
    await applyRemoteLibrary(remote);

    // 3. Push local records that are newer than (or missing from) remote.
    const remoteById = new Map(remote.map((r) => [r.id, r]));
    const local = await getStoredPatterns();
    const tombs = await getTombstones();
    const ups: any[] = [];
    for (const p of local) {
      const id = p.meta?.id;
      if (!id) continue;
      const ms = p.meta?.updatedAt ?? 0;
      const rr = remoteById.get(id);
      if (!rr || ms > rr.updated_ms) {
        ups.push({ id, user_id: uid, name: p.meta?.name || '', blob: p, deleted: false, updated_ms: ms });
      }
    }
    for (const t of tombs) {
      const rr = remoteById.get(t.id);
      if (!rr || t.ms > rr.updated_ms) {
        ups.push({ id: t.id, user_id: uid, name: '', blob: null, deleted: true, updated_ms: t.ms });
      }
    }
    if (ups.length) {
      const { error: upErr } = await supabase.from('library_patterns').upsert(ups);
      if (upErr) console.warn('[sync] push failed:', upErr.message);
    }
    console.log(`[sync] done — pulled ${remote.length}, pushed ${ups.length}`);
  } catch (e) {
    console.warn('[sync] error:', e);
  } finally {
    syncing = false;
    if (pending) { pending = false; scheduleSync(200); }
  }
}

function scheduleSync(delay = 1500): void {
  if (!browser) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void syncNow(); }, delay);
}

// --- Realtime: react to changes made on the user's OTHER open sessions ---------------------
let channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
async function subscribeRealtime(uid: string): Promise<void> {
  if (!supabase || channel) return;
  // Ensure Realtime uses the user's JWT so RLS scopes postgres_changes to their rows.
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (token) supabase.realtime.setAuth(token);
  channel = supabase
    .channel(`library:${uid}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'library_patterns', filter: `user_id=eq.${uid}` },
      () => scheduleSync(400), // a remote change → reconcile soon (self-echoes are LWW no-ops)
    )
    .subscribe();
}
function unsubscribeRealtime(): void {
  if (supabase && channel) { supabase.removeChannel(channel); channel = null; }
}

if (browser) {
  // Push (debounced) whenever the local library changes via a user edit/delete.
  setLibraryChangeHook(() => scheduleSync());
  // On sign-in: full reconcile + subscribe to realtime. On sign-out: drop the subscription.
  let lastUid: string | null = null;
  authUser.subscribe((u) => {
    const uid = u?.id ?? null;
    if (uid && uid !== lastUid) { lastUid = uid; void syncNow(); void subscribeRealtime(uid); }
    if (!uid && lastUid) { lastUid = null; unsubscribeRealtime(); }
  });
}
