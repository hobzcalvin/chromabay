// BLE drops notifications: on a Mac with Web Bluetooth, a 57×49 layout (5,592 B in 32 chunks)
// lost ~7 chunks on every read, so getStripLayout timed out and the app fell back to the plain
// matrix. The device can't resend one chunk, but it always chunks the same file at the same
// offsets — so the read asks again and keeps what it already has until the holes are filled.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerTransport, unregisterTransport, type Transport } from '$lib/transport';
import { getStripLayout } from '$lib/ble';

const LAYOUT_GET = 'a0be83f6-8dc9-47f0-ab40-b19721d20ed1';
const ID = 'fake-ble';

/** The firmware's layout file: [u16 W][u16 H][u16 count][count × i16]. */
function layoutFile(W: number, H: number): { bytes: Uint8Array; map: number[] } {
  const map = Array.from({ length: W * H }, (_, i) => (i % 7 === 3 ? -1 : i));
  const b = new DataView(new ArrayBuffer(6 + map.length * 2));
  b.setUint16(0, W, true); b.setUint16(2, H, true); b.setUint16(4, map.length, true);
  map.forEach((v, i) => b.setInt16(6 + i * 2, v, true));
  return { bytes: new Uint8Array(b.buffer), map };
}

/** A device that serves `file` like processLayoutGetRequest, dropping chunks per `drop`. */
function fakeDevice(file: Uint8Array | null, drop: (round: number, offset: number) => boolean) {
  let cb: ((dv: DataView) => void) | null = null;
  let round = 0;
  const t = {
    id: ID, kind: 'ble', connected: true, maxWriteLen: 180, maxStreamWriteLen: 180,
    async startNotifications(_s: string, c: string, f: (dv: DataView) => void) { if (c === LAYOUT_GET) cb = f; },
    async stopNotifications() { cb = null; },
    async write(_s: string, c: string) {
      if (c !== LAYOUT_GET) return;
      const r = round++;
      setTimeout(() => {
        if (!file) { cb?.(new DataView(new Uint8Array(4).buffer)); return; }
        for (let off = 0; off < file.length; off += 180) {
          if (drop(r, off)) continue;
          const n = Math.min(180, file.length - off);
          const fr = new Uint8Array(4 + n);
          fr[0] = file.length & 0xff; fr[1] = file.length >> 8; fr[2] = off & 0xff; fr[3] = off >> 8;
          fr.set(file.subarray(off, off + n), 4);
          cb?.(new DataView(fr.buffer));
        }
      }, 10);
    },
  } as unknown as Transport;
  registerTransport(t);
  return { rounds: () => round };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); unregisterTransport(ID); vi.restoreAllMocks(); });

test('chunks dropped on the first read are filled in by asking again', async () => {
  const { bytes, map } = layoutFile(57, 49);
  // The pattern seen on Portal: 3960–4860 and 5400 missing; the retry loses different ones.
  const dev = fakeDevice(bytes, (r, off) => r === 0 ? (off >= 3960 && off <= 4860) || off === 5400 : off < 900);
  const p = getStripLayout(ID, 0);
  await vi.advanceTimersByTimeAsync(10_000);
  const r = await p;
  expect(r).toEqual({ width: 57, height: 49, map });
  expect(dev.rounds()).toBe(2);
});

test('a device that loses the tail of every read gets there a chunk or two per round', async () => {
  const { bytes, map } = layoutFile(57, 49); // 32 chunks
  // Like Portal: the first 22 chunks always arrive, then only one more each round.
  const dev = fakeDevice(bytes, (r, off) => { const c = off / 180; return c >= 22 && c !== 22 + r; });
  const p = getStripLayout(ID, 0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await p).toEqual({ width: 57, height: 49, map });
  expect(dev.rounds()).toBe(10);
});

test('a strip with no layout is still "none", not an error', async () => {
  fakeDevice(null, () => false);
  const p = getStripLayout(ID, 0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await p).toBeNull();
});

test('a chunk that never arrives still fails the read (never a layout with holes)', async () => {
  const { bytes } = layoutFile(20, 20);
  const dev = fakeDevice(bytes, (_r, off) => off === 360);
  const p = getStripLayout(ID, 0);
  const caught = p.catch((e) => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await caught).toBeInstanceOf(Error);
  expect(dev.rounds()).toBe(4); // 1 + 3 rounds that add nothing
});
