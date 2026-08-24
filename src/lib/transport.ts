// One wire-level interface for talking to a ChromaBay device, whatever the link.
//
// The protocol is singular. Bluetooth defines it: a set of characteristics you read, write,
// and subscribe to. Wi-Fi is not a second protocol — it is the same characteristics carried
// over a WebSocket. So everything above this file (all of ble.ts's high-level operations, the
// whole devices UI, the Sentry relay, OTA) is written once against `Transport` and works over
// either link with the same bytes, the same chunking, and the same ordering.
//
// The one rule that keeps it that way: nothing above this layer may branch on transport.
// If a capability needs a transport-specific fast path, it belongs *inside* an implementation
// of this interface, behind an op that both can honour.

/** A characteristic address. `service` is carried for BLE's sake; Wi-Fi ignores it. */
export interface CharRef {
  service: string;
  characteristic: string;
}

export interface Transport {
  /** Stable device id — a BLE deviceId, or `wifi:<host>`. */
  readonly id: string;
  readonly kind: 'ble' | 'wifi';
  readonly connected: boolean;
  /**
   * Largest payload that may be handed to a normal, acknowledged write. Callers that chunk
   * MUST respect this rather than assuming BLE's limit. BLE keeps this conservative because
   * long acknowledged writes have proved unreliable on real devices; WebSocket can use a
   * much larger frame.
   */
  readonly maxWriteLen: number;
  /**
   * Largest payload for writeStream(), where the caller supplies its own flow control. OTA
   * uses this: BLE can safely use its full write-without-response size, while WebSocket can
   * send a flash-friendly multi-kilobyte block.
   */
  readonly maxStreamWriteLen: number;
  read(service: string, characteristic: string): Promise<DataView>;
  write(service: string, characteristic: string, value: DataView): Promise<void>;
  writeWithoutResponse(service: string, characteristic: string, value: DataView): Promise<void>;
  /**
   * Bulk write that skips the transport's own serialization queue. For transfers where the
   * CALLER does the flow control (OTA's ACK-driven sliding window) — going through the queue
   * there would serialize the window down to stop-and-wait and defeat the point.
   */
  writeStream(service: string, characteristic: string, value: DataView): Promise<void>;
  startNotifications(service: string, characteristic: string, cb: (v: DataView) => void): Promise<void>;
  stopNotifications(service: string, characteristic: string): Promise<void>;
  disconnect(): Promise<void>;
}

// --- Wi-Fi framing -------------------------------------------------------------------
// A WebSocket binary message is [u8 channel][u8 op][payload]. The op byte mirrors the three
// things BLE can do to a characteristic, so the firmware routes a Wi-Fi message into exactly
// the same handler its BLE characteristic would have called.
export const OP = {
  WRITE: 0x00, // app → device: the bytes a BLE write would have carried
  READ: 0x01,  // app → device: "send me your value" (device answers with VALUE)
  VALUE: 0x02, // device → app: a read reply OR an unsolicited notify (BLE can't tell them apart either)
} as const;

/**
 * The Wi-Fi channel for a characteristic is *derived*, never assigned: it is the low byte of
 * the first UUID group. Every ChromaBay characteristic is `a0be83XX-8dc9-47f0-ab40-b19721d20ed1`,
 * so XX identifies it uniquely and both ends compute the same number from the same string.
 *
 * This is the whole reason Wi-Fi inherits new characteristics for free. A hand-maintained
 * channel table is a second source of truth, and the historical bug was exactly that: 22
 * characteristics against 11 hand-mirrored channels, with every gap silently unreachable over
 * Wi-Fi. There is nothing to forget to update here.
 */
export function channelForUuid(characteristic: string): number {
  const m = /^a0be83([0-9a-f]{2})-8dc9-47f0-ab40-b19721d20ed1$/i.exec(characteristic.trim());
  if (!m) {
    throw new Error(
      `characteristic ${characteristic} is not a ChromaBay UUID (a0be83XX-8dc9-47f0-ab40-b19721d20ed1), ` +
      `so it has no Wi-Fi channel. Keep new characteristics in that range.`
    );
  }
  return parseInt(m[1], 16);
}

// --- Registry ------------------------------------------------------------------------
// Everything in the app addresses devices by id. This maps an id to whatever link is
// actually carrying it, so callers never hold a transport-specific object.

const transports = new Map<string, Transport>();
let bleFallback: ((deviceId: string) => Transport) | null = null;

/** ble.ts installs this so a plain BLE deviceId resolves without needing explicit registration. */
export function setBleTransportFactory(f: (deviceId: string) => Transport): void {
  bleFallback = f;
}

export function registerTransport(t: Transport): void {
  transports.set(t.id, t);
}

export function unregisterTransport(id: string): void {
  transports.delete(id);
}

export const WIFI_ID_PREFIX = 'wifi:';
export const isWifiId = (id: string): boolean => id.startsWith(WIFI_ID_PREFIX);
export const wifiIdFor = (host: string): string => `${WIFI_ID_PREFIX}${host}`;
export const hostFromWifiId = (id: string): string => id.slice(WIFI_ID_PREFIX.length);

export function getTransport(deviceId: string): Transport {
  const t = transports.get(deviceId);
  if (t) return t;
  if (isWifiId(deviceId)) throw new Error(`Wi-Fi device ${hostFromWifiId(deviceId)} is not connected`);
  if (!bleFallback) throw new Error('BLE transport not initialised');
  return bleFallback(deviceId);
}

/** True when the id resolves to a live link. Used by UI that must not throw on a stale id. */
export function hasTransport(deviceId: string): boolean {
  if (transports.has(deviceId)) return transports.get(deviceId)!.connected;
  return !isWifiId(deviceId) && !!bleFallback;
}
