// Running the firmware in esp32sim and reading what came out. No test logic here: scenarios
// (../scenarios.mjs) script a run, and assert on the Run this returns.
//
// Everything the emulator and the firmware print goes to ONE file descriptor, so the console,
// the [ble] events and the [leds] frames stay in the order they happened.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const SIM_DIR = process.env.ESP32SIM_DIR || path.join(ROOT, 'esp32/test/emu/.esp32sim');
export const OUT_DIR = process.env.EMU_OUT_DIR || path.join(ROOT, 'esp32/test/emu/out');
export const BUILD_DIR = path.join(ROOT, 'esp32/.pio/build');

// The service every ChromaBay advertises (SERVICE_UUID in main.cpp).
export const SERVICE_UUID = 'a0be83e4-8dc9-47f0-ab40-b19721d20ed1';

const CHIPS = {
  s3:    { bin: 'esp32sim',    args: ['--chip', 's3'],    rom: 'esp32s3_rev0_rom.elf', flashMb: 8, resetPoke: 'poke 60008000 80000000' },
  c3:    { bin: 'esp32sim-c3', args: [],                  rom: 'esp32c3_rev3_rom.elf', flashMb: 4, resetPoke: 'poke 60008000 80000000' },
  esp32: { bin: 'esp32sim',    args: ['--chip', 'esp32'], rom: 'esp32_rev300_rom.elf', flashMb: 4, resetPoke: 'poke 3ff48000 80000000' },
};

// Lines the emulator prints itself; everything else is the firmware's console.
const EMU_LINE = /^\[(emu|ble|leds|script|irq|fn|stub)\]/;

export class TestFailure extends Error {
  constructor(message, run) { super(message); this.run = run; }
}

/** Fail with a message unless `cond`. `run` attaches the log to the report. */
export function check(cond, message, run) {
  if (!cond) throw new TestFailure(typeof message === 'function' ? message() : message, run);
}

/** The images of a PlatformIO env, or a failure that says how to build them. */
export function build(env) {
  const dir = path.join(BUILD_DIR, env);
  const files = { bootloader: 'bootloader.bin', ptable: 'partitions.bin', app: 'firmware.bin', elf: 'firmware.elf' };
  const out = {};
  for (const [k, f] of Object.entries(files)) {
    out[k] = path.join(dir, f);
    if (!fs.existsSync(out[k])) throw new TestFailure(`missing ${out[k]} — build it first: cd esp32 && pio run -e ${env}`);
  }
  return out;
}

// ---- Scripts -------------------------------------------------------------------------------

/** An esp32sim --script, in emulated seconds. BLE commands queue and run one at a time. */
export class Script {
  constructor(chip = 's3') { this.chip = chip; this.lines = []; }
  at(t, cmd) { this.lines.push([t, cmd]); return this; }
  connect(t) { return this.at(t, 'ble connect'); }
  discover(t) { return this.at(t, 'ble discover'); }
  read(t, handle) { return this.at(t, `ble read ${hex16(handle)}`); }
  readLong(t, handle) { return this.at(t, `ble read-long ${hex16(handle)}`); }
  subscribe(t, ccc) { return this.at(t, `ble subscribe ${hex16(ccc)}`); }
  write(t, handle, bytes) {
    const b = toBytes(bytes);
    // The virtual link is ATT MTU 23: one write carries at most 20 bytes. Chunk before here.
    if (b.length === 0 || b.length > 20) throw new Error(`BLE write of ${b.length} bytes: must be 1..20 (MTU 23)`);
    return this.at(t, `ble write ${hex16(handle)} ${Buffer.from(b).toString('hex')}`);
  }
  /** A software system reset, as the firmware's own esp_restart() would cause. Flash survives. */
  reboot(t) { return this.at(t, CHIPS[this.chip].resetPoke); }
  text() {
    return this.lines.map((l, i) => [...l, i]).sort((a, b) => a[0] - b[0] || a[2] - b[2])
      .map(([t, c]) => `${t.toFixed(3)} ${c}`).join('\n') + '\n';
  }
}

export function hex16(h) { return '0x' + h.toString(16).padStart(4, '0'); }
export function toBytes(v) {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  return Uint8Array.from(v);
}

// ---- Running -------------------------------------------------------------------------------

/**
 * Run the emulator to completion.
 *   name        scenario name: the log lands in OUT_DIR/<name>.log
 *   chip        's3' | 'c3' | 'esp32'
 *   images      build(env) result, or { flashImage } for a whole-flash dump (no ELF)
 *   ble         virtual BLE controller (needs the ELF)
 *   board       esp32sim board model ('atech14' for the S3 LED ring)
 *   script      a Script
 *   seconds     emulated seconds to run
 *   extra       more CLI args
 */
export async function runEmu({ name, chip = 's3', images, ble = false, board, script, seconds, extra = [] }) {
  const c = CHIPS[chip];
  const exe = path.join(SIM_DIR, 'target/release', c.bin);
  const rom = path.join(SIM_DIR, 'web/wasm/fw', c.rom);
  for (const f of [exe, rom]) {
    if (!fs.existsSync(f)) throw new TestFailure(`missing ${f} — run esp32/test/emu/setup-esp32sim.sh (or set ESP32SIM_DIR)`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = [...c.args, '--boot', 'rom', '--rom', rom, '--flash-mb', String(c.flashMb)];
  if (images.flashImage) args.push('--flash-image', images.flashImage);
  else args.push('--bootloader', images.bootloader, '--ptable', images.ptable, '--app', images.app, '--elf', images.elf);
  if (ble) args.push('--ble');
  if (board) args.push('--board', board);
  if (script && script.lines.length) {
    const sp = path.join(OUT_DIR, `${name}.script.txt`);
    fs.writeFileSync(sp, script.text());
    args.push('--script', sp);
  }
  args.push('--console', 'all', '--max-seconds', String(seconds), '--no-dump', ...extra);

  const logPath = path.join(OUT_DIR, `${name}.log`);
  const fd = fs.openSync(logPath, 'w');
  fs.writeSync(fd, `# ${exe} ${args.join(' ')}\n`);
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ESP32SIM_LED_LOG: '1' } });
    // Emulated time runs well ahead of wall time; this only catches a wedged emulator.
    const wall = setTimeout(() => p.kill('SIGKILL'), Math.max(120, seconds * 20) * 1000);
    p.on('exit', (code, sig) => { clearTimeout(wall); resolve(sig ? `signal ${sig}` : code); });
  });
  fs.closeSync(fd);
  const run = new Run(name, fs.readFileSync(logPath, 'utf8'), logPath, (Date.now() - t0) / 1000);
  check(code === 0, `esp32sim exited with ${code} (see ${logPath})`, run);
  return run;
}

// ---- Reading a run -------------------------------------------------------------------------

export class Run {
  constructor(name, text, logPath, wallSeconds) {
    this.name = name;
    this.logPath = logPath;
    this.wallSeconds = wallSeconds;
    this.lines = text.split('\n');
    this.ble = [];      // { t, kind, ... }
    this.frames = [];   // { t, n, leds: [[r,g,b] x12] } in physical ring order
    this.resets = [];   // { t, cause, line }  chip resets, in order
    this.fn = [];       // { t, name } --trace-fn calls
    this.boots = [[]];  // console lines, one array per boot
    this.report = {};   // from the exit report
    this.stopped = false;
    for (const line of this.lines) this.#parse(line);
  }

  #parse(line) {
    let m;
    if ((m = line.match(/^\[leds\] t=([\d.]+) n=(\d+) (\[.*\])$/))) {
      this.frames.push({ t: +m[1], n: +m[2], leds: JSON.parse(m[3]) });
    } else if ((m = line.match(/^\[ble\] t=([\d.]+)s (.*)$/))) {
      this.ble.push(parseBle(+m[1], m[2]));
    } else if ((m = line.match(/^\[emu\] chip reset at t=([\d.]+)s: cause (0x[0-9a-f]+) \((\w+)\)/))) {
      this.resets.push({ t: +m[1], cause: m[3], line });
      this.boots.push([]);
    } else if ((m = line.match(/^\[fn\] i=\d+ t=([\d.]+)s c\d+ (\w+)\(/))) {
      this.fn.push({ t: +m[1], name: m[2] });
    } else if ((m = line.match(/^\[emu\] ring: (\d+) updates/))) {
      this.report.ringUpdates = +m[1];
    } else if (line.startsWith('[emu]') && (m = line.match(/gpio events (\d+)/))) {
      this.report.gpioEvents = +m[1];
    } else if ((m = line.match(/^\[emu\] rmt tx (\d+)/))) {
      this.report.rmtTx = +m[1];
    } else if ((m = line.match(/^\[ble\] (\d+) command\(s\) still pending/))) {
      this.report.blePending = +m[1];
    } else if (line.startsWith('[emu] stop:')) {
      this.stopped = true; // the exit report follows; none of it is the firmware's console
    } else if (!this.stopped && !EMU_LINE.test(line) && !line.startsWith('# ')) {
      this.boots[this.boots.length - 1].push(line);
    }
  }

  /** Console lines, all boots or one. */
  console(boot) { return boot === undefined ? this.boots.flat() : (this.boots[boot] || []); }
  has(text, boot) { return this.console(boot).some((l) => (text instanceof RegExp ? text.test(l) : l.includes(text))); }
  find(re, boot) { for (const l of this.console(boot)) { const m = l.match(re); if (m) return m; } return null; }
  bleOf(kind) { return this.ble.filter((e) => e.kind === kind); }

  /** The last n console lines, for a failure report. */
  tail(n = 40) { return this.console().slice(-n).join('\n'); }
}

function parseBle(t, rest) {
  let m;
  if ((m = rest.match(/^advertising (.*) data=([0-9a-f]*)$/))) {
    return { t, kind: 'advert', services: [...m[1].matchAll(/service=([0-9a-f-]+)/g)].map((x) => x[1]),
             names: [...m[1].matchAll(/name="((?:[^"\\]|\\.)*)"/g)].map((x) => unRust(x[1])), data: m[2] };
  }
  if ((m = rest.match(/^read handle=0x([0-9a-f]+) value=([0-9a-f]*) /))) return { t, kind: 'read', handle: parseInt(m[1], 16), value: Buffer.from(m[2], 'hex') };
  if ((m = rest.match(/^notification handle=0x([0-9a-f]+) value=([0-9a-f]*) /))) return { t, kind: 'notify', handle: parseInt(m[1], 16), value: Buffer.from(m[2], 'hex') };
  if ((m = rest.match(/^write complete handle=0x([0-9a-f]+)/))) return { t, kind: 'written', handle: parseInt(m[1], 16) };
  if ((m = rest.match(/^characteristic declaration=0x([0-9a-f]+) handle=0x([0-9a-f]+) properties=0x([0-9a-f]+) uuid=([0-9a-f-]+)/))) {
    return { t, kind: 'char', decl: parseInt(m[1], 16), handle: parseInt(m[2], 16), props: parseInt(m[3], 16), uuid: m[4] };
  }
  if ((m = rest.match(/^attribute handle=0x([0-9a-f]+) uuid=([0-9a-f-]+)/))) return { t, kind: 'attr', handle: parseInt(m[1], 16), uuid: m[2] };
  if ((m = rest.match(/^service start=0x([0-9a-f]+) end=0x([0-9a-f]+) uuid=([0-9a-f-]+)/))) {
    return { t, kind: 'service', start: parseInt(m[1], 16), end: parseInt(m[2], 16), uuid: m[3] };
  }
  if (rest.startsWith('connected')) return { t, kind: 'connected' };
  if (rest.startsWith('disconnected')) return { t, kind: 'disconnected' };
  if (rest.startsWith('discovery complete')) return { t, kind: 'discovered' };
  if (rest.startsWith('ATT error')) return { t, kind: 'att-error', text: rest };
  return { t, kind: 'other', text: rest };
}

/** Undo Rust's {:?} string escaping (the emulator prints names that way). */
function unRust(s) {
  return s.replace(/\\u\{([0-9a-f]+)\}|\\(.)/g, (_, u, c) => {
    if (u) return String.fromCodePoint(parseInt(u, 16));
    return { 0: '\0', n: '\n', r: '\r', t: '\t' }[c] ?? c;
  });
}

// ---- Fatal output --------------------------------------------------------------------------

const FATAL = [
  /Guru Meditation/, /panic'ed/, /abort\(\) was called/, /assert failed:/, /Backtrace:/,
  /Task watchdog got triggered/, /task_wdt:/, /CORRUPT HEAP/, /Stack canary watchpoint/,
  /stack overflow/i, /Brownout detector/, /rst:0x[0-9a-f]+ \((?:TG0WDT|TG1WDT|RTCWDT|RTC_WDT|INT_WDT|TASK_WDT|SW_CPU|RTC_SW_CPU|SUPER_WDT)/,
];

/**
 * No crash, watchdog or unexplained reset on the console; every scripted BLE command ran.
 *   lines           console lines to scan (default: the whole run)
 *   expectedResets  chip resets the scenario caused itself
 */
export function checkHealthy(run, { lines, expectedResets = 0 } = {}) {
  for (const l of lines ?? run.console()) {
    const bad = FATAL.find((re) => re.test(l));
    check(!bad, () => `firmware crashed or reset: "${l.trim()}"\n--- last console lines ---\n${context(run, l)}`, run);
  }
  check(run.resets.length === expectedResets,
    () => `expected ${expectedResets} chip reset(s), saw ${run.resets.length}: ${run.resets.map((r) => `t=${r.t} ${r.cause}`).join(', ') || 'none'}`, run);
  check(!run.report.blePending, () => `${run.report.blePending} scripted BLE command(s) never ran (no connection? link lost?)`, run);
  const errors = run.bleOf('att-error');
  check(errors.length === 0, () => `ATT error(s) from the device: ${errors.map((e) => `t=${e.t} ${e.text}`).join('; ')}`, run);
}

function context(run, line) {
  const all = run.console();
  const i = all.indexOf(line);
  return all.slice(Math.max(0, i - 25), i + 15).join('\n');
}
