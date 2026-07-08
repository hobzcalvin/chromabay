// Auth state backed by Supabase. Optional + local-first: when Supabase isn't configured,
// `isConfigured` is false and the app works exactly as before. Logging in is what unlocks the
// gallery + the synced owner-key keyring (see PATTERN_LIFECYCLE.md); it is never required.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { base } from '$app/paths';
import { supabase } from '../supabase';
import type { User } from '@supabase/supabase-js';

// Where the confirmation link should land. Must be allowlisted in Supabase
// (Auth → URL Configuration → Redirect URLs). Uses the current web origin so it works
// on both the deployed site and localhost; native (Capacitor) confirmation needs a
// universal link — see SETUP_GUIDE.md.
function redirectTo(): string | undefined {
  if (!browser) return undefined;
  const origin = window.location.origin;
  // Web (localhost dev or chromabay.app) → return to the same origin. Native app runs on
  // capacitor://localhost, which is a dead link in an email client — use the real https URL
  // instead (opens in Safari now; opens the app directly once Associated Domains is set up).
  if (origin.startsWith('http')) return `${origin}${base}/account`;
  return 'https://chromabay.app/account';
}

export const authUser = writable<User | null>(null);
export const authReady = writable(false);
export const isConfigured = !!supabase;
// True after arriving via a password-reset link — the account page then shows a
// "set a new password" form instead of the normal signed-in view.
export const recoveryMode = writable(false);

if (browser && supabase) {
  supabase.auth.getSession().then(({ data }) => {
    authUser.set(data.session?.user ?? null);
    authReady.set(true);
  });
  supabase.auth.onAuthStateChange((event, session) => {
    authUser.set(session?.user ?? null);
    if (event === 'PASSWORD_RECOVERY') recoveryMode.set(true);
  });
} else {
  authReady.set(true);
}

/**
 * Sign up. `alreadyRegistered` is GoTrue's enumeration-safe signal that the email is taken
 * (it returns a user with an empty `identities` array and does NOT send an email);
 * `needsConfirm` means a genuinely new account was created and must confirm via email.
 */
export async function signUp(
  email: string,
  password: string,
): Promise<{ needsConfirm: boolean; alreadyRegistered: boolean }> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) throw error;
  const alreadyRegistered = !data.session && (data.user?.identities?.length ?? 0) === 0;
  return { needsConfirm: !data.session && !alreadyRegistered, alreadyRegistered };
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}

/** Email a password-reset link (lands back on /account in recovery mode). */
export async function sendPasswordReset(email: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo() });
  if (error) throw error;
}

/** Set a new password (during recovery, or while signed in). */
export async function updatePassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  recoveryMode.set(false);
}

/** Resend the signup confirmation email (for a genuinely unconfirmed account). */
export async function resendConfirmation(email: string): Promise<void> {
  if (!supabase) throw new Error('Cloud sync is not configured');
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim(),
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) throw error;
}
