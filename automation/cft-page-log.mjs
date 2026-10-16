// Append the app console (host-timestamped) to a file until killed: node cft-page-log.mjs <file>
// Part of the Chrome-for-Testing BLE harness — see automation/README.md ("Driving the app over
// Web Bluetooth"). Talks to the Chrome started by cft-launch.sh on CDP port 9334.
import { chromium } from 'playwright';
import { appendFileSync } from 'node:fs';
const out = process.argv[2];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => /chromabay\.app|localhost:5199/.test(p.url()));
page.on('console', m => appendFileSync(out, `${(Date.now()/1000).toFixed(3)} [${m.type()}] ${m.text().replace(/\n/g,' ').slice(0,400)}\n`));
page.on('framenavigated', f => { if (f === page.mainFrame()) appendFileSync(out, `${(Date.now()/1000).toFixed(3)} [nav] ${f.url()}\n`); });
setInterval(() => {}, 1 << 30);
