// Sentry (client). This is a static SvelteKit SPA that also runs inside the Capacitor iOS/Android
// WebView, so the browser SDK here covers web + mobile in one place — and it ships via the web
// hot-update (no native rebuild). Native crash reporting (@sentry/capacitor) is a separate,
// rebuild-required add if we ever want it.
import * as Sentry from '@sentry/sveltekit';
import { handleErrorWithSentry } from '@sentry/sveltekit';
import type { HandleClientError } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { Capacitor } from '@capacitor/core';

// Client DSN — write-only ingest key, safe to ship in a client bundle (it's public by nature).
const DSN = (import.meta as any).env?.VITE_SENTRY_DSN
  || 'https://3bb11192b1334f860c0e31fd7fe2c65b@o4511260075884544.ingest.us.sentry.io/4511695305900032';

Sentry.init({
  dsn: DSN,
  // Version baked in by the deploy workflow (VITE_VERSION); groups errors + replays by release.
  // `app` prefix so app and firmware releases are told apart at a glance — the firmware
  // reports `chromabay@fwv0.1.x` from its own build. They move independently: this updates
  // the moment someone loads the page, the firmware only when a user accepts an OTA. Must
  // match what deploy.yml registers with sentry-cli, or the release has no commits.
  release: `app${(import.meta as any).env?.VITE_VERSION || 'dev'}`,
  // 'web' in the browser; 'ios' / 'android' inside the Capacitor WebView.
  environment: dev ? 'development' : Capacitor.getPlatform(),

  // Everything on (per request). Adjust sample rates later if quota matters.
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 1.0,   // record every session
  replaysOnErrorSampleRate: 1.0,   // always keep a replay around an error
  sendDefaultPii: true,

  // Sentry Logs. The app already narrates itself to the console — BLE state, OTA progress,
  // every GATT failure — and until now all of it was invisible: caught errors become
  // breadcrumbs, never events, so a whole class of real problems (a wedged OTA, a link that
  // will not stay up) left no trace in Sentry at all.
  //
  // warn and error only, deliberately. `log` would forward the FPS counter and every pattern
  // sync, which is a lot of quota to spend on proving the device is fine. The device cannot
  // do any of this — sentry-micro has no logging API — so this is the only side that can.
  enableLogs: true,

  // A disconnected device is a fact of life on BLE, not a defect, and the app narrates it
  // from a dozen call sites. Dropping it here keeps Logs about things that are worth
  // reading. Belt and braces: the loop that generated 74,000 of these in a day is fixed in
  // DeviceSettingsPanel, but nothing should be one bug away from a quota incident.
  beforeSendLog: (log) => (log.message?.includes('Not connected to device') ? null : log),

  integrations: [
    Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    Sentry.browserTracingIntegration(),
    // Unmasked — this is our own editor, not a PII surface — so replays are actually legible.
    Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
    // Record the <canvas> previews too (the whole point of a visual LED tool).
    Sentry.replayCanvasIntegration(),
  ],
});

const _sentryHandleError = handleErrorWithSentry();

// Wrap the Sentry handler so we can react to stale-chunk errors that occur when
// a new deployment replaces content-hashed JS files while a user has the old
// version loaded.  We report to Sentry first (keeping full observability), then
// reload the page so the browser fetches the new chunks instead of showing a
// blank / broken state.
export const handleError: HandleClientError = async (input) => {
  await _sentryHandleError(input as any);

  const { error } = input;
  if (
    error instanceof TypeError &&
    error.message.includes('Failed to fetch dynamically imported module')
  ) {
    window.location.reload();
  }
};
