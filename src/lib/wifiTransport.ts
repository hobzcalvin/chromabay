// Wi-Fi carriage for the ChromaBay characteristic protocol.
//
// This file knows about WebSockets and nothing else. It does not know what a pattern is, what
// OTA means, or what any characteristic does — it moves bytes for the same read/write/notify
// operations Bluetooth offers, so every high-level operation in ble.ts works over it unchanged.
//
// Wire format: one WS binary message per operation, [u8 channel][u8 op][payload].
//   channel — derived from the characteristic UUID (see channelForUuid); never hand-assigned.
//   op      — WRITE / READ / VALUE, mirroring what BLE can do to a characteristic.
// WebSocket gives message boundaries, so there is no length prefix; TCP gives ordering, so
// chunked writes arrive in the order they were sent exactly as they do over a serialized
// BLE queue.
//
// Browser reality: raw TCP is impossible in a browser but WebSocket is native. In the iOS app
// (WKWebView) ws:// to a LAN device works with an ATS exception; local dev (http) works too.
// The deployed https site cannot (mixed content), so Wi-Fi control is native + dev only.
import { OP, channelForUuid, wifiIdFor, type Transport } from './transport';

export const WIFI_PORT = 8080;

type NotifyCb = (v: DataView) => void;

export class WifiTransport implements Transport {
  readonly kind = 'wifi' as const;
  readonly id: string;
  host: string;
  connected = false;
  /**
   * WebSocket messages are not limited the way an ATT write is. Callers still chunk to their
   * own constants so the device sees byte-identical framing on both links; this is here so a
   * caller that genuinely benefits (bulk OTA) can opt into bigger writes without any part of
   * the protocol above changing shape.
   */
  readonly maxWriteLen = 8192;
  /**
   * 4 KiB, not 8. An 8 KiB WebSocket message is never dispatched by a classic ESP32 — the
   * frame simply never reaches a handler, so the device answers nothing at all and a sender
   * watching for ACKs calls it a stall. Reproduced on demand against a real installation:
   * every 8 KiB update died on its first chunk with no status; every 4 KiB update of the
   * same image, over the same link, in the same minute, transferred all 1.45 MB and booted.
   * An ESP32-S3 handles 8 KiB fine, which is exactly why this hid for so long — it fails
   * only on the smaller part, which is the part most installations are built on.
   *
   * The firmware-side mechanism is NOT identified (MAX_FRAME is 64 KiB, so it is not that
   * check); the suspicion is the classic chip's tighter default lwip receive buffers. Raising
   * this again needs that understood first, and a classic ESP32 to prove it on.
   */
  readonly maxStreamWriteLen = 4096;

  private ws: WebSocket | null = null;
  // Reads are queued per channel: BLE allows a read to be outstanding per characteristic, and
  // a device VALUE frame answers the oldest waiter on that channel.
  private pendingReads = new Map<number, Array<(v: DataView) => void>>();
  private notifiers = new Map<number, NotifyCb>();
  onClose?: () => void;

  constructor(host: string) {
    this.host = host;
    this.id = wifiIdFor(host);
  }

  connect(timeoutMs = 6000): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const url = `ws://${this.host}:${WIFI_PORT}/`;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.close(); } catch { /* already gone */ }
        reject(new Error('Wi-Fi connect timed out'));
      }, timeoutMs);
      ws.onopen = () => { if (done) return; done = true; clearTimeout(t); this.connected = true; resolve(); };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(t); reject(new Error(`Could not reach ${url}`)); } };
      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        // Fail every waiter rather than leaving callers hanging until their own timeout.
        for (const q of this.pendingReads.values()) q.length = 0;
        this.pendingReads.clear();
        this.onClose?.();
      };
      ws.onmessage = (e) => this.onMessage(new Uint8Array(e.data as ArrayBuffer));
    });
  }

  async disconnect(): Promise<void> {
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
    this.connected = false;
  }

  private onMessage(buf: Uint8Array) {
    if (buf.length < 2) return;
    const ch = buf[0], op = buf[1];
    if (op !== OP.VALUE) return; // devices only ever send VALUE
    // Copy: the payload is a view into a buffer we do not own past this callback.
    const body = buf.slice(2);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    // A read reply answers the oldest waiter; anything else is an unsolicited notify. BLE
    // cannot distinguish these either — a read response and a notification look the same to
    // the app — so resolving the waiter first is exactly the BLE behaviour.
    const q = this.pendingReads.get(ch);
    if (q && q.length) { q.shift()!(dv); return; }
    this.notifiers.get(ch)?.(dv);
  }

  private frame(ch: number, op: number, payload?: DataView): Uint8Array {
    const n = payload ? payload.byteLength : 0;
    const m = new Uint8Array(2 + n);
    m[0] = ch; m[1] = op;
    if (payload && n) m.set(new Uint8Array(payload.buffer, payload.byteOffset, n), 2);
    return m;
  }

  private sendRaw(m: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Wi-Fi device not connected');
    this.ws.send(m);
  }

  async read(_service: string, characteristic: string, timeoutMs = 6000): Promise<DataView> {
    const ch = channelForUuid(characteristic);
    return new Promise<DataView>((resolve, reject) => {
      const q = this.pendingReads.get(ch) ?? [];
      const timer = setTimeout(() => {
        const i = q.indexOf(waiter);
        if (i >= 0) q.splice(i, 1);
        reject(new Error(`Wi-Fi read of ${characteristic} timed out`));
      }, timeoutMs);
      const waiter = (v: DataView) => { clearTimeout(timer); resolve(v); };
      q.push(waiter);
      this.pendingReads.set(ch, q);
      try { this.sendRaw(this.frame(ch, OP.READ)); }
      catch (e) { clearTimeout(timer); const i = q.indexOf(waiter); if (i >= 0) q.splice(i, 1); reject(e as Error); }
    });
  }

  async write(_service: string, characteristic: string, value: DataView): Promise<void> {
    this.sendRaw(this.frame(channelForUuid(characteristic), OP.WRITE, value));
  }

  // Nothing to bypass: there is no queue in front of a WebSocket send, and TCP already
  // preserves order. Bulk writes are ordinary writes here.
  async writeStream(service: string, characteristic: string, value: DataView): Promise<void> {
    return this.write(service, characteristic, value);
  }

  // TCP is reliable and ordered, so "without response" is the same operation here. The
  // distinction is a BLE flow-control detail, not part of the protocol.
  async writeWithoutResponse(service: string, characteristic: string, value: DataView): Promise<void> {
    return this.write(service, characteristic, value);
  }

  async startNotifications(_service: string, characteristic: string, cb: NotifyCb): Promise<void> {
    // No subscribe handshake: the device pushes on the channel whenever it has something,
    // exactly as it notifies a subscribed BLE characteristic. Registering the sink is enough.
    this.notifiers.set(channelForUuid(characteristic), cb);
  }

  async stopNotifications(_service: string, characteristic: string): Promise<void> {
    this.notifiers.delete(channelForUuid(characteristic));
  }
}
