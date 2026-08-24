#!/usr/bin/env node
// End-to-end ESP32 + app driving harness.
//
// One command that:
//   1. Reflashes the USB-connected ESP32 (pio run -t upload)   [skip with --no-flash]
//   2. Tails its serial console at 115200 (printed in cyan, and searchable)
//   3. Launches real Google Chrome via Playwright
//   4. Auto-accepts the Web Bluetooth chooser via CDP DeviceAccess (picks the
//      device whose name matches DEVICE_NAME_RE) — no human click needed
//   5. Drives the app UI to connect + fiddle, and waits for the serial console
//      to reflect what we did
//
// Usage:
//   npm run drive                 # full loop (reflash + drive)
//   npm run drive -- --no-flash   # skip the reflash, just drive the browser
//   APP_URL=http://localhost:5173/devices npm run drive
//
// Requirements / first-run notes:
//   - The app dev server must already be running (npm run dev).
//   - macOS will ask to grant *Google Chrome* Bluetooth access the first time
//     (System Settings → Privacy & Security → Bluetooth). Web Bluetooth silently
//     finds nothing until that's granted. Re-run after granting.
//   - Must be a secure context: localhost is fine.
//   - The ESP32 must be powered + USB-connected and advertising (ChromaBay_ESP32).
//
// This is intentionally a plain script (not the Playwright test runner) so you
// can keep the browser open and iterate. Edit the DRIVE section at the bottom.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- config
const APP_URL = process.env.APP_URL || 'http://localhost:5173/devices';
const PROJECT_DIR = process.env.ESP32_DIR || path.resolve('esp32');
const PIO = process.env.PIO || `${homedir()}/.platformio/penv/bin/pio`;
const PYTHON = process.env.PYTHON || `${homedir()}/.platformio/penv/bin/python`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Which device to drive. This harness can OTA whatever it connects to, and several real
// ChromaBay installations (Portal, Butterfly) are usually powered and in BLE range — so the
// default must not be a pattern that matches "whichever one answers first". When no name is
// given we take it from the USB device's own boot banner, which is the only thing that knows
// which device is actually on the cable. DEVICE_NAME is an exact name; DEVICE_NAME_RE is
// still honoured for the rare case you really do want a pattern.
const DEVICE_NAME = process.env.DEVICE_NAME || null;
const DEVICE_NAME_RE = process.env.DEVICE_NAME_RE ? new RegExp(process.env.DEVICE_NAME_RE, 'i') : null;
let deviceMatches = DEVICE_NAME
  ? (n) => (n || '').trim() === DEVICE_NAME
  : DEVICE_NAME_RE
    ? (n) => DEVICE_NAME_RE.test(n || '')
    : null; // resolved from serial below
const SERIAL_BAUD = '115200';
const NO_FLASH = process.argv.includes('--no-flash');
// By default we run the flow then EXIT 0/1 (so an automated loop gets a verdict).
// Pass --keep-open / -k to leave the browser + serial running for interactive poking.
const KEEP_OPEN = process.argv.includes('--keep-open') || process.argv.includes('-k');

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s) => `\x1b[35m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const log = (...a) => console.log(green('[drive]'), ...a);

// ---------------------------------------------------------------- helpers
function findSerialPort() {
  const dev = readdirSync('/dev');
  const m =
    dev.find((d) => /^cu\.usbserial-/.test(d)) ||
    dev.find((d) => /^cu\.(SLAB_USBtoUART|wchusbserial|usbmodem)/.test(d));
  if (!m) throw new Error('No USB serial port found (looked for /dev/cu.usbserial-*)');
  return `/dev/${m}`;
}

function runToCompletion(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(' ')}`);
    const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// Streams the serial console, prints it, and lets us await specific lines.
// Reads via pyserial (bundled with PlatformIO) — NOT `pio device monitor` (its miniterm
// needs an interactive TTY and crashes headlessly), `cat` (block-buffers piped stdout),
// or Node fs (doesn't reliably emit from a macOS char device). See serial_reader.py.
function startSerialMonitor(port) {
  log(`opening serial monitor on ${port} @ ${SERIAL_BAUD}`);
  const proc = spawn(PYTHON, ['-u', path.join(HERE, 'serial_reader.py'), port, SERIAL_BAUD], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seen = [];
  const waiters = [];
  let partial = '';
  const handle = (buf) => {
    partial += buf.toString();
    const parts = partial.split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) {
      process.stdout.write(`${cyan('[esp32]')} ${line}\n`);
      seen.push(line);
      for (const w of [...waiters]) {
        if (w.re.test(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(line);
        }
      }
    }
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', (b) => process.stdout.write(`${red('[serial]')} ${b}`));

  return {
    proc,
    // Resolve when a serial line matches `re` (checks history first).
    waitFor(re, timeoutMs = 10000) {
      const hit = seen.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`serial: timed out waiting for ${re}`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    stop() {
      try { proc.kill('SIGINT'); } catch {}
    },
  };
}

// ---------------------------------------------------------------- main
let serial;
let browser;

async function cleanup() {
  log('cleaning up…');
  serial?.stop();
  await browser?.close().catch(() => {});
}
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });

try {
  // A serial cable is optional for a BLE-only run. It is required only when doing the
  // initial PlatformIO flash; otherwise the UI itself is our source of truth.
  let port = null;
  try { port = findSerialPort(); } catch (e) {
    if (!NO_FLASH) throw e;
    log('no USB serial device; continuing BLE-only (--no-flash)');
  }

  // 1. Reflash (upload uses the port, so do it BEFORE opening the monitor).
  if (!NO_FLASH) {
    await runToCompletion(PIO, ['run', '-d', PROJECT_DIR, '-t', 'upload']);
    log(green('flash complete'));
  } else {
    log('skipping reflash (--no-flash)');
  }

  // 2. Serial monitor when a USB UART is present (BLE itself does not require one).
  if (port) serial = startSerialMonitor(port);

  // Resolve the target if it wasn't given. A reflash prints the banner already; otherwise
  // wait for one (the device prints it on every boot). Refuse to guess.
  if (!deviceMatches) {
    if (!serial) {
      throw new Error('No DEVICE_NAME and no serial port — refusing to guess which ChromaBay to drive. ' +
                      'Set DEVICE_NAME=ChromaBay_XXXX (other devices on this bench may be live installations).');
    }
    log('reading the target name from the USB device…');
    const line = await serial.waitFor(/^Device name: (\S+)/, 40000);
    const name = line.match(/Device name: (\S+)/)[1];
    log(green(`target device: ${name} (all other devices ignored)`));
    deviceMatches = (n) => (n || '').trim() === name;
  }

  // 3. Launch real Chrome (channel:'chrome' so Web Bluetooth has a real radio).
  log('launching Chrome…');
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => process.stdout.write(`${magenta('[browser]')} ${m.text()}\n`));
  page.on('pageerror', (e) => process.stdout.write(`${red('[browser:error]')} ${e.message}\n`));

  // 4. Auto-accept the Bluetooth device chooser via CDP DeviceAccess. The domain is
  //    exposed on the PAGE-level CDP session (not the browser-level one — that returns
  //    "'DeviceAccess.enable' wasn't found").
  const cdp = await context.newCDPSession(page);
  await cdp.send('DeviceAccess.enable');
  // The prompt event fires repeatedly as the scan discovers devices — the FIRST fire is
  // usually empty. So we wait for our device to appear across fires and select it then;
  // we only give up (cancel) after a timeout. (Cancelling on the first empty fire was
  // the bug that made connect fail.)
  let selectedDevice = false;
  let cancelTimer = null;
  cdp.on('DeviceAccess.deviceRequestPrompted', async (e) => {
    if (selectedDevice) return;
    if (cancelTimer === null) {
      cancelTimer = setTimeout(async () => {
        if (!selectedDevice) {
          log(red('target device did not appear within 25s; cancelling chooser'));
          try { await cdp.send('DeviceAccess.cancelPrompt', { id: e.id }); } catch {}
        }
      }, 25000);
    }
    const match = (e.devices || []).find((d) => deviceMatches(d.name || ''));
    if (match) {
      selectedDevice = true;
      clearTimeout(cancelTimer);
      log(`auto-selecting BLE device "${match.name}"`);
      try { await cdp.send('DeviceAccess.selectPrompt', { id: e.id, deviceId: match.id }); }
      catch (err) { log(red(`selectPrompt failed: ${err.message}`)); }
    } else {
      const names = (e.devices || []).map((d) => d.name).filter(Boolean);
      log(`chooser: ignoring ${names.length} non-target device(s)${names.length ? `: ${names.join(', ')}` : ''}`);
    }
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  log(`opened ${APP_URL}`);

  // ============================================================ DRIVE
  // Everything below is the editable "flow". Add clicks/asserts here.

  // Connect: the click is the required user gesture that triggers requestDevice();
  // the CDP handler above answers the chooser.
  await page.getByRole('button', { name: /Select ESP32 Device|Scan for ESP32s/i }).click();
  log('clicked connect — waiting for the device to report the connection on serial…');

  // The firmware logs a timestamp sync shortly after the app connects when USB serial is
  // available. In a BLE-only run, wait for the connected device's settings button instead.
  if (serial) {
    const line = await serial.waitFor(/Timestamp sync received|sync received|Client connected/i, 20000);
    log(green(`✓ device acknowledged connection: ${line.trim()}`));
  } else {
    await page.getByRole('button', { name: /Show Settings/i }).first().waitFor({ state: 'visible', timeout: 30000 });
    log(green('✓ device connected over BLE'));
  }

  // Open settings and optionally exercise the registry OTA path. OTA_MODE=latest clicks
  // the offered "Update to …" button and waits for success/failure text.
  await page.getByRole('button', { name: /Show Settings/i }).first().click().catch(() => {});
  await page.getByRole('button', { name: /Refresh Info/i }).first().click().catch(() => {});

  if (process.env.OTA_MODE === 'latest') {
    const update = page.getByRole('button', { name: /Update to /i }).first();
    await update.waitFor({ state: 'visible', timeout: 30000 });
    log(`clicking firmware update: ${await update.textContent()}`);
    await update.click();
    const result = page.getByText(/Firmware update completed|OTA Failed:|firmware update failed/i).first();
    await result.waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });
    const text = (await result.textContent()) || '';
    log(`OTA result: ${text}`);
    if (/failed/i.test(text)) throw new Error(text);
  }

  if (KEEP_OPEN) {
    log(green('flow complete. Browser + serial stay open — Ctrl-C to stop, or edit the DRIVE section.'));
    await new Promise(() => {}); // keep alive so you can watch / iterate
  } else {
    log(green('✓ flow complete — closing (pass --keep-open to stay open).'));
    await cleanup();
    process.exit(0);
  }
  // ========================================================== /DRIVE
} catch (err) {
  console.error(red('[drive] failed:'), err.message);
  await cleanup();
  process.exit(1);
}
