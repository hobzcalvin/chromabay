// Simulated brightness drag: node cft-bri-drag.mjs <from> <to> <logfile>
// Part of the Chrome-for-Testing BLE harness — see automation/README.md ("Driving the app over
// Web Bluetooth"). Talks to the Chrome started by cft-launch.sh on CDP port 9334.
// Simulate a slider drag: set the range input + fire 'input' every 50 ms, logging host time.
import { chromium } from 'playwright';
import { appendFileSync } from 'node:fs';
const [from, to, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => /chromabay\.app|localhost:5199/.test(p.url()));
const steps = 20;
for (let i = 0; i <= steps; i++) {
  const v = Math.round(from + (to - from) * i / steps);
  await page.locator('input[type=range]').first().evaluate((e, v) => {
    e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  appendFileSync(out, `${(Date.now()/1000).toFixed(3)} [drag] ${v}\n`);
  await page.waitForTimeout(50);
}
await page.locator('input[type=range]').first().evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true })));
process.exit(0);
