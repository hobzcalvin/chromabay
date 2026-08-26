#!/usr/bin/env node
// Exercise a complete firmware OTA over the Wi-Fi characteristic carriage.
//
// Safety is intentionally strict: the caller must name both the host and the exact device
// name that DEVICE_INFO reports. Unsigned local builds additionally require --unsigned.
//
// Usage:
//   node automation/wifi-ota.mjs <host> <firmware.bin> --expect-name=ChromaBay_ED30 --unsigned
//   node automation/wifi-ota.mjs <host> <firmware.bin> --expect-name=... --signature=file.sig
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [HOST, FIRMWARE_PATH, ...ARGS] = process.argv.slice(2);
const expectArg = ARGS.find((a) => a.startsWith('--expect-name='));
const signatureArg = ARGS.find((a) => a.startsWith('--signature='));
const UNSIGNED = ARGS.includes('--unsigned');
const EXPECT_NAME = expectArg?.slice('--expect-name='.length);
const SIGNATURE_PATH = signatureArg?.slice('--signature='.length);
if (!HOST || !FIRMWARE_PATH || !EXPECT_NAME || (UNSIGNED === Boolean(SIGNATURE_PATH))) {
  console.error(
    'usage: wifi-ota.mjs <host> <firmware.bin> --expect-name=<exact> ' +
    '(--unsigned | --signature=<file.sig>)',
  );
  process.exit(2);
}

const firmware = new Uint8Array(readFileSync(FIRMWARE_PATH));
const signature = SIGNATURE_PATH ? new Uint8Array(readFileSync(SIGNATURE_PATH)) : null;
if (!firmware.length || firmware.length > 2 * 1024 * 1024) throw new Error(`refusing firmware size ${firmware.length}`);
if (signature && signature.length !== 64) throw new Error(`signature is ${signature.length} bytes, expected 64`);

const OP = { WRITE: 0x00, READ: 0x01, VALUE: 0x02 };
const CH = { DEVICE_INFO: 0xe7, OTA_CONTROL: 0xe8, OTA_DATA: 0xe9, OTA_STATUS: 0xea, OTA_SIGNATURE: 0xeb };
const ws = new WebSocket(`ws://${HOST}:8080/`);
ws.binaryType = 'arraybuffer';

const frames = new Map();
let acked = 0;
let ackWake = null;
let finalStatus = '';
let resolveSuccess;
const successStatus = new Promise((resolve) => { resolveSuccess = resolve; });
ws.addEventListener('message', (event) => {
  const b = new Uint8Array(event.data);
  if (b.length < 2 || b[1] !== OP.VALUE) return;
  const body = b.slice(2);
  if (b[0] === CH.OTA_DATA) {
    acked++;
    if (ackWake) { const wake = ackWake; ackWake = null; wake(); }
  } else {
    const q = frames.get(b[0]) ?? [];
    q.push(body);
    frames.set(b[0], q);
    if (b[0] === CH.OTA_STATUS) {
      finalStatus = new TextDecoder().decode(body);
      console.log(`[status] ${finalStatus}`);
      if (finalStatus === 'OTA_SUCCESS_REBOOTING') resolveSuccess();
    }
  }
});

function send(channel, op, payload = new Uint8Array()) {
  const out = new Uint8Array(2 + payload.length);
  out[0] = channel; out[1] = op; out.set(payload, 2);
  ws.send(out);
}

async function take(channel, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const q = frames.get(channel);
    if (q?.length) return q.shift();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for channel 0x${channel.toString(16)}`);
}

function waitForAck(previous, timeoutMs = 15000) {
  if (acked > previous) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ackWake = null; reject(new Error('timeout waiting for OTA ACK')); }, timeoutMs);
    ackWake = () => { clearTimeout(timer); resolve(); };
  });
}

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('connect timeout')), 6000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connect failed')); });
});

send(CH.DEVICE_INFO, OP.READ);
const info = JSON.parse(new TextDecoder().decode(await take(CH.DEVICE_INFO, 3000)));
if (info.name !== EXPECT_NAME) {
  ws.close();
  throw new Error(`refusing ${HOST}: expected "${EXPECT_NAME}", DEVICE_INFO says "${info.name}"`);
}
console.log(`verified ${info.name} at ${HOST} (${info.chip}, ${info.fw_ver}, heap ${info.heap})`);

// 8 KiB turns this S3 image into ~157 WebSocket messages instead of ~2570 BLE-sized ones.
// Only three in flight, though — 24 KiB. The limit that bites is the device's HEAP, not the
// firmware's ~64 KiB inbound WS buffer: on a classic ESP32 with ~75 KB free, a seven-deep
// window starved the finalize outright (all 1.4 MB transferred, then OTA_ERR_TASK_CREATE).
// Matches OTA_MAX_IN_FLIGHT_BYTES in src/lib/ble.ts — keep the two in step.
const CHUNK = Number(process.env.CHUNK ?? 8192);
const WINDOW = Number(process.env.WINDOW ?? 3);
let sent = 0;
let offset = 0;
const started = Date.now();
while (offset < firmware.length) {
  while (sent - acked >= WINDOW) {
    const before = acked;
    await waitForAck(before);
  }
  const end = Math.min(offset + CHUNK, firmware.length);
  send(CH.OTA_DATA, OP.WRITE, firmware.subarray(offset, end));
  offset = end;
  sent++;
  if (sent === 1 || sent % 16 === 0 || offset === firmware.length) {
    console.log(`${Math.round(offset / firmware.length * 100)}% (${sent} chunks sent, ${acked} ACKed)`);
  }
}
while (acked < sent) {
  const before = acked;
  await waitForAck(before);
}
console.log(`transfer complete: ${firmware.length} bytes, ${sent} chunks, ${Date.now() - started}ms`);

if (signature) send(CH.OTA_SIGNATURE, OP.WRITE, signature);
send(
  CH.OTA_CONTROL,
  OP.WRITE,
  new TextEncoder().encode(signature ? 'END_OTA' : 'END_OTA_UNSIGNED'),
);

// A reboot does not necessarily produce a timely TCP close on every host, so the device's
// explicit success status is the primary result. After it arrives, allow its 2 s reboot delay.
await Promise.race([
  new Promise((resolve) => ws.addEventListener('close', resolve, { once: true })),
  successStatus.then(() => new Promise((resolve) => setTimeout(resolve, 3000))),
  new Promise((resolve) => setTimeout(resolve, 12000)),
]);
console.log(
  `OTA finalize sent for ${path.basename(FIRMWARE_PATH)}; ` +
  (finalStatus === 'OTA_SUCCESS_REBOOTING' ? 'device reported success and reboot' : `last status: ${finalStatus || 'none'}`),
);
try { ws.close(); } catch { /* already closed */ }
