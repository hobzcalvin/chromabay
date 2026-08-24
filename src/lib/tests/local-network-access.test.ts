import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_LNA_WEBSOCKET_MIN_VERSION,
  canUseWebWifi,
  chromiumMajorVersion
} from '$lib/localNetworkAccess';

describe('web local-network access gating', () => {
  it('keeps local HTTP development available in every browser', () => {
    expect(canUseWebWifi('http:', 'Mozilla/5.0 Safari/605.1.15')).toBe(true);
  });

  it('enables production HTTPS in Chrome 147 and later', () => {
    const chrome147 = 'Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36';
    const edge151 = 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';
    expect(canUseWebWifi('https:', chrome147)).toBe(true);
    expect(canUseWebWifi('https:', edge151)).toBe(true);
  });

  it('does not promise support before WebSocket LNA shipped', () => {
    const chrome146 = 'Mozilla/5.0 Chrome/146.0.0.0 Safari/537.36';
    expect(canUseWebWifi('https:', chrome146)).toBe(false);
  });

  it('leaves HTTPS hidden in engines that still block mixed local WebSockets', () => {
    const safari = 'Mozilla/5.0 Version/18.6 Safari/605.1.15';
    const firefox = 'Mozilla/5.0 Firefox/142.0';
    const chromeOnIos = 'Mozilla/5.0 CriOS/151.0.0.0 Mobile/15E148 Safari/604.1';
    expect(canUseWebWifi('https:', safari)).toBe(false);
    expect(canUseWebWifi('https:', firefox)).toBe(false);
    expect(canUseWebWifi('https:', chromeOnIos)).toBe(false);
  });

  it('extracts the Chromium milestone used by the gate', () => {
    expect(chromiumMajorVersion(`Chrome/${CHROMIUM_LNA_WEBSOCKET_MIN_VERSION}.0.0.0`))
      .toBe(CHROMIUM_LNA_WEBSOCKET_MIN_VERSION);
  });
});
