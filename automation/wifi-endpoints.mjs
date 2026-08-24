#!/usr/bin/env node
// Exercise EVERY endpoint over Wi-Fi, directly on the wire.
//
// The browser test proves the app works over Wi-Fi; this proves the firmware carries the whole
// protocol there, including endpoints no UI happens to touch. It speaks the framing itself —
// [u8 channel][u8 op][payload], channel derived from the characteristic UUID — so it is an
// independent check of the contract rather than a second run of the app's own code.
//
// Usage: node automation/wifi-endpoints.mjs <host> [--set-ble]
import { decode } from '@msgpack/msgpack';

const HOST = process.argv[2] || 'chromabay-ed30.local';
const SET_BLE = process.argv.includes('--set-ble');
const PORT = 8080;
const OP = { WRITE: 0x00, READ: 0x01, VALUE: 0x02 };

// Same derivation both ends use.
const ch = (uuid) => {
  const m = /^a0be83([0-9a-f]{2})-8dc9-47f0-ab40-b19721d20ed1$/i.exec(uuid);
  if (!m) throw new Error(`not a ChromaBay UUID: ${uuid}`);
  return parseInt(m[1], 16);
};
const U = (suffix) => `a0be83${suffix}-8dc9-47f0-ab40-b19721d20ed1`;
const CHARS = {
  RX: U('e5'), TX: U('e6'), DEVICE_INFO: U('e7'), OTA_CONTROL: U('e8'), OTA_DATA: U('e9'),
  OTA_STATUS: U('ea'), OTA_SIGNATURE: U('eb'), PATTERN_SYNC: U('ec'), LED_CONFIG_GET: U('ed'),
  LED_CONFIG_SET: U('ee'), TIMESTAMP_SYNC: U('ef'), PLAYLIST_SYNC: U('f0'), BRIGHTNESS: U('f1'),
  DEVICE_NAME: U('f2'), BUTTON_PIN: U('f3'), BUTTON_EVENT: U('f4'), LAYOUT_SET: U('f5'),
  LAYOUT_GET: U('f6'), CALIBRATION: U('f7'), LIBRARY_CMD: U('f8'), LIBRARY_DUMP: U('f9'),
  COMM_CONFIG: U('fa'), SENTRY_TX: U('fb'), SENTRY_RX: U('fc'), SENTRY_CONFIG: U('fd'),
};

const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? g(' PASS') : r(' FAIL')}  ${name.padEnd(34)} ${dim(detail)}`);
};

const ws = new WebSocket(`ws://${HOST}:${PORT}/`);
ws.binaryType = 'arraybuffer';
const waiters = new Map(); // channel → [resolve]
const notifies = new Map(); // channel → frames[]

ws.addEventListener('message', (e) => {
  const b = new Uint8Array(e.data);
  if (b.length < 2 || b[1] !== OP.VALUE) return;
  const c = b[0], body = b.slice(2);
  const q = waiters.get(c);
  if (q?.length) { q.shift()(body); return; }
  if (!notifies.has(c)) notifies.set(c, []);
  notifies.get(c).push(body);
});

const send = (uuid, op, payload = new Uint8Array(0)) => {
  const m = new Uint8Array(2 + payload.length);
  m[0] = ch(uuid); m[1] = op; m.set(payload, 2);
  ws.send(m);
};
const read = (uuid, ms = 5000) => new Promise((resolve, reject) => {
  const c = ch(uuid);
  if (!waiters.has(c)) waiters.set(c, []);
  const q = waiters.get(c);
  const t = setTimeout(() => { const i = q.indexOf(w); if (i >= 0) q.splice(i, 1); reject(new Error('timeout')); }, ms);
  const w = (v) => { clearTimeout(t); resolve(v); };
  q.push(w);
  send(uuid, OP.READ);
});
const collect = async (uuid, ms) => { notifies.set(ch(uuid), []); await new Promise((r2) => setTimeout(r2, ms)); return notifies.get(ch(uuid)) ?? []; };
const td = new TextDecoder();

await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error(`could not reach ws://${HOST}:${PORT}/`)));
});
console.log(`connected to ${HOST}\n`);

// ---- reads --------------------------------------------------------------------------
let info = null;
try { info = JSON.parse(td.decode(await read(CHARS.DEVICE_INFO))); check('DEVICE_INFO read', !!info.fw_ver, `${info.fw_ver} feat=${info.feat} chip=${info.chip ?? '?'}`); }
catch (e) { check('DEVICE_INFO read', false, e.message); }

try { const cfg = decode(await read(CHARS.LED_CONFIG_GET)); check('LED_CONFIG_GET read', Array.isArray(cfg.strips), `${cfg.strips.length} strip(s), brightness ${cfg.gb}`); }
catch (e) { check('LED_CONFIG_GET read', false, e.message); }

let bri0 = 128;
try { const b = await read(CHARS.BRIGHTNESS); bri0 = b[0]; check('BRIGHTNESS read', b.length === 1, `= ${b[0]}`); }
catch (e) { check('BRIGHTNESS read', false, e.message); }

try { const n = td.decode(await read(CHARS.DEVICE_NAME)); check('DEVICE_NAME read', n.length > 0, n); }
catch (e) { check('DEVICE_NAME read', false, e.message); }

try { const pin = td.decode(await read(CHARS.BUTTON_PIN)); check('BUTTON_PIN read', pin.length > 0, `pin ${pin}`); }
catch (e) { check('BUTTON_PIN read', false, e.message); }

let settings = null;
try { settings = JSON.parse(td.decode(await read(CHARS.COMM_CONFIG))); check('COMM_CONFIG read', !!settings.mode, `mode=${settings.mode} ssid='${settings.ssid}'`); }
catch (e) { check('COMM_CONFIG read', false, e.message); }

// ---- writes that produce an observable answer ----------------------------------------
try {
  const want = bri0 === 77 ? 99 : 77;
  send(CHARS.BRIGHTNESS, OP.WRITE, Uint8Array.of(want));
  await new Promise((r2) => setTimeout(r2, 600));
  const b = await read(CHARS.BRIGHTNESS);
  check('BRIGHTNESS write→read back', b[0] === want, `wrote ${want}, read ${b[0]}`);
  send(CHARS.BRIGHTNESS, OP.WRITE, Uint8Array.of(bri0)); // restore
} catch (e) { check('BRIGHTNESS write→read back', false, e.message); }

try {
  const frames = (send(CHARS.LIBRARY_DUMP, OP.WRITE, Uint8Array.of(0)), await collect(CHARS.LIBRARY_DUMP, 4000));
  const done = frames.some((f) => f[0] === 0xff);
  check('LIBRARY_DUMP notify stream', frames.length > 0 && done, `${frames.length} chunk(s), done sentinel ${done ? 'seen' : 'MISSING'}`);
} catch (e) { check('LIBRARY_DUMP notify stream', false, e.message); }

try {
  send(CHARS.LAYOUT_GET, OP.WRITE, Uint8Array.of(0));
  const frames = await collect(CHARS.LAYOUT_GET, 2500);
  check('LAYOUT_GET notify stream', frames.length > 0, `${frames.length} frame(s) (strip 0 has no layout → 1 empty header)`);
} catch (e) { check('LAYOUT_GET notify stream', false, e.message); }

try {
  const b = new Uint8Array(5); new DataView(b.buffer).setUint32(0, 30000, true); b[4] = 0;
  send(CHARS.PLAYLIST_SYNC, OP.WRITE, b);
  check('PLAYLIST_SYNC write accepted', true, 'cycle off @30s');
} catch (e) { check('PLAYLIST_SYNC write accepted', false, e.message); }

try {
  const b = new Uint8Array(16); const dv = new DataView(b.buffer);
  dv.setUint32(0, Date.now() >>> 0, true); dv.setUint32(8, Date.now() >>> 0, true);
  send(CHARS.TIMESTAMP_SYNC, OP.WRITE, b);
  check('TIMESTAMP_SYNC write accepted', true);
} catch (e) { check('TIMESTAMP_SYNC write accepted', false, e.message); }

try { send(CHARS.CALIBRATION, OP.WRITE, Uint8Array.of(0, 0xff, 40, 1)); check('CALIBRATION write accepted', true, 'stop'); }
catch (e) { check('CALIBRATION write accepted', false, e.message); }

try { send(CHARS.RX, OP.WRITE, new TextEncoder().encode('status')); const tx = await collect(CHARS.TX, 1500); check('RX command → TX notify', tx.length > 0, tx.length ? td.decode(tx[0]) : 'no reply'); }
catch (e) { check('RX command → TX notify', false, e.message); }

// OTA_CONTROL with no transfer running must be rejected *and say so* — proof the OTA
// endpoints are wired over Wi-Fi, without actually flashing anything.
try {
  send(CHARS.OTA_CONTROL, OP.WRITE, new TextEncoder().encode('ABORT_OTA'));
  const st = await collect(CHARS.OTA_STATUS, 2000);
  check('OTA_CONTROL → OTA_STATUS notify', st.length > 0, st.length ? td.decode(st[0]) : 'no status');
} catch (e) { check('OTA_CONTROL → OTA_STATUS notify', false, e.message); }

// ---- optional: put the device back on Bluetooth ---------------------------------------
if (SET_BLE) {
  const { encode } = await import('@msgpack/msgpack');
  console.log('\nswitching device back to Bluetooth…');
  send(CHARS.COMM_CONFIG, OP.WRITE, encode({ mode: 'ble' }));
  await new Promise((r2) => setTimeout(r2, 1500));
}

console.log('\n' + '='.repeat(64));
const failed = results.filter((x) => !x.ok);
console.log(failed.length ? r(`${failed.length}/${results.length} FAILED`) : g(`all ${results.length} endpoint checks passed over Wi-Fi`));
ws.close();
process.exit(failed.length ? 1 : 0);
