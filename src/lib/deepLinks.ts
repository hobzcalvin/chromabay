// Universal Links (iOS Associated Domains) → in-app routing.
//
// Auth emails (confirm signup / password reset) point at https://chromabay.app/account…
// (see authStore.redirectTo). On the web that URL just loads the site and Supabase's
// detectSessionInUrl parses the tokens. In the native app the same https link is claimed by
// the Associated Domains entitlement (applinks:chromabay.app, scoped to /account* and /auth*
// in static/.well-known/apple-app-site-association), so iOS opens ChromaBay instead of
// Safari and Capacitor fires `appUrlOpen`. But the webview's window.location is
// capacitor://localhost — NOT the incoming URL — so Supabase can't auto-detect the session.
// We parse the tokens off the incoming URL ourselves and establish the session, then route
// to the matching in-app page.
import { Capacitor } from '@capacitor/core';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { supabase } from './supabase';
import { recoveryMode } from './stores/authStore';

// Pull auth params from either flow: implicit (tokens in the URL hash) or PKCE (?code=).
// Supabase's verify endpoint 302s to redirectTo with the tokens appended, so a confirm link
// lands as .../account#access_token=…&refresh_token=…&type=signup and a reset as type=recovery.
function parseAuth(rawUrl: string) {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const query = u.searchParams;
  const get = (k: string) => hash.get(k) ?? query.get(k);
  return {
    path: u.pathname || '/account',
    access_token: get('access_token'),
    refresh_token: get('refresh_token'),
    code: query.get('code'),
    type: get('type'),
    error: get('error') || get('error_description'),
  };
}

/**
 * Establish the Supabase session carried by a universal-link URL and navigate to its page.
 * Safe to call for any incoming URL — returns false (does nothing) if it carries no auth.
 */
export async function handleAuthUrl(rawUrl: string): Promise<boolean> {
  const a = parseAuth(rawUrl);
  if (!a) return false;
  const isAuthPath = /\/(account|auth)(\/|$|#|\?)/.test(a.path) || a.path.endsWith('/account');
  if (!a.access_token && !a.code && !a.error) return false;

  try {
    if (supabase && a.access_token && a.refresh_token) {
      await supabase.auth.setSession({ access_token: a.access_token, refresh_token: a.refresh_token });
    } else if (supabase && a.code) {
      await supabase.auth.exchangeCodeForSession(a.code);
    }
    // A reset link fires SIGNED_IN via setSession (not PASSWORD_RECOVERY), so flip recovery
    // mode ourselves — the account page then shows the "set a new password" form.
    if (a.type === 'recovery') recoveryMode.set(true);
  } catch (e) {
    console.error('deepLinks: failed to establish session from link', e);
  }

  // Route into the app. Land on /account for auth links (any other in-app path passes through).
  const target = isAuthPath || a.access_token || a.code ? `${base}/account` : `${base}${a.path}`;
  try { await goto(target, { replaceState: true }); } catch { /* router not ready yet */ }
  return true;
}

/** Register the native URL-open listener. No-op on web (Supabase handles it there). */
export function initDeepLinks(): void {
  if (!Capacitor.isNativePlatform()) return;
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appUrlOpen', (event) => { void handleAuthUrl(event.url); });
    // Cold start: the app may have been launched by the link before the listener existed.
    App.getLaunchUrl?.().then((l) => { if (l?.url) void handleAuthUrl(l.url); }).catch(() => {});
  }).catch(() => {});
}
