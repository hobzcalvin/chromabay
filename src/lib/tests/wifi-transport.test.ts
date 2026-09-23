// The Wi-Fi carriage, checked against the framing the firmware parses.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WifiTransport } from '$lib/wifiTransport';
import { OP, channelForUuid } from '$lib/transport';

const SERVICE = 'a0be83e4-8dc9-47f0-ab40-b19721d20ed1';
const BRIGHTNESS = 'a0be83f1-8dc9-47f0-ab40-b19721d20ed1';
const DEVICE_INFO = 'a0be83e7-8dc9-47f0-ab40-b19721d20ed1';

/** Stands in for the socket so we can read exactly what goes on the wire. */
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  sent: Uint8Array[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) { queueMicrotask(() => this.fire('open', {})); }
  send(m: Uint8Array) { this.sent.push(m); }
  close() { this.readyState = 3; this.fire('close', {}); }
  addEventListener(t: string, cb: (e: any) => void) { (this.listeners[t] ??= []).push(cb); }
  fire(t: string, e: any) { (this.listeners[t] ?? []).forEach((cb) => cb(e)); }
  set onopen(cb: any) { this.addEventListener('open', cb); }
  set onerror(cb: any) { this.addEventListener('error', cb); }
  set onclose(cb: any) { this.addEventListener('close', cb); }
  set onmessage(cb: any) { this.addEventListener('message', cb); }
  /** Simulate a device→app VALUE frame. */
  deviceSends(channel: number, payload: number[]) {
    const b = new Uint8Array([channel, OP.VALUE, ...payload]);
    this.fire('message', { data: b.buffer });
  }
}

let sock: FakeSocket;
beforeEach(() => {
  vi.stubGlobal('WebSocket', class extends FakeSocket {
    constructor(url: string) { super(url); sock = this as unknown as FakeSocket; }
  });
});

async function connected() {
  const t = new WifiTransport('device.local');
  await t.connect();
  return t;
}

describe('WifiTransport framing', () => {
  it('a write is [channel][WRITE][payload]', async () => {
    const t = await connected();
    await t.write(SERVICE, BRIGHTNESS, new DataView(Uint8Array.of(42).buffer));
    expect([...sock.sent[0]]).toEqual([channelForUuid(BRIGHTNESS), OP.WRITE, 42]);
  });

  it('a read asks with [channel][READ] and resolves on the VALUE reply', async () => {
    const t = await connected();
    const p = t.read(SERVICE, DEVICE_INFO);
    expect([...sock.sent[0]]).toEqual([channelForUuid(DEVICE_INFO), OP.READ]);
    sock.deviceSends(channelForUuid(DEVICE_INFO), [0x7b, 0x7d]); // "{}"
    const dv = await p;
    expect(new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))).toBe('{}');
  });

  it('writeWithoutResponse and writeStream are ordinary writes (TCP is already reliable)', async () => {
    const t = await connected();
    await t.writeWithoutResponse(SERVICE, BRIGHTNESS, new DataView(Uint8Array.of(1).buffer));
    await t.writeStream(SERVICE, BRIGHTNESS, new DataView(Uint8Array.of(2).buffer));
    expect(sock.sent.map((m) => m[1])).toEqual([OP.WRITE, OP.WRITE]);
  });

  it('a read still waiting when the link closes fails at once, not at its timeout', async () => {
    const t = await connected();
    const p = t.read(SERVICE, DEVICE_INFO, 60_000);
    sock.close();
    await expect(p).rejects.toThrow('Wi-Fi link closed');
  });

  it('an unsolicited VALUE goes to the notify sink, not to a read', async () => {
    const t = await connected();
    const seen: number[] = [];
    await t.startNotifications(SERVICE, BRIGHTNESS, (dv) => seen.push(dv.getUint8(0)));
    sock.deviceSends(channelForUuid(BRIGHTNESS), [99]);
    expect(seen).toEqual([99]);
  });

  it('a pending read wins over the notify sink, as it does on BLE', async () => {
    const t = await connected();
    const seen: number[] = [];
    await t.startNotifications(SERVICE, BRIGHTNESS, (dv) => seen.push(dv.getUint8(0)));
    const p = t.read(SERVICE, BRIGHTNESS);
    sock.deviceSends(channelForUuid(BRIGHTNESS), [7]); // answers the read
    sock.deviceSends(channelForUuid(BRIGHTNESS), [8]); // no waiter left → notify
    expect((await p).getUint8(0)).toBe(7);
    expect(seen).toEqual([8]);
  });

  it('stopNotifications removes the sink', async () => {
    const t = await connected();
    const seen: number[] = [];
    await t.startNotifications(SERVICE, BRIGHTNESS, (dv) => seen.push(dv.getUint8(0)));
    await t.stopNotifications(SERVICE, BRIGHTNESS);
    sock.deviceSends(channelForUuid(BRIGHTNESS), [5]);
    expect(seen).toEqual([]);
  });

  it('refuses a characteristic that has no channel rather than sending a wrong one', async () => {
    const t = await connected();
    await expect(t.write(SERVICE, '0000180f-0000-1000-8000-00805f9b34fb',
      new DataView(new ArrayBuffer(1)))).rejects.toThrow(/no Wi-Fi channel/);
  });
});
