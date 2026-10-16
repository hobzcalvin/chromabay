// Run an async JS body against the app page: node cft-eval.mjs "return page.url()"
// Part of the Chrome-for-Testing BLE harness — see automation/README.md ("Driving the app over
// Web Bluetooth"). Talks to the Chrome started by cft-launch.sh on CDP port 9334.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => /chromabay\.app|localhost:5199/.test(p.url()));
const fn = new Function('page', `return (async () => { ${process.argv[2]} })()`);
console.log(await fn(page));
process.exit(0);
