#!/usr/bin/env node
// Upload a WLED ledmap to a strip and read it back, comparing byte for byte.
//
// Sweeps a set of maps so the failure point is a measured size, not a guess. Reports the
// wall-clock each leg takes, which is also the data for "does Wi-Fi need a fast path?".
//
// Inputs may be ledmap JSON files or generated dimensions such as 48x22.
// Usage: node automation/layout-roundtrip.mjs <host> <ledmap.json|WxH...>
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HOST = process.argv[2];
const ARGS = process.argv.slice(3);
const stripArg = ARGS.find((a) => /^--strip=\d+$/.test(a));
const STRIP = stripArg ? Number(stripArg.slice('--strip='.length)) : 0;
const CLEAR_AFTER = ARGS.includes('--clear-after');
const CASES = ARGS.filter((a) => !a.startsWith('--'));
if (!HOST || !CASES.length) { console.error('usage: layout-roundtrip.mjs <host> <ledmap.json|WxH...>'); process.exit(2); }

const OP = { WRITE: 0x00, READ: 0x01, VALUE: 0x02 };
const U = (s) => `a0be83${s}-8dc9-47f0-ab40-b19721d20ed1`;
const LAYOUT_SET = U('f5'), LAYOUT_GET = U('f6');
const chOf = (u) => parseInt(/^a0be83([0-9a-f]{2})-/i.exec(u)[1], 16);
const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, d = (s) => `\x1b[2m${s}\x1b[0m`;

const ws = new WebSocket(`ws://${HOST}:8080/`);
ws.binaryType = 'arraybuffer';
const notifies = new Map();
ws.addEventListener('message', (e) => {
  const b = new Uint8Array(e.data);
  if (b.length < 2 || b[1] !== OP.VALUE) return;
  (notifies.get(b[0]) ?? []).push(b.slice(2));
});
const send = (uuid, payload) => {
  const m = new Uint8Array(2 + payload.length);
  m[0] = chOf(uuid); m[1] = OP.WRITE; m.set(payload, 2);
  ws.send(m);
};
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('connect failed'))); });
console.log(`connected to ${HOST}\n`);

// Same packing the app uses: [u8 strip][u16 W][u16 H][u16 count][count × i16], chunked
// [u16 totalLen][u16 offset][bytes].
function packLayout(stripIndex, { width, height, map }) {
  const count = Math.min(map.length, width * height);
  const payload = new Uint8Array(1 + 6 + count * 2);
  const dv = new DataView(payload.buffer);
  dv.setUint8(0, stripIndex);
  dv.setUint16(1, width, true); dv.setUint16(3, height, true); dv.setUint16(5, count, true);
  for (let i = 0; i < count; i++) dv.setInt16(7 + i * 2, Math.trunc(map[i] ?? -1), true);
  return payload;
}

// WifiTransport.maxWriteLen (8192) minus the four-byte reassembly header. This is the
// Wi-Fi fast path under test; BLE still uses its proven 180-byte body.
const CHUNK = 8188;
async function upload(payload) {
  const total = payload.byteLength;
  const statusChannel = chOf(LAYOUT_SET);
  notifies.set(statusChannel, []);
  for (let off = 0; off < total; off += CHUNK) {
    const slice = payload.subarray(off, Math.min(off + CHUNK, total));
    const frame = new Uint8Array(4 + slice.length);
    const dv = new DataView(frame.buffer);
    dv.setUint16(0, total, true); dv.setUint16(2, off, true);
    frame.set(slice, 4);
    send(LAYOUT_SET, frame);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = notifies.get(statusChannel).shift();
    if (status?.length >= 2 && status[1] === payload[0]) {
      if (status[0] !== 0) throw new Error(`layout commit failed with status ${status[0]}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('layout commit ACK timed out');
}

async function readBack(stripIndex, expectLen, ms = 20000) {
  const c = chOf(LAYOUT_GET);
  notifies.set(c, []);
  send(LAYOUT_GET, Uint8Array.of(stripIndex));
  const deadline = Date.now() + ms;
  let buf = null, seen = 0, total = -1;
  const seenOffsets = new Set();
  while (Date.now() < deadline) {
    const frames = notifies.get(c);
    while (frames.length) {
      const f = frames.shift();
      if (f.length < 4) continue;
      const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
      const t = dv.getUint16(0, true), off = dv.getUint16(2, true);
      if (t === 0) return { total: 0, buf: null };      // device says: no layout
      if (!buf) { total = t; buf = new Uint8Array(t); }
      const body = f.subarray(4);
      buf.set(body, off);
      if (!seenOffsets.has(off)) { seenOffsets.add(off); seen += Math.min(body.length, total - off); }
      if (seen >= total) return { total, buf };
    }
    await new Promise((r2) => setTimeout(r2, 20));
  }
  return { total, buf, timedOut: true, seen };
}

let anyFail = false;
console.log(`${'map'.padEnd(20)} ${'bytes'.padStart(7)} ${'up'.padStart(7)} ${'down'.padStart(8)}  result`);
for (const input of CASES) {
  const dimensions = /^(\d+)x(\d+)$/i.exec(input);
  const json = dimensions
    ? {
        width: Number(dimensions[1]),
        height: Number(dimensions[2]),
        map: Array.from(
          { length: Number(dimensions[1]) * Number(dimensions[2]) },
          (_, i) => i % 256,
        ),
      }
    : JSON.parse(readFileSync(input, 'utf8'));
  const payload = packLayout(STRIP, json);
  // The upload's first byte chooses the strip. The device stores and reads back only the
  // layout file body [W,H,count,map], so comparing against the whole upload is off by one.
  const expected = payload.subarray(1);
  const name = dimensions ? input : path.basename(input);
  const t0 = Date.now();
  await upload(payload);
  const tUp = Date.now() - t0;
  const t1 = Date.now();
  const got = await readBack(STRIP, expected.byteLength);
  const tDown = Date.now() - t1;

  let verdict;
  if (!got.buf) verdict = r(`FAIL — device reports no layout${got.timedOut ? ' (timed out)' : ''}`);
  else if (got.total !== expected.byteLength) verdict = r(`FAIL — read back ${got.total} of ${expected.byteLength}`);
  else {
    const same = got.buf.every((v, i) => v === expected[i]);
    verdict = same ? g('ok') : r(`FAIL — ${got.buf.reduce((n, v, i) => n + (v !== expected[i] ? 1 : 0), 0)} bytes differ`);
  }
  if (verdict.includes('FAIL')) anyFail = true;
  console.log(`${name.padEnd(20)} ${String(payload.byteLength).padStart(7)} ${d((tUp + 'ms').padStart(7))} ${d(((got.timedOut ? '>' : '') + tDown + 'ms').padStart(8))}  ${verdict}`);
}
if (CLEAR_AFTER) {
  await upload(packLayout(STRIP, { width: 0, height: 0, map: [] }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(`cleared strip ${STRIP} after test`);
}
ws.close();
process.exit(anyFail ? 1 : 0);
