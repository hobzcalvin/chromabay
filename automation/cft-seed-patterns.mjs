// Load a saved patterns JSON into the app localStorage: node cft-seed-patterns.mjs <file>
// Part of the Chrome-for-Testing BLE harness — see automation/README.md ("Driving the app over
// Web Bluetooth"). Talks to the Chrome started by cft-launch.sh on CDP port 9334.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const pats = readFileSync(process.argv[2], 'utf8').trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => /chromabay\.app|localhost:5199/.test(p.url()));
if (!page.url().includes('localhost:5199')) { await page.goto('http://localhost:5199/devices'); await page.waitForTimeout(2000); }
await page.evaluate((v) => { localStorage.setItem('patterns', v); localStorage.setItem('chromabay:onboarded:1', '1'); }, pats);
await page.reload(); await page.waitForTimeout(4000);
console.log(page.url(), await page.evaluate(() => JSON.parse(localStorage.getItem('patterns')).length));
process.exit(0);
