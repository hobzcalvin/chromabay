#!/usr/bin/env node
// Firmware tests in esp32sim. Same runner locally and in CI (.github/workflows/firmware-emu.yml).
//
//   esp32/test/emu/setup-esp32sim.sh                 # once: emulator at the pinned commit
//   (cd esp32 && pio run -e esp32-s3-emu -e esp32-c3-emu -e esp32dev)
//   node esp32/test/emu/run.mjs                      # every scenario
//   node esp32/test/emu/run.mjs selftest roundtrip   # some
//   node esp32/test/emu/run.mjs --list
//
// Logs (the emulator's whole output per run) go to esp32/test/emu/out/. ESP32SIM_DIR points at
// another emulator checkout; EMU_OUT_DIR moves the logs.
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, TestFailure } from './lib/emu.mjs';
import { scenarios } from './scenarios.mjs';

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const s of scenarios) console.log(`${s.name.padEnd(18)} ${s.what}`);
  process.exit(0);
}
const unknown = args.filter((a) => !scenarios.some((s) => s.name === a));
if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(', ')} (see --list)`); process.exit(2); }
const chosen = args.length ? scenarios.filter((s) => args.includes(s.name)) : scenarios;

const red = (s) => `\x1b[31m${s}\x1b[0m`, green = (s) => `\x1b[32m${s}\x1b[0m`;
const results = [];
for (const s of chosen) {
  const t0 = Date.now();
  process.stdout.write(`${s.name.padEnd(18)} `);
  try {
    await s.run();
    results.push({ name: s.name, ok: true, secs: (Date.now() - t0) / 1000 });
    console.log(green('PASS'), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    const secs = (Date.now() - t0) / 1000;
    results.push({ name: s.name, ok: false, secs, message: e.message, log: e.run?.logPath });
    console.log(red('FAIL'), `${secs.toFixed(1)}s`);
    console.log(`  ${s.what}`);
    console.log(e.message.split('\n').map((l) => `  ${l}`).join('\n'));
    if (!(e instanceof TestFailure)) console.log(e.stack);
    if (e.run) console.log(`  log: ${e.run.logPath}\n  --- last console lines ---\n${e.run.tail(25).split('\n').map((l) => `  | ${l}`).join('\n')}`);
  }
}

const failed = results.filter((r) => !r.ok);
const summary = ['| scenario | result | time | what it guards |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : '**FAIL**'} | ${r.secs.toFixed(1)}s | ${scenarios.find((s) => s.name === r.name).what} |`)];
for (const f of failed) summary.push('', `### ${f.name}`, '```', f.message, '```');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), summary.join('\n') + '\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Firmware in esp32sim\n\n${summary.join('\n')}\n`);
console.log(failed.length ? red(`\n${failed.length} of ${results.length} failed`) : green(`\nall ${results.length} passed`));
process.exit(failed.length ? 1 : 0);
