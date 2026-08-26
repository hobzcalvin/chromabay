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

// 4 KiB, and only three in flight. Two separate limits, both learned the hard way:
//   - 4 KiB because a classic ESP32 handles 8 KiB WebSocket messages markedly worse: across
//     six measured attempts on one, every 8 KiB run that failed produced NO device status at
//     all, while every 4 KiB run at least reached OTA_STARTED_READY. The evidence is thin and
//     the mechanism is unidentified (MAX_FRAME is 64 KiB, so it is not that); an S3 takes
//     8 KiB happily. Treat this as a hedge, not a diagnosis.
//   - two in flight because whatever is in flight has to sit in the device's socket buffer,
//     and mid-update the largest contiguous block on a tight classic ESP32 is only ~8 KB.
//     Measured at ~64 KB free: three deep failed every time, two deep succeeded every time.
// Keep in step with maxStreamWriteLen and OTA_MAX_IN_FLIGHT_BYTES in the app.
const CHUNK = Number(process.env.CHUNK ?? 4096);
const WINDOW = Number(process.env.WINDOW ?? 2);

// A classic ESP32 intermittently ignores the opening chunk of an update: no ACK, sometimes not
// even a status, while the device stays up and answers pings throughout. Measured on one real
// installation, roughly one attempt in three got through. The cause is NOT known — this is a
// mitigation, not a fix, and it is honest about that.
//
// What makes retrying correct rather than hopeful: a failed attempt now leaves NOTHING behind.
// The firmware's lost-link path aborts the update, releases the verifier and returns the
// WebSocket buffers, so the device answers the next attempt with a full heap and no OTA state.
// Verified: ABORT_OTA after a failed attempt reports OTA_WARN_NO_OTA_TO_ABORT.
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 4);

function attempt(n) {
  return new Promise(async (resolveAttempt, rejectAttempt) => {
    const ws = new WebSocket(`ws://${HOST}:8080/`);
    ws.binaryType = 'arraybuffer';
    const frames = new Map();
    let acked = 0;
    let ackWake = null;
    let finalStatus = '';
    let deviceFault = null;
    let resolveSuccess;
    const successStatus = new Promise((resolve) => { resolveSuccess = resolve; });
    const fail = (e) => { try { ws.close(); } catch { /* already closed */ } rejectAttempt(e); };

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
          // A refusal and a silent device look the same to a sender watching only ACKs — it
          // waits out the ACK timeout and reports a stall instead of the reason.
          if (finalStatus.startsWith('OTA_ERR')) deviceFault = finalStatus;
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
      if (deviceFault) return Promise.reject(new Error(`device stopped the update: ${deviceFault}`));
      if (acked > previous) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = (fn) => { clearTimeout(timer); clearInterval(poll); ackWake = null; fn(); };
        const timer = setTimeout(() => done(() => reject(new Error('timeout waiting for OTA ACK'))), timeoutMs);
        const poll = setInterval(() => {
          if (deviceFault) done(() => reject(new Error(`device stopped the update: ${deviceFault}`)));
        }, 100);
        ackWake = () => done(resolve);
      });
    }

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connect failed')); });
      });

      send(CH.DEVICE_INFO, OP.READ);
      const info = JSON.parse(new TextDecoder().decode(await take(CH.DEVICE_INFO, 4000)));
      if (info.name !== EXPECT_NAME) {
        return fail(new Error(`refusing ${HOST}: expected "${EXPECT_NAME}", DEVICE_INFO says "${info.name}"`));
      }
      console.log(`attempt ${n}/${ATTEMPTS}: ${info.name} (${info.chip}, ${info.fw_ver}, heap ${info.heap})`);

      let sent = 0;
      let offset = 0;
      const started = Date.now();
      // The opening chunk is where this fails, so give it its own short deadline: a stuck
      // start should cost seconds and be retried, not spend the full ACK timeout.
      let firstAckDeadline = 8000;
      while (offset < firmware.length) {
        while (sent - acked >= WINDOW) {
          await waitForAck(acked, sent <= WINDOW ? firstAckDeadline : 15000);
        }
        const end = Math.min(offset + CHUNK, firmware.length);
        send(CH.OTA_DATA, OP.WRITE, firmware.subarray(offset, end));
        offset = end;
        sent++;
        if (sent % 64 === 0 || offset === firmware.length) {
          console.log(`  ${Math.round(offset / firmware.length * 100)}% (${sent} sent, ${acked} ACKed)`);
        }
      }
      while (acked < sent) await waitForAck(acked);
      console.log(`transfer complete: ${firmware.length} bytes, ${sent} chunks, ${Date.now() - started}ms`);

      if (signature) send(CH.OTA_SIGNATURE, OP.WRITE, signature);
      send(CH.OTA_CONTROL, OP.WRITE,
           new TextEncoder().encode(signature ? 'END_OTA' : 'END_OTA_UNSIGNED'));

      // A reboot does not necessarily produce a timely TCP close on every host, so the
      // device's explicit success status is the primary result; then allow its 2 s reboot.
      await Promise.race([
        new Promise((resolve) => ws.addEventListener('close', resolve, { once: true })),
        successStatus.then(() => new Promise((resolve) => setTimeout(resolve, 3000))),
        new Promise((resolve) => setTimeout(resolve, 30000)),
      ]);
      try { ws.close(); } catch { /* already closed */ }
      if (finalStatus === 'OTA_SUCCESS_REBOOTING') return resolveAttempt(finalStatus);
      return rejectAttempt(new Error(`finalize did not report success; last status: ${finalStatus || 'none'}`));
    } catch (e) {
      return fail(e);
    }
  });
}

let lastError = null;
for (let n = 1; n <= ATTEMPTS; n++) {
  try {
    const status = await attempt(n);
    console.log(`OTA succeeded on attempt ${n}: ${status} (${path.basename(FIRMWARE_PATH)})`);
    process.exit(0);
  } catch (e) {
    lastError = e;
    console.log(`attempt ${n} failed: ${e.message}`);
    // A device-side refusal is a decision, not a glitch; retrying it just repeats the answer.
    if (/device stopped the update|refusing /.test(e.message)) break;
    if (n < ATTEMPTS) {
      console.log('  device keeps its old image; letting it settle, then retrying...');
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}
console.error(`OTA failed after ${ATTEMPTS} attempt(s): ${lastError?.message}`);
process.exit(1);
