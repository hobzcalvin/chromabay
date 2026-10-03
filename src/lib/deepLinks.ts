// Universal Links (iOS Associated Domains) → in-app routing.
//
// The entitlement claims the whole domain (applinks:chromabay.app) and the AASA
// (static/.well-known/apple-app-site-association) matches "*", so EVERY chromabay.app link —
// tapped in Mail, Messages, Safari, wherever — opens ChromaBay instead of the browser and
// Capacitor fires `appUrlOpen`. We keep the user inside the app: rather than let the webview
// load the remote https URL (which would swap the local bundle for the deployed site), we map
// the incoming path to the matching in-app route and navigate the client router there. So a
// link to /patterns opens the Patterns page, /settings opens Settings, etc.
//
// Auth emails are the one case that needs extra work: the webview's window.location is
// capacitor://localhost, so Supabase can't auto-detect the session from the link — we parse
// the tokens off the URL ourselves and establish the session before routing to /settings.
import { Capacitor } from '@capacitor/core';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { supabase } from './supabase';
import { recoveryMode } from './stores/authStore';

// Only our own web domain routes into the app. (The entitlement only covers chromabay.app, so
// nothing else can reach here anyway, but be explicit.)
const APP_HOSTS = new Set(['chromabay.app', 'www.chromabay.app']);

// Auth params ride either flow: implicit (tokens in the URL hash) or PKCE (?code=). Supabase's
// verify endpoint 302s to redirectTo with them appended — a confirm link lands as
// .../account#access_token=…&type=signup, a reset as type=recovery.
function parseAuth(u: URL) {
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const q = u.searchParams;
  const get = (k: string) => hash.get(k) ?? q.get(k);
  return {
    access_token: get('access_token'),
    refresh_token: get('refresh_token'),
    code: q.get('code'),
    type: get('type'),
    error: get('error') || get('error_description'),
  };
}

/**
 * Route an incoming universal-link URL into the app (and, for auth links, establish the
 * session first). Returns false if the URL isn't one of ours (caller can ignore it).
 */
export async function handleDeepLink(rawUrl: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.hostname && !APP_HOSTS.has(u.hostname)) return false;

  const a = parseAuth(u);
  const hasAuth = !!(a.access_token || a.code || a.error);

  if (hasAuth) {
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
    // Land on /settings (Account is its first section) and drop the token-bearing hash from the visible URL.
    try { await goto(`${base}/settings`, { replaceState: true }); } catch { /* router not ready */ }
    return true;
  }

  // Any other chromabay.app link → the matching in-app route (preserve query + hash). We never
  // load the remote URL in the webview, so the local bundle stays put.
  const target = `${base}${u.pathname}${u.search}${u.hash}` || `${base}/`;
  try { await goto(target, { replaceState: false }); } catch { /* router not ready / unknown route */ }
  return true;
}

/** Register the native URL-open listener. No-op on web (the browser/Supabase handle it). */
export function initDeepLinks(): void {
  if (!Capacitor.isNativePlatform()) return;
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appUrlOpen', (event) => { void handleDeepLink(event.url); });
    // Cold start: the app may have been launched by the link before the listener existed.
    App.getLaunchUrl?.().then((l) => { if (l?.url) void handleDeepLink(l.url); }).catch(() => {});
  }).catch(() => {});
}
