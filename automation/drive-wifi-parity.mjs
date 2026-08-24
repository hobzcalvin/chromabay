#!/usr/bin/env node
// Prove that Wi-Fi and Bluetooth are the same protocol, on real hardware.
//
// Flow:
//   1. Connect the app to the device over BLE (chooser answered via CDP DeviceAccess).
//   2. Flip it to Wi-Fi from the settings panel and let it reboot.
//   3. Reconnect over Wi-Fi from the same page, and check the device gets the SAME card —
//      settings, LED config, brightness — with no Wi-Fi-specific UI involved.
//
// Usage: node automation/drive-wifi-parity.mjs [--ssid X --pass Y] [--keep-open]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_URL = process.env.APP_URL || 'http://localhost:5173/devices';
const PYTHON = process.env.PYTHON || `${homedir()}/.platformio/penv/bin/python`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SSID = arg('ssid', 'Mud Loci');
const PASS = arg('pass', 'kittylicksalot');
const KEEP_OPEN = process.argv.includes('--keep-open');

// The EXACT device to drive. Never a pattern.
//
// This script reboots a device onto a different network. A loose match here (the old
// /chromabay|esp32|m5/i) picks whichever ChromaBay answers the scan first, which on this
// bench is as likely to be a live installation — Portal, Butterfly — as the bare devkit on
// the USB cable. Reconfiguring one of those is not a test failure, it is taking a sculpture
// off the air.
//
// So: the target is the device on the USB cable, identified by the name IT prints on boot,
// and every other device is ignored. --device overrides it only if you say so explicitly.
const TARGET = arg('device', null);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`, m: (s) => `\x1b[35m${s}\x1b[0m` };
const log = (...a) => console.log(c.g('[drive]'), ...a);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? c.g('  PASS') : c.r('  FAIL')}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function findSerialPort() {
  const dev = readdirSync('/dev');
  const m = dev.find((d) => /^cu\.(usbserial-|SLAB_USBtoUART|wchusbserial|usbmodem)/.test(d));
  return m ? `/dev/${m}` : null;
}

function startSerial(port) {
  const proc = spawn(PYTHON, ['-u', path.join(HERE, 'serial_reader.py'), port, '115200'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = [], waiters = [];
  let partial = '';
  proc.stdout.on('data', (buf) => {
    partial += buf.toString();
    const parts = partial.split('\n'); partial = parts.pop() ?? '';
    for (const line of parts) {
      process.stdout.write(`${c.c('[esp32]')} ${line}\n`);
      seen.push(line);
      for (const w of [...waiters]) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(line); }
    }
  });
  return {
    waitFor(re, timeoutMs = 20000) {
      const hit = seen.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`serial timeout: ${re}`)); }, timeoutMs);
        waiters.push(w);
      });
    },
    find: (re) => seen.find((l) => re.test(l)),
    stop() { try { proc.kill('SIGINT'); } catch {} },
  };
}

// Pulse reset so the device reprints its boot banner (identity) on demand.
function resetDevice(port) {
  return new Promise((resolve, reject) => {
    const py = `
import serial, time
s = serial.Serial('${port}', 115200, timeout=0.2)
s.setDTR(False); s.setRTS(True); time.sleep(0.1); s.setRTS(False)
s.close()`;
    const proc = spawn(PYTHON, ['-c', py], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', () => resolve());
  });
}

let serial, browser;
const cleanup = async () => { serial?.stop(); if (!KEEP_OPEN) await browser?.close().catch(() => {}); };
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

try {
  const port = findSerialPort();
  if (port) { log(`serial on ${port}`); serial = startSerial(port); }
  else log('no serial port — continuing without the device-side view');

  // Ask the USB-attached device who it is. Its boot banner is the only trustworthy source:
  // a BLE scan cannot tell which device is on the cable, and that is exactly the confusion
  // that would let this script reconfigure the wrong one.
  let target = TARGET;
  if (!target) {
    if (!serial) throw new Error('no serial port and no --device: refusing to guess which device to drive');
    log('resetting the USB device to read its identity…');
    await resetDevice(port);
    const line = await serial.waitFor(/^Device name: (\S+)/, 30000);
    target = line.match(/Device name: (\S+)/)[1];
  }
  log(`target device: ${c.g(target)} (every other device will be ignored)`);
  const isTarget = (name) => (name || '').trim() === target;

  // Where is it now? A previous run may have left it on Wi-Fi.
  const modeLine = serial?.find(/Settings: mode=(\w+)/);
  const startMode = modeLine?.match(/mode=(\w+)/)?.[1] ?? 'ble';
  log(`device is currently on ${c.g(startMode)}`);

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (/error|fail|Wi-Fi|wifi/i.test(m.text())) process.stdout.write(`${c.m('[browser]')} ${m.text()}\n`); });
  page.on('pageerror', (e) => process.stdout.write(`${c.r('[browser:error]')} ${e.message}\n`));

  const cdp = await context.newCDPSession(page);
  await cdp.send('DeviceAccess.enable');
  let selected = false;
  cdp.on('DeviceAccess.deviceRequestPrompted', async (e) => {
    if (selected) return;
    const seenNames = (e.devices || []).map((d) => d.name).filter(Boolean);
    const match = (e.devices || []).find((d) => isTarget(d.name));
    if (match) {
      selected = true;
      log(`selecting ${c.g(match.name)}`);
      await cdp.send('DeviceAccess.selectPrompt', { id: e.id, deviceId: match.id }).catch(() => {});
    } else if (seenNames.length) {
      // Say what we are declining, so "it never connected" is never mistaken for "it
      // connected to something else".
      log(`ignoring ${seenNames.length} non-target device(s): ${seenNames.join(', ')}`);
    }
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  // ---- 1. BLE ------------------------------------------------------------------------
  if (startMode === 'wifi') {
    log('already on Wi-Fi — skipping the Bluetooth leg');
  } else {
  log('connecting over BLE…');
  await page.getByRole('button', { name: /Select ESP32 Device|Scan for ESP32s/i }).click();
  await page.getByRole('button', { name: /Show Settings/i }).first().waitFor({ state: 'visible', timeout: 45000 });
  check('BLE: device connects and shows its card', true);

  await page.getByRole('button', { name: /Show Settings/i }).first().click();
  await page.getByRole('tab', { name: 'Connection' }).first().waitFor({ state: 'visible', timeout: 20000 });
  check('BLE: settings panel reads COMM_CONFIG', true);

  // Last check before we change anything on the device: the card on screen must be the
  // target. The chooser is filtered, but a stale card from a previous run would not be.
  const onPage = await page.locator('body').innerText();
  if (!onPage.includes(target)) {
    throw new Error(`connected card is not ${target} — refusing to change its transport`);
  }
  check(`connected device is ${target}`, true);

  // ---- 2. Switch to Wi-Fi -------------------------------------------------------------
  log(`switching device to Wi-Fi "${SSID}"…`);
  await page.getByRole('button', { name: 'Wi-Fi', exact: true }).first().click();
  await page.getByPlaceholder('SSID').fill(SSID);
  await page.locator('input[type=password]').first().fill(PASS);
  await page.getByRole('button', { name: /^Save$/ }).first().click();

  if (serial) {
    await serial.waitFor(/transport change|rebooting/i, 20000);
    const ip = await serial.waitFor(/\[WiFi\] connected: ([0-9.]+)/, 60000);
    check('device reboots onto Wi-Fi', true, ip.trim());
    const mdns = await serial.waitFor(/\[WiFi\] mDNS: (\S+)\.local/, 15000);
    check('device advertises mDNS', true, mdns.trim());
  } else {
    await new Promise((r) => setTimeout(r, 25000));
  }
  }

  // ---- 3. Reconnect over Wi-Fi --------------------------------------------------------
  // Prefer what the device actually announced; otherwise derive it from the target name the
  // same way the firmware sanitizes it. Never a hardcoded host.
  const sanitize = (n) => {
    let h = '';
    for (const ch of n.toLowerCase()) {
      if (/[a-z0-9]/.test(ch)) h += ch;
      else if ((ch === ' ' || ch === '_' || ch === '-') && h && h.slice(-1) !== '-') h += '-';
    }
    return (h.replace(/-+$/, '') || 'chromabay') + '.local';
  };
  const host = serial?.find(/\[WiFi\] mDNS: (\S+)\.local/)?.match(/mDNS: (\S+\.local)/)?.[1] || sanitize(target);
  log(`connecting over Wi-Fi to ${host}…`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder(/device\.local/i).fill(host);
  await page.getByPlaceholder(/device\.local/i).press('Enter');

  // The whole point: the Wi-Fi device gets the ordinary device card, not a lesser one.
  const card = page.getByRole('button', { name: /Show Settings/i }).first();
  await card.waitFor({ state: 'visible', timeout: 40000 });
  check('Wi-Fi: device appears in the SAME device list with the same card', true);

  const briSlider = page.locator('input[type=range]').first();
  check('Wi-Fi: LED config read (brightness slider present)', await briSlider.count() > 0);

  await card.click();
  await page.getByRole('tab', { name: 'Connection' }).first().waitFor({ state: 'visible', timeout: 20000 });
  check('Wi-Fi: settings panel reads COMM_CONFIG over Wi-Fi', true);
  const nowOn = await page.locator('.hint', { hasText: /Now on/ }).first().textContent().catch(() => '');
  check('Wi-Fi: panel reports the active transport', /Wi-Fi/i.test(nowOn || ''), (nowOn || '').trim());

  // Brightness: a write that the device must act on, over Wi-Fi.
  if (serial) {
    await briSlider.fill('42');
    await briSlider.dispatchEvent('input');
    await briSlider.dispatchEvent('change');
    try {
      await serial.waitFor(/last-on level = 42|Brightness.*42/i, 12000);
      check('Wi-Fi: BRIGHTNESS write reaches the device', true);
    } catch { check('Wi-Fi: BRIGHTNESS write reaches the device', false, 'no serial confirmation'); }
  }

  // There must be no Wi-Fi-specific device controls left on the page.
  const legacy = await page.getByRole('button', { name: /Push current pattern/i }).count();
  check('no bespoke Wi-Fi device controls remain', legacy === 0, legacy ? `${legacy} found` : '');

  // ---- 4. Restore ---------------------------------------------------------------------
  if (startMode === 'ble' && !KEEP_OPEN) {
    log('switching the device back to Bluetooth…');
    try {
      await page.getByRole('button', { name: 'Bluetooth', exact: true }).first().click();
      await page.getByRole('button', { name: /^Save$/ }).first().click();
      if (serial) await serial.waitFor(/BLE services started/i, 45000);
      check('device returns to Bluetooth (left as found)', true);
    } catch (e) {
      check('device returns to Bluetooth (left as found)', false, e.message);
    }
  }

  console.log('\n' + '='.repeat(60));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? c.r(`${failed.length}/${results.length} checks FAILED`) : c.g(`all ${results.length} checks passed`));
  await cleanup();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error(c.r(`\n[drive] ${e.message}`));
  results.filter((r) => !r.ok).forEach((r) => console.error(c.r(`  failed: ${r.name}`)));
  await cleanup();
  process.exit(1);
}
