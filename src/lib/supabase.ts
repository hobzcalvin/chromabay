// Supabase client — the cloud backend for the pattern-lifecycle plan (account = synced
// keyring, gallery). DORMANT: nothing in the app imports this yet, so it has zero effect
// on the local-first experience until we wire up auth/gallery UI. Requires
// `npm install @supabase/supabase-js` and the VITE_SUPABASE_* env vars (see .env.example).
//
// `supabase` is null when unconfigured, so callers must guard: `if (!supabase) return;`.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null;

export const isSupabaseConfigured = (): boolean => supabase !== null;
