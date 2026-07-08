// Auth state backed by Supabase. Optional + local-first: when Supabase isn't configured,
// `isConfigured` is false and the app works exactly as before. Logging in is what unlocks the
// gallery + the synced owner-key keyring (see PATTERN_LIFECYCLE.md); it is never required.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { supabase } from '../supabase';
import type { User } from '@supabase/supabase-js';

export const authUser = writable<User | null>(null);
export const authReady = writable(false);
export const isConfigured = !!supabase;

if (browser && supabase) {
  supabase.auth.getSession().then(({ data }) => {
    authUser.set(data.session?.user ?? null);
    authReady.set(true);
  });
  supabase.auth.onAuthStateChange((_event, session) => authUser.set(session?.user ?? null));
} else {
  authReady.set(true);
}

/** Sign up. Returns whether a session was created immediately (false ⇒ email confirmation needed). */
export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return { needsConfirm: !data.session };
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}
