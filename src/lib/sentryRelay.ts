/**
 * Relay crash reports from a connected device to Sentry.
 *
 * The firmware has no route to the internet of its own — it deliberately does not link a TLS
 * stack (107 KB, see CHROMABAY_SENTRY_WIFI in the firmware) — so it hands us a complete HTTP
 * request — URL, two headers, body — and we perform it and report the status back. Everything
 * Sentry-specific (the envelope, the auth header, the ingest URL) is built on the device by
 * sentry-micro; this file knows nothing about any of it and would relay a request to any
 * whitelisted host equally well.
 *
 * That is the point of the design: a companion app supports device crash reporting in about
 * the amount of code below, and never has to learn what an envelope is.
 *
 * Both links carry the identical frames: over BLE they are GATT notifications and writes on
 * three characteristics; over Wi-Fi they are WebSocket messages on channels 12 (relay) and 13
 * (DSN). Everything below is keyed by an opaque RelayLink, so the protocol is written once.
 *
 * Wire protocol (sentry-micro `core/sentry_relay.h`), little-endian:
 *
 *   device -> app   0x01 BEGIN  [req u8][urlLen u16][authLen u16][ctypeLen u16][bodyLen u32]
 *                   0x02 DATA   [req u8][offset u16][payload…]
 *                   0x03 END    [req u8]
 *   app -> device   0x80 HELLO  [version u8][maxChunk u16]
 *                   0x81 STATUS [req u8][result u8][httpStatus u16][retryAfterMs u32]
 *
 * DATA payloads are slices of one stream: url ++ auth ++ contentType ++ body, cut apart using
 * the lengths from BEGIN.
 */

import * as Sentry from '@sentry/sveltekit';
import { LED_SERVICE_UUID, startBinaryNotifications, writeCharacteristicBinary } from './ble';
import { connectedDevices } from './stores/deviceStore';
import { wifiConns } from './stores/wifiDeviceStore';
import type { WifiDevice } from './wifiTransport';

const SENTRY_TX_UUID = 'a0be83fb-8dc9-47f0-ab40-b19721d20ed1'; // device → app, notify
const SENTRY_RX_UUID = 'a0be83fc-8dc9-47f0-ab40-b19721d20ed1'; // app → device, write
const SENTRY_CONFIG_UUID = 'a0be83fd-8dc9-47f0-ab40-b19721d20ed1'; // app → device: the DSN

const PROTOCOL_VERSION = 1;
/** Matches the firmware's notification payload budget; the device clamps to the smaller. */
const MAX_CHUNK_BYTES = 180;
/** A relayed request is an envelope, never a large upload. Anything bigger is a bug or an abuse. */
const MAX_REQUEST_BYTES = 64 * 1024;

const FRAME_BEGIN = 0x01;
const FRAME_DATA = 0x02;
const FRAME_END = 0x03;
const FRAME_HELLO = 0x80;
const FRAME_STATUS = 0x81;

const RESULT_OK = 0;
const RESULT_UNAVAILABLE = 1;
const RESULT_REJECTED = 2;
const RESULT_RATE_LIMITED = 3;
const RESULT_ERROR = 4;

/**
 * The DSN devices report to.
 *
 * Defaults to the app's own project so this works with no extra configuration; point
 * VITE_SENTRY_DEVICE_DSN at a separate firmware project to keep device crashes (and their
 * quota) apart from app errors.
 */
const DEVICE_DSN: string =
  (import.meta as any).env?.VITE_SENTRY_DEVICE_DSN ||
  (import.meta as any).env?.VITE_SENTRY_DSN ||
  'https://3bb11192b1334f860c0e31fd7fe2c65b@o4511260075884544.ingest.us.sentry.io/4511695305900032';

/**
 * The ONE host we are willing to POST to, derived from the DSN above.
 *
 * Non-negotiable: without it, a buggy or hostile device could use the phone as an open proxy
 * to any URL it likes, with the user's IP and network. Matching is exact — no suffix checks,
 * which `sentry.io.evil.com` would pass.
 */
const ALLOWED_HOST: string | null = (() => {
  try {
    return new URL(DEVICE_DSN).host.toLowerCase();
  } catch {
    console.warn('[SentryRelay] device DSN is not a URL; relay disabled');
    return null;
  }
})();

interface PendingRequest {
  requestId: number;
  urlLen: number;
  authLen: number;
  ctypeLen: number;
  bodyLen: number;
  buffer: Uint8Array;
  received: number;
  seen: Set<number>;
}

/**
 * One device, reachable somehow. The three operations the relay needs, and nothing else.
 *
 * A hand-written pair of implementations rather than something generic, because the firmware
 * side is the same way: Wi-Fi mirrors a subset of the BLE characteristics by hand. When that
 * gets a real bridge (see the Endpoint table plan), this collapses with it.
 */
interface RelayLink {
  /** Identity for the maps below: a BLE device id, or `wifi:<name>`. */
  key: string;
  /** Subscribe to device → app frames. Rejects on firmware without the relay. */
  subscribe(onFrame: (dv: DataView) => void): Promise<void>;
  /** app → device: HELLO and STATUS. */
  toDevice(frame: DataView): Promise<void>;
  /** app → device: the DSN to report to. */
  config(dsn: Uint8Array): Promise<void>;
}

function bleLink(deviceId: string): RelayLink {
  return {
    key: deviceId,
    subscribe: (onFrame) =>
      startBinaryNotifications(deviceId, LED_SERVICE_UUID, SENTRY_TX_UUID, onFrame),
    toDevice: (frame) =>
      writeCharacteristicBinary(deviceId, LED_SERVICE_UUID, SENTRY_RX_UUID, frame),
    config: (dsn) =>
      writeCharacteristicBinary(
        deviceId,
        LED_SERVICE_UUID,
        SENTRY_CONFIG_UUID,
        new DataView(dsn.buffer, dsn.byteOffset, dsn.byteLength)
      )
  };
}

function wifiLink(name: string, dev: WifiDevice): RelayLink {
  const asBytes = (frame: DataView) =>
    new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    key: `wifi:${name}`,
    // Nothing to subscribe to over a WebSocket — the socket is already open and the device
    // pushes when it has something. Installing the hook is the whole of it.
    subscribe: async (onFrame) => {
      dev.onSentryFrame = (payload) =>
        onFrame(new DataView(payload.buffer, payload.byteOffset, payload.byteLength));
    },
    toDevice: async (frame) => dev.sendSentry(asBytes(frame)),
    config: async (dsn) => dev.sendSentryConfig(dsn)
  };
}

/**
 * Tell the device which trace this session belongs to, so a crash links to the replay.
 *
 * One trace per connection. That is coarser than a trace per operation — the unit sentry-micro
 * asks for — and the trade is deliberate: a per-command trace would put ~110 bytes of ids on
 * the wire beside every pattern sync and settings write, and touch a dozen call sites across
 * the app, for a link this already gives. Everything here stays inside the Sentry integration;
 * no ChromaBay code path knows tracing exists.
 *
 * The device holds it in RTC memory, which survives a panic reset. So a device that dies
 * mid-session reboots and reports the crash under *this* trace and *this* replay — which is
 * what turns an issue into "here is the video of the interaction that killed it".
 *
 * Sent on the config characteristic rather than a new one: a DSN is always a `https://` URL,
 * so the prefix tells the two apart, and both are Sentry configuration either way.
 */
async function sendTraceContext(link: RelayLink): Promise<void> {
  const data = Sentry.getTraceData();
  const sentryTrace = data['sentry-trace'];
  if (!sentryTrace) return;   // no active trace: send nothing rather than something empty

  // Two baggage keys, not the whole DSC — the rest is a few hundred bytes the device
  // discards. `replay_id` is what links the issue to the video. `org_id` is what proves the
  // trace belongs to us: the device compares it against the org in its own DSN and refuses
  // a trace from somewhere else. It tolerates the key being absent (that is "nothing to
  // compare", not a mismatch), but sending it costs 20 bytes and means the check can never
  // become the reason a trace quietly fails to join.
  const bag = (key: string, pattern: string) => {
    const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(${pattern})`).exec(data.baggage ?? '');
    return m ? `${key}=${m[1]}` : '';
  };
  const payload = ['trace', sentryTrace, bag('sentry-replay_id', '[0-9a-f]{32}'),
                   bag('sentry-org_id', '[0-9]+')].filter(Boolean).join(' ');

  // Only when it changed. This runs on a timer as well as on connect (see below), and the
  // device does real work with each write.
  if (lastTraceSent.get(link.key) === payload) return;

  try {
    await link.config(new TextEncoder().encode(payload));
    lastTraceSent.set(link.key, payload);
  } catch (err) {
    // Never load-bearing: no trace just means the crash arrives unlinked.
    console.warn('[SentryRelay] trace context not delivered:', err);
  }
}

/**
 * How often to check whether the replay has rotated under us.
 *
 * A Sentry replay ends after 60 minutes, or 15 without a click or navigation — and a device
 * left connected while the lights are on outlives both easily. The trace would still resolve,
 * but its replay_id would name a recording that had already ended: the link would point at
 * "the session that happened to be recording" instead of "the interaction that caused this",
 * which is the wrong-link failure in a quieter form.
 *
 * So re-send whenever the pair changes. Nothing is written while it doesn't, so a device that
 * sits connected for an hour sees one or two writes, not one every 30 seconds.
 */
const TRACE_REFRESH_MS = 30000;
const lastTraceSent = new Map<string, string>();

/** One in-flight request per device; the firmware never has two outstanding. */
const pending = new Map<string, PendingRequest>();
const started = new Set<string>();
/** Live links, so a STATUS can be sent back over whichever one the request arrived on. */
const links = new Map<string, RelayLink>();

function statusFrame(
  requestId: number,
  result: number,
  httpStatus: number,
  retryAfterMs: number
): DataView {
  const out = new Uint8Array(9);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FRAME_STATUS);
  dv.setUint8(1, requestId);
  dv.setUint8(2, result);
  dv.setUint16(3, httpStatus & 0xffff, true);
  dv.setUint32(5, retryAfterMs >>> 0, true);
  return dv;
}

async function sendStatus(
  key: string,
  requestId: number,
  result: number,
  httpStatus = 0,
  retryAfterMs = 0
): Promise<void> {
  const link = links.get(key);
  if (!link) return;   // link dropped mid-request; the device times out and keeps the event
  try {
    await link.toDevice(statusFrame(requestId, result, httpStatus, retryAfterMs));
  } catch (err) {
    // The device times out on its own and keeps the event buffered, so a lost status costs a
    // retry rather than the report.
    console.warn('[SentryRelay] could not report status to device:', err);
  }
}

/** `Retry-After` is seconds (or an HTTP date); the device wants milliseconds. */
function retryAfterMs(response: Response): number {
  const header = response.headers.get('Retry-After');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

async function performRequest(deviceId: string, request: PendingRequest): Promise<void> {
  const decoder = new TextDecoder();
  let at = 0;
  const url = decoder.decode(request.buffer.subarray(at, (at += request.urlLen)));
  const auth = decoder.decode(request.buffer.subarray(at, (at += request.authLen)));
  const contentType = decoder.decode(request.buffer.subarray(at, (at += request.ctypeLen)));
  const body = request.buffer.subarray(at, at + request.bodyLen);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    await sendStatus(deviceId, request.requestId, RESULT_REJECTED);
    return;
  }

  // The whitelist. `username` is checked because `https://ingest.sentry.io@evil.com/` has a
  // host of `evil.com` but reads like the real thing to a human skimming logs.
  if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== ALLOWED_HOST || parsed.username) {
    console.warn(`[SentryRelay] refusing to POST to ${parsed.host} (allowed: ${ALLOWED_HOST})`);
    await sendStatus(deviceId, request.requestId, RESULT_REJECTED);
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Sentry-Auth': auth, 'Content-Type': contentType },
      body: body as BodyInit
    });

    let result = RESULT_ERROR;
    if (response.ok) result = RESULT_OK;
    else if (response.status === 429) result = RESULT_RATE_LIMITED;
    else if (response.status >= 400 && response.status < 500) result = RESULT_REJECTED;

    console.log(
      `[SentryRelay] relayed ${body.byteLength}B for ${deviceId} → ${response.status}`
    );
    await sendStatus(deviceId, request.requestId, result, response.status, retryAfterMs(response));
  } catch (err) {
    // No network on the phone either. UNAVAILABLE tells the device to keep it buffered and
    // try again rather than treating it as delivered.
    console.warn('[SentryRelay] relay fetch failed:', err);
    await sendStatus(deviceId, request.requestId, RESULT_UNAVAILABLE);
  }
}

function onFrame(deviceId: string, dv: DataView): void {
  if (dv.byteLength < 2) return;
  const type = dv.getUint8(0);
  const requestId = dv.getUint8(1);

  if (type === FRAME_BEGIN) {
    if (dv.byteLength < 12) return;
    const urlLen = dv.getUint16(2, true);
    const authLen = dv.getUint16(4, true);
    const ctypeLen = dv.getUint16(6, true);
    const bodyLen = dv.getUint32(8, true);
    const total = urlLen + authLen + ctypeLen + bodyLen;
    if (total === 0 || total > MAX_REQUEST_BYTES) {
      pending.delete(deviceId);
      void sendStatus(deviceId, requestId, RESULT_REJECTED);
      return;
    }
    pending.set(deviceId, {
      requestId,
      urlLen,
      authLen,
      ctypeLen,
      bodyLen,
      buffer: new Uint8Array(total),
      received: 0,
      seen: new Set()
    });
    return;
  }

  const request = pending.get(deviceId);
  if (!request || request.requestId !== requestId) return;

  if (type === FRAME_DATA) {
    if (dv.byteLength <= 4) return;
    const offset = dv.getUint16(2, true);
    const payload = dv.byteLength - 4;
    if (offset + payload > request.buffer.length) return; // overrun: ignore the frame
    for (let i = 0; i < payload; i++) request.buffer[offset + i] = dv.getUint8(4 + i);
    // Count coverage by offset rather than a running total, so a retransmitted chunk can't
    // make a request with a hole in it look complete.
    if (!request.seen.has(offset)) {
      request.seen.add(offset);
      request.received += payload;
    }
    return;
  }

  if (type === FRAME_END) {
    pending.delete(deviceId);
    if (request.received < request.buffer.length) {
      console.warn(
        `[SentryRelay] incomplete request (${request.received}/${request.buffer.length} bytes)`
      );
      void sendStatus(deviceId, requestId, RESULT_ERROR); // retryable: the device still has it
      return;
    }
    void performRequest(deviceId, request);
  }
}

/**
 * Start relaying for a device, and tell it which project to report to.
 *
 * Safe to call on every connect and on firmware that predates the relay — the characteristics
 * simply won't be there, and it gives up quietly. Provisioning the DSN here rather than baking
 * it into the firmware is deliberate: released firmware binaries are public, and a key
 * extractable with `strings` is a key anyone can spend our quota with.
 */
async function attach(link: RelayLink): Promise<void> {
  if (!ALLOWED_HOST) return;
  if (started.has(link.key)) return;

  try {
    await link.subscribe((dv) => onFrame(link.key, dv));
  } catch {
    return; // firmware without the relay characteristics
  }
  started.add(link.key);
  links.set(link.key, link);

  try {
    await link.config(new TextEncoder().encode(DEVICE_DSN));
  } catch (err) {
    console.warn('[SentryRelay] DSN provisioning failed:', err);
  }

  // After the DSN, because a device with no DSN cannot do anything with a trace anyway.
  await sendTraceContext(link);

  // HELLO last: the device treats it as "a host that speaks this protocol is attached" and
  // may start relaying immediately, so everything it needs must already be in place.
  const hello = new Uint8Array(4);
  const dv = new DataView(hello.buffer);
  dv.setUint8(0, FRAME_HELLO);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint16(2, MAX_CHUNK_BYTES, true);
  try {
    await link.toDevice(dv);
    console.log(`[SentryRelay] attached to ${link.key}`);
  } catch (err) {
    console.warn('[SentryRelay] hello failed:', err);
    started.delete(link.key);
    links.delete(link.key);
  }
}

export function startSentryRelay(deviceId: string): Promise<void> {
  return attach(bleLink(deviceId));
}

/** Forget a device's relay state on disconnect, so a reconnect re-announces itself. */
export function stopSentryRelay(key: string): void {
  started.delete(key);
  pending.delete(key);
  links.delete(key);
  lastTraceSent.delete(key);
}

let watching = false;

/**
 * Attach the relay to every device that connects, for as long as the app is running.
 *
 * Driven by the connected-devices store rather than by page state, because a reconnect has
 * to re-attach and the page's init block does not re-run for one. Both halves of the attach
 * are per-connection and do not survive a drop: the GATT notification subscription is torn
 * down with the link, and the firmware forgets our HELLO on disconnect (a new host has to
 * announce itself). Miss either and the device buffers crash reports it can never deliver —
 * which is exactly what happened: it queued three panics and shipped none of them.
 */
export function watchSentryRelay(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;

  // Keep every attached device on a live replay, not the one it was handed at connect.
  setInterval(() => {
    for (const link of links.values()) void sendTraceContext(link);
  }, TRACE_REFRESH_MS);

  connectedDevices.subscribe((devices) => {
    for (const deviceId of devices.keys()) {
      if (started.has(deviceId)) continue;
      void attach(bleLink(deviceId)).then(() => {
        // A reconnect can land here before service discovery has settled, which fails the
        // writes and leaves us detached. One retry costs nothing and covers that window.
        if (!started.has(deviceId)) {
          setTimeout(() => { void attach(bleLink(deviceId)); }, 2000);
        }
      });
    }
    // Only prune BLE keys here — a Wi-Fi device is not in this store and would be detached
    // on every BLE event.
    for (const key of [...started]) {
      if (!key.startsWith('wifi:') && !devices.has(key)) stopSentryRelay(key);
    }
  });

  // The same, for devices reached over Wi-Fi. A device in Wi-Fi comm mode has no BLE at all,
  // so this is its only route: without it, it buffers panics on flash that nothing collects.
  wifiConns.subscribe((conns) => {
    const live = new Set<string>();
    for (const [name, conn] of Object.entries(conns)) {
      if (conn.state !== 'ready' || !conn.dev) continue;
      const key = `wifi:${name}`;
      live.add(key);
      if (!started.has(key)) void attach(wifiLink(name, conn.dev));
    }
    for (const key of [...started]) {
      if (key.startsWith('wifi:') && !live.has(key)) stopSentryRelay(key);
    }
  });
}
