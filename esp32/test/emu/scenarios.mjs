// The firmware tests. Each scenario scripts one (or two) esp32sim runs and asserts on the
// console, the [ble] events and the decoded LED ring. See documentation/ESP32_EMULATOR.md.
//
// Times are emulated seconds from power-on. On the S3 emu build, setup() finishes at ~2.6 s
// (1.5 s of it is the R/G/B self-test), so scripts connect at 3.0.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, OUT_DIR, SERVICE_UUID, Script, build, check, checkHealthy, runEmu, TestFailure } from './lib/emu.mjs';
import { endpointTable, discovered, handlesByName, propsText, patternChunks, timestampSync, playlistSync, onePattern } from './lib/protocol.mjs';
import { onWire, scaledRgb, fmt, framesIn, mean, uniform, close, timeline, describeTimeline, wasmRender, RING_LEDS } from './lib/leds.mjs';

const S3 = 'esp32-s3-emu';
const C3 = 'esp32-c3-emu';
const CONNECT = 3.0;

// ---- Shared pieces -------------------------------------------------------------------------

const handleCache = new Map();

/**
 * Handles by endpoint name, from a discovery run of this build. A script is fixed before the
 * emulator starts, so handles are learnt once per build and reused; nothing is hard-coded.
 */
async function handles(env, chip = 's3') {
  if (handleCache.has(env)) return handleCache.get(env);
  const sc = new Script(chip).connect(CONNECT).discover(CONNECT + 0.1);
  const run = await runEmu({ name: `${env}-discovery`, chip, images: build(env), ble: true, script: sc, seconds: CONNECT + 1.5 });
  checkHealthy(run);
  check(run.bleOf('discovered').length === 1, 'GATT discovery never completed', run);
  const h = { run, found: discovered(run), byName: handlesByName(discovered(run)) };
  handleCache.set(env, h);
  return h;
}

function need(h, name) {
  const e = h.byName[name];
  if (!e) throw new TestFailure(`endpoint ${name} was not discovered (see the gatt scenario)`, h.run);
  return e;
}

/** Push a pattern the way the app does: one ATT write per chunk, queued in order. */
function pushPattern(sc, t, h, pattern, lib) {
  const ps = need(h, 'PATTERN_SYNC').handle;
  for (const c of patternChunks(pattern, { lib })) sc.write(t, ps, c);
}

const bootName = (run, boot = 0) => run.find(/^Device name: (.+)$/, boot)?.[1];
const consoleBrightness = (run, boot = 0) => +(run.find(/Global Brightness: (\d+)/, boot)?.[1] ?? NaN);

function adverts(run, t0, t1 = Infinity) { return run.bleOf('advert').filter((a) => a.t >= t0 && a.t < t1); }

function readsOf(run, handle, t0 = 0) { return run.bleOf('read').filter((r) => r.handle === handle && r.t >= t0); }

function oneRead(run, handle, t0, what) {
  const r = readsOf(run, handle, t0)[0];
  check(r, `no read reply for ${what} (handle 0x${handle.toString(16)}) after t=${t0}`, run);
  return r.value;
}

function json(run, buf, what) {
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new TestFailure(`${what} is not JSON (${e.message}): ${JSON.stringify(buf.toString('utf8'))}`, run); }
}

/** Expect one advertisement, carrying exactly one name, equal to `name`. */
function checkAdvertName(run, ads, name, why) {
  check(ads.length > 0, `${why}: the device did not re-advertise`, run);
  for (const a of ads) {
    check(a.services.includes(SERVICE_UUID), `${why}: advert at t=${a.t} lacks the ChromaBay service ${SERVICE_UUID}`, run);
    check(a.names.length === 1 && a.names[0] === name,
      () => `${why}: advert at t=${a.t} carries ${a.names.length} name(s) ${a.names.map((n) => JSON.stringify(n)).join(', ')}, ` +
            `expected exactly ${JSON.stringify(name)}. A second name with old bytes after a NUL is the NimBLE 1.4.3 ` +
            `scan-response bug (setName() leaves the scan response pointing at the old name) — see configureAdvertising() in main.cpp`, run);
  }
}

/** The ring's mean colour per LED over [t0, t1), with enough frames to average dither out. */
function ringMean(run, t0, t1, what) {
  const fr = framesIn(run, t0, t1);
  check(fr.length >= 3, () => `${what}: only ${fr.length} LED frame(s) between t=${t0} and t=${t1} — is the strip updating?\n${describeTimeline(timeline(run, t0 - 1, t1 + 1))}`, run);
  return mean(fr);
}

function checkRing(run, got, want, tol, what, t0, t1) {
  const bad = got.map((c, i) => (close(c, want[i], tol) ? null : i)).filter((i) => i !== null);
  check(bad.length === 0, () => `${what}: ring LED(s) ${bad.join(',')} differ by more than ${tol}\n` +
    `  want ${want.map(fmt).join(' ')}\n  got  ${got.map(fmt).join(' ')}\n` +
    `ring between t=${t0 - 0.5} and ${t1 + 0.5}:\n${describeTimeline(timeline(run, t0 - 0.5, t1 + 0.5))}`, run);
}

// Patterns, as the app serializes them. `gradient` is static (no time input), so the device and
// the WASM preview must agree on every pixel regardless of clock.
const solid = (name, hue, sat = 255) =>
  onePattern(name, 'gradient', { start_hue: hue, end_hue: hue, start_sat: sat, end_sat: sat, start_val: 255, end_val: 255 });
const ramp = (name) =>
  onePattern(name, 'gradient', { angle: 0, start_hue: 0, end_hue: 255, start_sat: 255, end_sat: 160, start_val: 255, end_val: 40 });
const STRIP = 64; // the default config's strip: 64 LEDs on the emu LED pin, rendered as 64x1

/** What the ring should show for a one-node pattern at brightness `bri`, per the WASM engine. */
async function expectedRing(pattern, bri) {
  const n = pattern.nodes[0];
  const px = await wasmRender(n.t, n.p, { width: STRIP, height: 1 });
  return px.slice(0, RING_LEDS).map((c) => onWire(scaledRgb(c, bri)));
}

// ---- Scenarios -----------------------------------------------------------------------------

export const scenarios = [
  {
    name: 'boot-smoke',
    what: 'S3 boots to "Setup complete" with no crash, advertises the ChromaBay service and ChromaBay_XXXX, accepts a connection',
    async run() {
      const sc = new Script().connect(CONNECT);
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 5 });
      checkHealthy(run);
      check(run.has('Setup complete'), () => `never reached "Setup complete"\n${run.tail()}`, run);
      const name = bootName(run);
      check(/^ChromaBay_[0-9A-F]{4}$/.test(name ?? ''), `boot name ${JSON.stringify(name)} is not ChromaBay_XXXX`, run);
      const ads = adverts(run, 0);
      check(ads.length >= 1, 'the device never advertised', run);
      checkAdvertName(run, [ads[0]], name, 'boot advertisement');
      check(run.bleOf('connected').length === 1, 'the virtual central could not connect', run);
    },
  },

  {
    name: 'fresh-flash',
    what: 'blank flash: LittleFS formats and a default config is written; after a reboot the same flash mounts without reformatting, and a stored pattern is still there',
    async run() {
      const h = await handles(S3);
      const ps = need(h, 'PATTERN_SYNC');
      const keep = solid('EmuKeep', 96);
      const sc = new Script().connect(CONNECT).subscribe(CONNECT + 0.05, ps.ccc).write(CONNECT + 0.1, need(h, 'BRIGHTNESS').handle, [255]);
      pushPattern(sc, CONNECT + 0.2, h, keep, true);
      sc.reboot(6.0);
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 10 });
      checkHealthy(run, { expectedResets: 1 });
      check(run.resets[0].cause === 'RTC_SW_SYS_RESET', `unexpected reset cause ${run.resets[0].cause}`, run);

      for (const l of ['LittleFS mount failed — formatting', 'LittleFS formatted and mounted',
                       '[ConfigManager] No config file found. Creating default', '[ConfigManager] Default config file created successfully.',
                       '[ConfigManager] Configuration successfully loaded from /led_config.mpack', 'Setup complete']) {
        check(run.has(l, 0), `first boot on blank flash: missing "${l}"`, run);
      }
      const ack = run.bleOf('notify').find((n) => n.handle === ps.handle);
      check(ack && ack.value[0] === 0 && ack.value.subarray(1).toString() === 'EmuKeep',
        () => `no "stored" ack for the library push before the reboot (got ${ack ? ack.value.toString('hex') : 'nothing'})`, run);

      // The second boot is the one that guards "a core bump silently loses patterns" (platformio.ini).
      check(run.has('LittleFS mounted', 1), 'second boot: LittleFS did not mount', run);
      for (const l of ['LittleFS mount failed', 'formatting', 'No config file found', 'Using fallback LED configuration']) {
        check(!run.has(l, 1), `second boot: "${l}" — the flash written by the first boot was not readable, so saved patterns would be lost`, run);
      }
      check(run.has('[ConfigManager] Configuration successfully loaded from /led_config.mpack', 1), 'second boot: config not loaded', run);
      check(run.has(/\[PatternState @ boot\] libraryPatterns=1 /, 1), () => `second boot: the stored pattern is gone:\n${run.find(/\[PatternState @ boot\].*/, 1)?.[0]}`, run);
      // And it is what plays: the brightness (saved 1.5 s after the write) and the pattern both came back.
      const want = await expectedRing(keep, 255);
      const t = run.resets[0].t + 3.0;
      checkRing(run, ringMean(run, t, t + 0.6, 'after reboot'), want, 1.5, 'after the reboot the stored pattern should be playing', t, t + 0.6);
    },
  },

  {
    name: 'gatt',
    what: 'every endpoint in main.cpp\'s ENDPOINTS table is served, with the table\'s properties, and nothing else is',
    async run() {
      const h = await handles(S3);
      const run = h.run;
      const table = endpointTable();
      check(table.length === 26, `ENDPOINTS has ${table.length} rows; this test (and the notes) expect 26 — update both if that changed on purpose`, run);
      const ours = [...h.found.values()].filter((c) => c.service === SERVICE_UUID);
      const problems = [];
      for (const e of table) {
        const d = h.found.get(e.uuid);
        if (!d) problems.push(`missing: ${e.name} ${e.uuid}`);
        else if (d.service !== SERVICE_UUID) problems.push(`${e.name} is outside the ChromaBay service (${d.service})`);
        else if (d.props !== e.props) problems.push(`${e.name}: table says ${propsText(e.props)}, device serves ${propsText(d.props)}`);
        if (d && (e.props & 0x30) && !d.ccc) problems.push(`${e.name} notifies but has no CCC descriptor to subscribe with`);
      }
      for (const c of ours) if (!table.some((e) => e.uuid === c.uuid)) problems.push(`extra characteristic ${c.uuid} (props ${propsText(c.props)}) not in ENDPOINTS`);
      check(problems.length === 0, () => `GATT table and ENDPOINTS disagree:\n  ${problems.join('\n  ')}`, run);
      check(ours.length === table.length, `served ${ours.length} characteristics, ENDPOINTS has ${table.length}`, run);
    },
  },

  {
    name: 'roundtrip',
    what: 'brightness, device name (incl. the short-rename advert regression), device info, comm config and button pin round-trip; name, brightness and button pin survive a reboot',
    async run() {
      const h = await handles(S3);
      const B = need(h, 'BRIGHTNESS').handle, N = need(h, 'DEVICE_NAME').handle, I = need(h, 'DEVICE_INFO').handle;
      const C = need(h, 'COMM_CONFIG').handle, P = need(h, 'BUTTON_PIN').handle;
      const RENAMES = [[4.2, 'EmuLight'], [4.8, 'Kitchen_Lamp_42'], [5.4, 'Lamp']]; // long→short, short→long, long→short
      const REBOOT = 7.5, RECONNECT = 11.5;
      const sc = new Script().connect(CONNECT)
        .read(3.1, B).write(3.2, B, [0x50]).read(3.4, B)
        .readLong(3.5, I).readLong(3.7, C)
        .write(3.8, P, '17').read(4.0, P);
      for (const [t, n] of RENAMES) sc.write(t, N, n).read(t + 0.4, N);
      sc.readLong(5.9, I).reboot(REBOOT).connect(RECONNECT).read(RECONNECT + 0.1, N).read(RECONNECT + 0.2, B).read(RECONNECT + 0.3, P);
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: RECONNECT + 1 });
      checkHealthy(run, { expectedResets: 1 });
      const boot0 = bootName(run, 0);

      const bri = readsOf(run, B);
      check(bri.length === 3, `expected 3 brightness reads, got ${bri.length}`, run);
      check(bri[0].value[0] === 20, `default brightness read ${bri[0].value[0]}, expected 20 (the default config)`, run);
      check(bri[1].value[0] === 0x50, `brightness after writing 80 reads ${bri[1].value[0]}`, run);

      const info = json(run, oneRead(run, I, 3.5), 'device info');
      check(typeof info.fw_ver === 'string' && /^fwv\d/.test(info.fw_ver), `device info fw_ver ${JSON.stringify(info.fw_ver)}`, run);
      check(info.chip === 'esp32s3' && info.name === boot0 && Number.isInteger(info.feat),
        () => `device info fields: ${JSON.stringify(info)} (want chip esp32s3, name ${boot0}, integer feat)`, run);
      const comm = json(run, oneRead(run, C, 3.7), 'comm config');
      check(comm.mode === 'ble' && 'rtproto' in comm && 'rgbtest' in comm, () => `comm config: ${JSON.stringify(comm)}`, run);
      check(oneRead(run, P, 3.8).toString() === '17', 'button pin did not read back as 17', run);

      RENAMES.forEach(([t, n], i) => {
        check(oneRead(run, N, t).toString() === n, `name read after renaming to ${n}: ${oneRead(run, N, t).toString()}`, run);
        checkAdvertName(run, adverts(run, t, RENAMES[i + 1]?.[0] ?? REBOOT), n, `rename ${boot0 && i === 0 ? boot0 : RENAMES[i - 1][1]} → ${n}`);
      });
      const info2 = json(run, oneRead(run, I, 5.9), 'device info after renames');
      check(info2.name === 'Lamp', `device info name after rename: ${info2.name}`, run);

      // After the reboot: persisted, and advertised under the new name from the start.
      check(bootName(run, 1) === 'Lamp', `after reboot the device booted as ${bootName(run, 1)}`, run);
      check(consoleBrightness(run, 1) === 0x50, `after reboot brightness is ${consoleBrightness(run, 1)}, expected 80 (saved 1.5 s after the write)`, run);
      check(run.has('Button pin: 17', 1), 'button pin 17 not restored after reboot', run);
      checkAdvertName(run, adverts(run, REBOOT, RECONNECT), 'Lamp', 'advertising after reboot');
      check(oneRead(run, N, RECONNECT).toString() === 'Lamp', 'name read after reboot', run);
      check(oneRead(run, B, RECONNECT + 0.15)[0] === 0x50, 'brightness read after reboot', run);
      check(oneRead(run, P, RECONNECT + 0.25).toString() === '17', 'button pin read after reboot', run);
    },
  },

  {
    name: 'selftest',
    what: 'the power-on R, G, B test frames reach a dithered strip, in order, ~0.5 s each, then black (bug: they used to go out black)',
    async run() {
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', seconds: 3.2 });
      checkHealthy(run);
      const bri = consoleBrightness(run);
      check(bri === 20, `default config brightness ${bri}, expected 20`, run);
      check(run.has(/Settings: .*rgbtest=1/), 'the R/G/B test is off in the default settings — this scenario needs it on', run);
      // CRGB::Red, ::Green (FastLED's is 0x008000) and ::Blue, at the default brightness, as the wire carries them.
      const want = [['red', [255, 0, 0]], ['green', [0, 128, 0]], ['blue', [0, 0, 255]]].map(([n, c]) => [n, onWire(scaledRgb(c, bri))]);
      const tl = timeline(run, 0, 3.2);
      const lit = tl.filter((r) => r.uniform && r.uniform.some((v) => v > 0));
      const story = () => `ring during boot:\n${describeTimeline(tl)}`;
      check(lit.length >= 3, () => `expected 3 coloured test frames, saw ${lit.length} — on a dithered strip they used to be overwritten with black\n${story()}`, run);
      want.forEach(([n, c], i) => {
        check(close(lit[i].uniform, c, 1), () => `test frame ${i + 1} should be ${n} = ${fmt(c)} on the wire, got ${fmt(lit[i].uniform)}\n${story()}`, run);
        const next = tl[tl.indexOf(lit[i]) + 1];
        const held = next ? next.t0 - lit[i].t0 : Infinity;
        check(held > 0.4 && held < 0.65, () => `test frame ${n} held ${held.toFixed(3)} s, expected ~0.5\n${story()}`, run);
      });
      const after = tl[tl.indexOf(lit[2]) + 1];
      check(after && after.uniform && after.uniform.every((v) => v === 0), () => `after the blue frame the ring should go black\n${story()}`, run);
    },
  },

  {
    name: 'pattern',
    what: 'a pattern pushed over BLE in the app\'s wire format (MessagePack, 20-byte chunks) plays, pixel for pixel what the app\'s WASM preview renders',
    async run() {
      const h = await handles(S3);
      const a = solid('EmuSolid', 32), b = ramp('EmuRamp');
      const sc = new Script().connect(CONNECT).write(3.1, need(h, 'BRIGHTNESS').handle, [255]);
      pushPattern(sc, 3.2, h, a, false);
      pushPattern(sc, 5.2, h, b, false);
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 7.2 });
      checkHealthy(run);
      check(!run.has('Failed to load pattern'), 'the device rejected a pushed pattern', run);
      checkRing(run, ringMean(run, 4.4, 5.0, 'solid'), await expectedRing(a, 255), 1.5, 'solid pattern vs WASM', 4.4, 5.0);
      checkRing(run, ringMean(run, 6.4, 7.0, 'ramp'), await expectedRing(b, 255), 1.5, 'gradient ramp vs WASM (first 12 of 64 pixels)', 6.4, 7.0);
    },
  },

  {
    name: 'brightness',
    what: 'changing brightness while a pattern plays scales the ring output (255 → 64 → 8 → 0)',
    async run() {
      const h = await handles(S3);
      const B = need(h, 'BRIGHTNESS').handle;
      const white = solid('EmuWhite', 0, 0);
      const sc = new Script().connect(CONNECT).write(3.1, B, [255]);
      pushPattern(sc, 3.2, h, white, false);
      const steps = [[255, 4.2], [64, 5.0], [8, 5.8], [0, 6.6]];
      for (const [v, t] of steps.slice(1)) sc.write(t, B, [v]);
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 7.4 });
      checkHealthy(run);
      for (const [v, t] of steps) {
        if (v === 0) {
          // Off: the strip is sent black and then left alone — no frames needed to stay dark.
          const dark = (f) => f.leds.every((c) => c.every((x) => x === 0));
          const last = run.frames.at(-1);
          check(last.t >= t && dark(last) && framesIn(run, t + 0.1, Infinity).every(dark),
            () => `at brightness 0 the ring should go (and stay) black\n${describeTimeline(timeline(run, t - 0.5, Infinity))}`, run);
          continue;
        }
        const want = await expectedRing(white, v);
        checkRing(run, ringMean(run, t + 0.3, t + 0.7, `brightness ${v}`), want, 1, `at brightness ${v}`, t + 0.3, t + 0.7);
      }
    },
  },

  {
    name: 'playlist',
    what: 'two library patterns, a timestamp sync and a 2 s playlist: the ring alternates between them on the synced clock\'s boundaries',
    async run() {
      const h = await handles(S3);
      const ps = need(h, 'PATTERN_SYNC'), T = need(h, 'TIMESTAMP_SYNC').handle;
      const A = solid('Cycle_A', 0), B = solid('Cycle_B', 160);
      const TS = 5.0, FRAME_MS = 1000, INTERVAL = 2000;
      const sc = new Script().connect(CONNECT).subscribe(3.05, ps.ccc).write(3.1, need(h, 'BRIGHTNESS').handle, [255]);
      pushPattern(sc, 3.2, h, A, true);
      pushPattern(sc, 3.2, h, B, true);
      sc.write(TS, T, timestampSync(FRAME_MS)).write(TS + 0.1, need(h, 'PLAYLIST_SYNC').handle, playlistSync(true, INTERVAL, 0));
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 11.6 });
      checkHealthy(run);

      const acks = run.bleOf('notify').filter((n) => n.handle === ps.handle).map((n) => `${n.value[0]}:${n.value.subarray(1)}`);
      check(acks.join(' ') === '0:Cycle_A 0:Cycle_B', `library acks: ${acks.join(' ') || 'none'} (want 0:Cycle_A 0:Cycle_B)`, run);
      check(run.has(`Cycle control: ON, ${INTERVAL} ms`), 'the playlist write was not applied', run);
      const tSync = run.bleOf('written').find((w) => w.handle === T)?.t;
      check(tSync, 'timestamp write never completed', run);

      // index = (synced ms / interval) % 2 with synced = FRAME_MS at tSync: A until synced 2000, then B, A, B.
      const [ca, cb] = [(await expectedRing(A, 255))[0], (await expectedRing(B, 255))[0]];
      const tl = timeline(run, TS + 0.15, 11.6, 2).filter((r) => r.uniform);
      const story = () => `ring after the playlist started:\n${describeTimeline(timeline(run, TS + 0.15, 11.6, 2))}`;
      const which = (c) => (close(c, ca, 2) ? 'A' : close(c, cb, 2) ? 'B' : null);
      const seq = [];
      for (const r of tl) { const w = which(r.uniform); if (w && seq.at(-1)?.w !== w) seq.push({ w, t: r.t0 }); }
      check(seq.map((s) => s.w).join('') === 'ABAB', () => `expected the ring to go A ${fmt(ca)}, B ${fmt(cb)}, A, B; saw ${seq.map((s) => s.w).join('') || 'neither'}\n${story()}`, run);
      for (let i = 1; i <= 3; i++) {
        const synced = INTERVAL * i;                    // the boundary, on the synced clock
        const at = tSync + (synced - FRAME_MS) / 1000;  // when the device's clock gets there
        const got = seq[i].t;
        check(Math.abs(got - at) < 0.15,
          () => `switch ${i} at t=${got.toFixed(3)}, expected t=${at.toFixed(3)} (synced clock ${synced} ms)\n${story()}`, run);
      }
    },
  },

  {
    name: 'blink-calibration',
    what: 'Blink Pins toggles the LED data pin for 10 s and restores the strip; calibration flashes steady and structured-light frames and stops',
    async run() {
      const h = await handles(S3);
      const K = need(h, 'CALIBRATION').handle;
      const shown = solid('EmuShown', 64);
      const sc = new Script().connect(CONNECT).write(3.1, need(h, 'BRIGHTNESS').handle, [255]);
      pushPattern(sc, 3.2, h, shown, false);
      sc.write(4.0, need(h, 'BLINK_PINS').handle, [1]);
      sc.write(14.6, K, [1, 0xff, 40, 2]);    // start, all strips, level 40, mode 2 = steady all-on
      sc.write(15.4, K, [1, 0xff, 40, 1]);    // mode 1 = full structured-light sequence
      sc.write(17.4, K, [0]);                 // stop
      const run = await runEmu({ name: this.name, images: build(S3), ble: true, board: 'atech14', script: sc, seconds: 18.4 });
      checkHealthy(run);
      check(run.has('[Blink] START 1 pin(s)'), 'Blink Pins did not start', run);
      check(run.has('[Blink] END, LED output restored'), 'Blink Pins did not end after its 10 s', run);
      const during = framesIn(run, 4.3, 13.8);
      check(during.length === 0, `the LED driver kept sending frames while the pin was being blinked (${during.length} frames)`, run);
      // 1 s on / 1 s off for 10 s, by GPIO (the RMT output is torn down): the board sees the edges.
      check((run.report.gpioEvents ?? 0) >= 9, `only ${run.report.gpioEvents} GPIO edges on the LED pin during Blink Pins, expected ~10`, run);
      const want = await expectedRing(shown, 255);
      checkRing(run, ringMean(run, 14.1, 14.55, 'after blink'), want, 1.5, 'after Blink Pins the pattern is back', 14.1, 14.55);

      check(run.has(/\[Calib\] START strip=255 bits=6 bright=40 mode=2/) && run.has(/\[Calib\] START strip=255 bits=6 bright=40 mode=1/), 'calibration did not start both modes', run);
      const steady = ringMean(run, 14.9, 15.35, 'calibration steady');
      checkRing(run, steady, Array(RING_LEDS).fill([40, 40, 40]), 1, 'calibration mode 2 (steady all-on at level 40)', 14.9, 15.35);
      // Mode 1: an all-on frame, then frame b lights LED i iff bit b of i. Look for each bit pattern.
      const seen = new Set();
      for (const f of framesIn(run, 15.5, 17.35)) {
        const on = f.leds.map((c) => c.every((v) => v >= 30));
        const off = f.leds.map((c) => c.every((v) => v <= 1));
        if (!on.every((x, i) => x || off[i])) continue;
        const key = on.map((x) => (x ? 1 : 0)).join('');
        for (let b = 0; b < 4; b++) if (key === Array.from({ length: RING_LEDS }, (_, i) => (i >> b) & 1).join('')) seen.add(`bit${b}`);
        if (on.every(Boolean)) seen.add('all');
      }
      check(['all', 'bit0', 'bit1', 'bit2', 'bit3'].every((k) => seen.has(k)),
        () => `structured-light frames seen: ${[...seen].join(', ') || 'none'} (want all, bit0..bit3)\n${describeTimeline(timeline(run, 15.5, 17.35))}`, run);
      check(run.has('[Calib] STOP'), 'calibration did not stop', run);
      checkRing(run, ringMean(run, 17.8, 18.3, 'after calibration'), want, 1.5, 'after calibration stops the pattern is back', 17.8, 18.3);
      check((run.report.rmtTx ?? 0) > 100, `RMT transmitted only ${run.report.rmtTx} frames`, run);
    },
  },

  {
    name: 'c3-boot',
    what: 'ESP32-C3 (single core, RISC-V) boots with BLE, advertises, connects and serves device info',
    async run() {
      const h = await handles(C3, 'c3');
      const I = need(h, 'DEVICE_INFO').handle;
      const sc = new Script('c3').connect(CONNECT).readLong(CONNECT + 0.1, I);
      const run = await runEmu({ name: this.name, chip: 'c3', images: build(C3), ble: true, script: sc, seconds: 5 });
      checkHealthy(run);
      check(run.has('Setup complete') && run.has('Cores: 1'), () => `C3 did not finish setup as a single-core chip\n${run.tail()}`, run);
      const name = bootName(run);
      checkAdvertName(run, adverts(run, 0).slice(0, 1), name, 'C3 boot advertisement');
      const info = json(run, oneRead(run, I, CONNECT), 'C3 device info');
      check(info.chip === 'esp32c3' && info.name === name, () => `C3 device info: ${JSON.stringify(info)}`, run);
    },
  },

  {
    name: 'esp32-boot',
    what: 'classic ESP32 boots through LittleFS, config, LEDs and the renderer to the NimBLE init (esp32sim has no classic BLE controller)',
    async run() {
      const run = await runEmu({ name: this.name, chip: 'esp32', images: build('esp32dev'), seconds: 4,
                                 extra: ['--no-reboot', '--trace-fn', 'btdm_rom_ref_init$'] });
      checkClassicToBleInit(run, 'esp32dev build');
      check(run.fn.some((f) => f.name === 'btdm_rom_ref_init'),
        'the run never reached the BT controller init — whatever stopped it was not the documented emulator gap', run);
    },
  },

  {
    name: 'release-images',
    what: 'the published factory images (gh-pages manifest) boot to the NimBLE init on S3, C3 and ESP32',
    async run() {
      const url = process.env.RELEASE_MANIFEST_URL || 'https://chromabay.app/firmware/esp32/chromabay-manifest.json';
      const manifest = await (await fetchOk(url)).json();
      const dir = path.join(OUT_DIR, 'release', manifest.version);
      fs.mkdirSync(dir, { recursive: true });
      const chips = { 'ESP32': 'esp32', 'ESP32-S3': 's3', 'ESP32-C3': 'c3' };
      const seen = [];
      for (const b of manifest.builds) {
        const chip = chips[b.chipFamily];
        if (!chip) throw new TestFailure(`manifest has a chip family this test does not know: ${b.chipFamily}`);
        const part = b.parts.find((p) => p.offset === 0);
        const file = path.join(dir, `${chip}-factory.bin`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetchOk(part.path)).arrayBuffer()));
        const run = await runEmu({ name: `${this.name}-${chip}`, chip, images: { flashImage: file }, seconds: 4,
                                   extra: chip === 'esp32' ? ['--no-reboot'] : [] });
        check(run.has(`ChromaBay ${manifest.version} starting`), `${b.chipFamily} factory image did not print "ChromaBay ${manifest.version} starting"`, run);
        if (chip === 'esp32') checkClassicToBleInit(run, `${manifest.version} factory image`);
        else {
          // No ELF, so no virtual BLE: the firmware waits in NimBLEDevice::init for a controller.
          checkHealthy(run);
          checkBootToBleInit(run, `${b.chipFamily} ${manifest.version} factory image`);
        }
        seen.push(b.chipFamily);
      }
      check(seen.length === 3, `manifest lists ${seen.join(', ')}; expected ESP32, ESP32-S3 and ESP32-C3`);
    },
  },

  {
    name: 'lane-repack',
    what: 'host unit test of the lane re-packer (esp32/test/lane_repack_test.cpp)',
    async run() {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const exe = path.join(OUT_DIR, 'lane_repack_test');
      const cc = spawnSync(process.env.CXX || 'c++', ['-std=c++17', '-O1', '-Wall', path.join(ROOT, 'esp32/test/lane_repack_test.cpp'), '-o', exe], { encoding: 'utf8' });
      check(cc.status === 0, `lane_repack_test.cpp did not compile:\n${cc.stderr}`);
      const r = spawnSync(exe, { encoding: 'utf8' });
      fs.writeFileSync(path.join(OUT_DIR, 'lane-repack.log'), r.stdout + r.stderr);
      const fails = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
      check(r.status === 0, `lane_repack_test failed (${fails.length} checks):\n${fails.join('\n') || r.stdout.slice(-2000)}`);
    },
  },
];

// ---- Boot-to-NimBLE checks (no BLE controller) ---------------------------------------------

// setup() prints these on the way to NimBLEDevice::init; "Button pin:" is the last line before it.
const PRE_BLE = ['LittleFS formatted and mounted', '[ConfigManager] Default config file created successfully.',
                 'LED strips: 1', 'Pattern renderer initialized', 'Device name: ChromaBay_', 'Button pin:'];

function checkBootToBleInit(run, what) {
  for (const l of PRE_BLE) check(run.has(l, 0), () => `${what}: never printed "${l}" on the way to the NimBLE init\n${run.tail()}`, run);
}

/**
 * The classic ESP32 gets to NimBLEDevice::init and then faults inside the BT controller's ROM
 * init (btdm_rom_ref_init): esp32sim's virtual controller covers S3/C3/C6 only. Everything up to
 * that point must be clean; the fault after it is the emulator gap, written up in the notes.
 */
function checkClassicToBleInit(run, what) {
  checkBootToBleInit(run, what);
  const lines = run.console(0);
  const cut = lines.findIndex((l) => l.startsWith('Button pin:'));
  checkHealthy(run, { lines: lines.slice(0, cut + 1), expectedResets: run.resets.length });
  check(run.resets.length <= 1, `${what}: ${run.resets.length} resets with --no-reboot`, run);
}

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new TestFailure(`GET ${url}: HTTP ${r.status}`);
  return r;
}
