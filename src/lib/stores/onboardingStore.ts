// First-run onboarding: a welcome card, then an optional short tour of the bottom-nav tabs.
// Shown once per browser/app install; "seen" is remembered in localStorage (wrapped — private
// mode and cleared storage just mean it shows again, never that it throws). The Account page
// can replay it at any time.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const SEEN_KEY = 'chromabay:onboarded';

/** 'welcome' = the intro card, number = index into the tour steps, null = closed. */
export const onboardingStep = writable<'welcome' | number | null>(null);

function hasSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

export function markOnboardingSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
}

/** Called once from the root layout. Opens the welcome card for first-time visitors. */
export function maybeStartOnboarding() {
  if (!browser || hasSeen()) return;
  // Someone opening a shared-pattern link (…/editor#p=…) came to see that pattern; don't cover
  // it. They aren't marked as onboarded, so the welcome shows on their next visit instead.
  if (/[#&]p=/.test(location.hash)) return;
  onboardingStep.set('welcome');
}

/** Replay from the Account page. */
export function startOnboarding() {
  onboardingStep.set('welcome');
}

export function closeOnboarding() {
  markOnboardingSeen();
  onboardingStep.set(null);
}
