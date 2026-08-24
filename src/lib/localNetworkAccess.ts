// Chrome 147 extended Local Network Access (LNA) permission prompts to WebSockets.
// That lets an HTTPS page open ws:// to an explicit .local name or private IP after the
// user grants access. Safari/Firefox still treat that as blocked mixed content.
export const CHROMIUM_LNA_WEBSOCKET_MIN_VERSION = 147;

export function chromiumMajorVersion(userAgent: string): number | null {
  // Deliberately exclude CriOS: Chrome on iOS uses WebKit, which does not implement this.
  const match = userAgent.match(/(?:Chrome|Chromium|Edg|OPR)\/(\d+)/);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isFinite(version) ? version : null;
}

export function canUseWebWifi(protocol: string, userAgent: string): boolean {
  // The local development origin can already use cleartext local WebSockets.
  if (protocol === 'http:') return true;
  if (protocol !== 'https:') return false;

  const chromiumVersion = chromiumMajorVersion(userAgent);
  return chromiumVersion !== null
    && chromiumVersion >= CHROMIUM_LNA_WEBSOCKET_MIN_VERSION;
}
