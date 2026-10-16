// Connect the app to ONE device by exact name, auto-answering the Web Bluetooth chooser.
// Part of the Chrome-for-Testing BLE harness — see automation/README.md ("Driving the app over
// Web Bluetooth"). Talks to the Chrome started by cft-launch.sh on CDP port 9334.
import { chromium } from 'playwright';
const TARGET = process.env.DEVICE_NAME;
if (!TARGET) { console.error('DEVICE_NAME=<exact name from the USB boot banner> is required'); process.exit(2); }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => /chromabay\.app|localhost:5199/.test(p.url())) || ctx.pages()[0];
page.on('console', m => { const t = m.text(); if (/brightness|LED Config|LibDump|deviceLibrary|Pattern|error/i.test(t)) console.log(`${(Date.now()/1000).toFixed(3)} [page] ${t.slice(0,200)}`); });
const cdp = await ctx.newCDPSession(page);
await cdp.send('DeviceAccess.enable');
let done;
const picked = new Promise(r => (done = r));
cdp.on('DeviceAccess.deviceRequestPrompted', async ({ id, devices }) => {
  const names = devices.map(d => d.name);
  console.log('chooser offers:', JSON.stringify(names), '— selecting only', TARGET);
  const d = devices.find(d => (d.name || '').trim() === TARGET);
  if (d) { await cdp.send('DeviceAccess.selectPrompt', { id, deviceId: d.id }); console.log('selected', TARGET); done(true); }
});
await page.bringToFront();
// A fresh profile shows the onboarding overlay, which swallows clicks.
const skip = page.locator('.ob-backdrop button', { hasText: 'Skip' });
if (await skip.count()) await skip.click();
console.log('url', page.url());
await page.getByRole('button', { name: /Select ESP32 Device/i }).click();
const ok = await Promise.race([picked, new Promise(r => setTimeout(() => r(false), 45000))]);
console.log('picked?', ok);
await page.waitForTimeout(8000);
console.log((await page.locator('body').innerText()).slice(0, 1200));
process.exit(0);
