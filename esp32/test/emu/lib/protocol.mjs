// The ChromaBay control protocol, from the test's side: what the firmware source says the GATT
// table is, what discovery found, and the app's wire formats (src/lib/ble.ts) for the writes.
import fs from 'node:fs';
import path from 'node:path';
import { encode as msgpackEncode } from '@msgpack/msgpack';  // the encoder the app uses
import { ROOT } from './emu.mjs';

const SRC = path.join(ROOT, 'esp32/src');

// NIMBLE_PROPERTY bits as GATT characteristic properties (the low byte NimBLE puts on the wire).
const PROP_BITS = { BROADCAST: 0x01, READ: 0x02, WRITE_NR: 0x04, WRITE: 0x08, NOTIFY: 0x10, INDICATE: 0x20 };

/**
 * The ENDPOINTS table in main.cpp, read from the source rather than copied here, so the GATT
 * test fails when the table and what the device actually serves drift apart.
 * Returns [{ name: 'BRIGHTNESS', uuid, props }] in table order.
 */
export function endpointTable() {
  const defines = {};
  for (const f of fs.readdirSync(SRC).filter((f) => /\.(h|cpp)$/.test(f))) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of text.matchAll(/#define\s+(CHARACTERISTIC_UUID_\w+)\s+"([0-9a-fA-F-]{36})"/g)) defines[m[1]] = m[2].toLowerCase();
  }
  const main = fs.readFileSync(path.join(SRC, 'main.cpp'), 'utf8');
  const start = main.indexOf('static const Endpoints::Endpoint ENDPOINTS[] = {');
  if (start < 0) throw new Error('ENDPOINTS table not found in esp32/src/main.cpp');
  const body = main.slice(start, main.indexOf('\n};', start)).replace(/\/\/.*$/gm, '');
  const rows = [];
  for (const m of body.matchAll(/\{\s*(CHARACTERISTIC_UUID_\w+)\s*,\s*([^,{}]+?)\s*,\s*\w+\s*,\s*\w+\s*\}/g)) {
    const uuid = defines[m[1]];
    if (!uuid) throw new Error(`${m[1]} is in ENDPOINTS but has no #define in esp32/src`);
    let props = 0;
    for (const p of m[2].matchAll(/NIMBLE_PROPERTY::(\w+)/g)) {
      if (!(p[1] in PROP_BITS)) throw new Error(`unknown NIMBLE_PROPERTY::${p[1]} on ${m[1]}`);
      props |= PROP_BITS[p[1]];
    }
    rows.push({ name: m[1].replace('CHARACTERISTIC_UUID_', ''), uuid, props });
  }
  return rows;
}

export function propsText(p) {
  return Object.entries(PROP_BITS).filter(([, b]) => p & b).map(([n]) => n).join('|') || 'none';
}

/**
 * Characteristics found by `ble discover`, keyed by UUID: { decl, handle, props, ccc }.
 * ccc is the Client Characteristic Configuration descriptor (0x2902) a subscribe writes to.
 */
export function discovered(run) {
  const chars = run.bleOf('char');
  const attrs = run.bleOf('attr');
  const services = run.bleOf('service');
  const out = new Map();
  chars.forEach((c, i) => {
    const next = chars[i + 1]?.decl ?? 0x10000;
    const ccc = attrs.find((a) => a.uuid === '2902' && a.handle > c.handle && a.handle < next);
    const svc = services.find((s) => c.decl >= s.start && c.decl <= s.end);
    out.set(c.uuid, { ...c, ccc: ccc?.handle, service: svc?.uuid });
  });
  return out;
}

/** Handles by endpoint name ('BRIGHTNESS' → { handle, ccc, props }). */
export function handlesByName(found) {
  const byName = {};
  for (const e of endpointTable()) {
    const d = found.get(e.uuid);
    if (d) byName[e.name] = d;
  }
  return byName;
}

// ---- The app's writes ----------------------------------------------------------------------

/**
 * A pattern exactly as the app puts it on PATTERN_SYNC: MessagePack of the serialized pattern
 * (+ lib), framed [u16 totalLen LE][u16 offset LE][payload] per write (sendPatternChunked).
 * maxWrite is the link's write size; esp32sim's ATT MTU 23 allows 20.
 */
/** The MessagePack the app sends for a pattern (before chunking). */
export function patternBytes(pattern, lib) { return msgpackEncode({ ...pattern, lib }); }

export function patternChunks(pattern, { lib, maxWrite = 20 } = {}) {
  const data = patternBytes(pattern, lib);
  if (data.byteLength > 16384) throw new Error(`pattern is ${data.byteLength} bytes; the device accepts 16384`);
  const payload = maxWrite - 4;
  const chunks = [];
  for (let off = 0; off < data.byteLength; off += payload) {
    const n = Math.min(payload, data.byteLength - off);
    const f = new Uint8Array(4 + n);
    const dv = new DataView(f.buffer);
    dv.setUint16(0, data.byteLength, true);
    dv.setUint16(2, off, true);
    f.set(data.subarray(off, off + n), 4);
    chunks.push(f);
  }
  return chunks;
}

/** TIMESTAMP_SYNC: [u64 frameMs LE][u64 epochMs LE] (sendTimestampSync). */
export function timestampSync(frameMs, epochMs = Date.UTC(2026, 0, 1)) {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, BigInt(frameMs), true);
  dv.setBigUint64(8, BigInt(epochMs), true);
  return b;
}

/** PLAYLIST_SYNC: [u32 intervalMs LE][u8 enabled][u32 crossfadeMs LE] (setCycleOnDevice). */
export function playlistSync(enabled, intervalMs, crossfadeMs = 0) {
  const b = new Uint8Array(9);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, intervalMs, true);
  dv.setUint8(4, enabled ? 1 : 0);
  dv.setUint32(5, crossfadeMs, true);
  return b;
}

/** A one-node pattern in the app's SerializedPattern shape (patternSerializer.ts). */
export function onePattern(name, type, params) {
  return { nodes: [{ t: type, p: params, o: 0 }], meta: { name, output: 0 } };
}
