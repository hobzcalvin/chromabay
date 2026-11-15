/**
 * Release channels: the main line, plus any number of experimental branches.
 *
 * A branch becomes an experimental channel by carrying an `experimental.json` at the repo root
 * ({ "id": "audio", "title": "...", "description": "..." }). On every push to it, CI
 * (.github/workflows/experimental.yml) builds the app and the firmware exactly like a main
 * release and publishes them under https://chromabay.app/x/<id>/:
 *
 *   x/<id>/                      the web app (base path /x/<id>)
 *   x/<id>/version.json          its live-update manifest (the iOS app's bundle)
 *   x/<id>/firmware/esp32/...    its firmware registry, signed like main's
 *   x/channels.json              every live channel (deleting the branch removes its entry)
 *
 * The web app switches channel by navigating there; the iOS app downloads that channel's
 * bundle and restarts into it. Firmware has its own channel choice on the Devices page, which
 * defaults to the app's channel; installing "main" again is how a device goes back.
 */
import { writable, get } from 'svelte/store';
import { Capacitor } from '@capacitor/core';

export const SITE = 'https://chromabay.app';

/** The channel this build was made for: '' = main. Baked in by CI (VITE_CHANNEL). */
export const BUILD_CHANNEL: string = (import.meta.env.VITE_CHANNEL as string | undefined) || '';
export const BUILD_CHANNEL_TITLE: string = (import.meta.env.VITE_CHANNEL_TITLE as string | undefined) || BUILD_CHANNEL;

export interface Channel {
  id: string;           // url slug: chromabay.app/x/<id>/
  title: string;
  description?: string;
  branch?: string;
  appVersion?: string;
  commit?: string;
  updated?: string;     // ISO date of the last app deploy
}

export const MAIN_CHANNEL: Channel = { id: '', title: 'Main', description: 'The released app and firmware.' };

const channelRoot = (id: string) => (id ? `${SITE}/x/${id}` : SITE);

/**
 * Experimental channels that currently exist. Never throws: [] when there are none (no index
 * published yet counts as none), null when the list couldn't be fetched (offline).
 */
export async function fetchChannels(): Promise<Channel[] | null> {
  try {
    const r = await fetch(`${SITE}/x/channels.json?t=${Date.now()}`, { cache: 'no-cache' });
    if (r.status === 404) return [];
    if (!r.ok) return null;
    const list = await r.json();
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && c.id) : [];
  } catch {
    return null;
  }
}

// ---- Firmware channel ---------------------------------------------------------------------

// Per app build: on the web every channel shares one origin, so one key would make the main
// app's choice leak into a channel build (and back).
const FW_KEY = `chromabay:firmwareChannel:${BUILD_CHANNEL || 'main'}`;
function loadFwChannel(): string {
  try { const v = localStorage.getItem(FW_KEY); if (v !== null) return v; } catch { /* no storage */ }
  return BUILD_CHANNEL;
}

/** Which channel's firmware the Devices page offers. Defaults to the app's own channel. */
export const firmwareChannel = writable<string>(typeof localStorage !== 'undefined' ? loadFwChannel() : BUILD_CHANNEL);

/** Pick the firmware channel (remembered for this app build). */
export function setFirmwareChannel(id: string): void {
  firmwareChannel.set(id);
  try { localStorage.setItem(FW_KEY, id); } catch { /* no storage */ }
}

export function firmwareRegistryUrl(channel = get(firmwareChannel)): string {
  return `${channelRoot(channel)}/firmware/esp32/esp32_firmware_registry.json`;
}

/** The USB flasher's (esp-web-tools) manifest for a channel. */
export function firmwareManifestUrl(channel = get(firmwareChannel)): string {
  return `${channelRoot(channel)}/firmware/esp32/chromabay-manifest.json`;
}

/**
 * A firmware version built for an experimental channel ends in "-<id>" (CI stamps it), e.g.
 * fwv0.1.12-audio. Returns the id, or '' for a main build.
 */
export function firmwareVersionChannel(version: string | undefined): string {
  const m = /^fwv\d+\.\d+\.\d+-([a-z0-9-]+)$/.exec(version ?? '');
  return m ? m[1] : '';
}

// ---- Switching the app --------------------------------------------------------------------

/**
 * Move this app to another channel. Web: navigate to that channel's copy of the site (same
 * origin, so patterns and settings come along). iOS: download that channel's live-update
 * bundle and restart into it. Resolves only on failure (with the reason); on success the page
 * goes away.
 */
export async function switchAppChannel(id: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const onSite = typeof location !== 'undefined' && location.hostname === 'chromabay.app';
    const root = onSite ? (id ? `/x/${id}/` : '/') : `${channelRoot(id)}/`;
    location.href = root;
    return '';
  }
  try {
    const { LiveUpdate } = await import('@capawesome/capacitor-live-update');
    const r = await fetch(`${channelRoot(id)}/version.json?t=${Date.now()}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`no build published for ${id || 'main'} (HTTP ${r.status})`);
    const manifest = await r.json();
    const bundleId = `github-pages-${manifest.version}`;
    try {
      await LiveUpdate.downloadBundle({ url: manifest.downloadUrl, bundleId });
    } catch (e: any) {
      if (!String(e?.errorMessage ?? e?.message ?? e).includes('already exists')) throw e;
    }
    await LiveUpdate.setNextBundle({ bundleId });
    await LiveUpdate.reload();
    return '';
  } catch (e: any) {
    if (!id) {
      // Going back to main must always work: fall back to the bundle the App Store installed.
      try {
        const { LiveUpdate } = await import('@capawesome/capacitor-live-update');
        await LiveUpdate.reset();
        await LiveUpdate.reload();
        return '';
      } catch { /* report the original error */ }
    }
    return String(e?.errorMessage ?? e?.message ?? e);
  }
}

/** The live-update manifest this build should follow (its own channel's). */
export function liveUpdateManifestUrl(): string {
  return `${channelRoot(BUILD_CHANNEL)}/version.json`;
}
