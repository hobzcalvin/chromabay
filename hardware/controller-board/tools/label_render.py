#!/usr/bin/python3
"""Top-view render with every part labelled -> renders/board-top-labeled.png

    /usr/bin/python3 tools/label_render.py      (KiCad's python; needs kicad-cli, node + playwright)

Functional parts get callouts in the margins; every passive gets its reference on top of it.
"""
import json
import os
import subprocess
import sys
import tempfile

import pcbnew
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import design  # noqa: E402

NAMES = {
    "J1": "USB-C (charge + data)", "SW1": "Power slide switch", "SW2": "User button",
    "D1": "Charge (red) / status (green) LED", "MK1": "PDM microphone (port hole)",
    "J4": "JST-PH battery (swappable)", "J3": "Battery wire pads + - NTC",
    "J2": "LED OUT 1: G V C D (lever terminal opt.)", "J5": "LED OUT 2-4 pads (G V C2 D2..D4)",
    "U2": "BQ25606 charger / power path", "L1": "Charger inductor 1 uH",
    "U3": "TPS61088 5 V boost", "L2": "Boost inductor 1 uH", "Q1": "Battery reverse-polarity FET",
    "Q2": "LED power switch (P-FET)", "Q3": "LED switch driver", "F1": "3 A resettable fuse",
    "U7": "74AHCT245 level shifter", "U8": "USB ESD", "U9": "Output ESD 1-2",
    "U10": "Output ESD 3-4", "U4": "MAX17048 fuel gauge", "U5": "LSM6DS3 IMU (accel+gyro)",
    "U6": "3.3 V LDO", "U1": "ESP32-S3-MINI-1 (antenna overhangs)", "Q4": "Status LED driver",
    "TH1": "Battery NTC", "JP1": "Charge +0.45 A", "JP2": "Charge +1.0 A", "JP3": "NTC select",
    "JP4": "Ext. switch (cut)", "JP5": "Ext. LED power (cut)", "JP7": "Mic enable (cut)",
}


def main():
    pcb = os.path.join(BOARD, "chromabay-controller.kicad_pcb")
    board = pcbnew.LoadBoard(pcb)
    ox, oy = 100.0, 100.0
    W, H = 36.0, 68.0
    items = []
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        pos = fp.GetPosition()
        items.append(dict(ref=ref, x=pcbnew.ToMM(pos.x) - ox, y=pcbnew.ToMM(pos.y) - oy,
                          name=NAMES.get(ref), tp=ref.startswith("TP")))
    tmp = tempfile.mkdtemp()
    png = os.path.join(tmp, "top.png")
    subprocess.run(["kicad-cli", "pcb", "render", "-o", png, "--side", "top", "--width", "1400",
                    "--height", "2400", "--quality", "high", "--background", "transparent",
                    "--zoom", "1.0", pcb], check=True, capture_output=True)
    im = Image.open(png).convert("RGBA")
    px = im.load()
    alpha = lambda xx, yy: px[xx, yy][3] > 128
    # board width (x) sets the scale; no part overhangs the long sides
    xs = [xx for xx in range(im.width) if any(alpha(xx, yy) for yy in range(im.height // 3, im.height // 3 + 40))]
    x0, x1 = min(xs), max(xs)
    s = (x1 - x0) / W
    # y origin: top board edge at x = 12.5 mm (between the LED and USB-C, nothing overhangs there)
    cx = int(x0 + 12.5 * s)
    y0 = next(yy for yy in range(im.height) if alpha(cx, yy))
    data = dict(img=png, s=s, x0=x0, y0=y0, w=im.width, h=im.height, items=items)
    html = os.path.join(tmp, "label.html")
    open(html, "w").write(PAGE.replace("__DATA__", json.dumps(data)))
    out = os.path.join(BOARD, "renders", "board-top-labeled.png")
    js = os.path.join(tmp, "shot.js")
    open(js, "w").write(SHOT)
    subprocess.run(["node", js, html, out], check=True, cwd=tmp)
    print("wrote", out)


PAGE = r"""<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Helvetica,Arial,sans-serif">
<div id="w" style="position:relative"></div>
<script>
const D = __DATA__;
const PADL = 560, PADR = 560, PADT = 60;
const W = D.w + PADL + PADR, H = D.h + PADT + 40;
const w = document.getElementById('w'); w.style.width = W + 'px'; w.style.height = H + 'px';
const ns = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', W); svg.setAttribute('height', H);
svg.style.position = 'absolute';
const img = document.createElementNS(ns, 'image'); img.setAttribute('href', 'file://' + D.img);
img.setAttribute('x', PADL); img.setAttribute('y', PADT); img.setAttribute('width', D.w); img.setAttribute('height', D.h);
svg.appendChild(img); w.appendChild(svg);
const P = (x, y) => [PADL + D.x0 + x * D.s, PADT + D.y0 + y * D.s];
function el(tag, a, txt) { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); if (txt) e.textContent = txt; svg.appendChild(e); return e; }
// small refs on every passive / pad
for (const it of D.items) {
  if (it.name) continue;
  const [x, y] = P(it.x, it.y);
  el('text', {x, y: y + 4, 'font-size': 11, 'text-anchor': 'middle', fill: '#fff', stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', 'font-weight': 700}, it.ref);
}
// callouts: left half -> left margin, right half -> right margin, sorted by y, spread evenly
const named = D.items.filter(i => i.name);
const sides = {L: named.filter(i => i.x < 16).sort((a, b) => a.y - b.y), R: named.filter(i => i.x >= 16).sort((a, b) => a.y - b.y)};
for (const side of ['L', 'R']) {
  const list = sides[side]; const n = list.length;
  // slots as close to each part's own height as possible, at least GAP apart
  const GAP = 44, slots = []; let last = -1e9;
  list.forEach(it => { const y = Math.max(P(it.x, it.y)[1], last + GAP); slots.push(y); last = y; });
  const over = last - (PADT + D.h - 10); if (over > 0) { for (let k = slots.length - 1, lim = PADT + D.h - 10; k >= 0; k--, lim -= GAP) slots[k] = Math.min(slots[k], lim); }
  list.forEach((it, k) => {
    const [px, py] = P(it.x, it.y);
    const ly = slots[k];
    const lx = side === 'L' ? PADL - 20 : PADL + D.w + 20;
    el('polyline', {points: `${px},${py} ${side === 'L' ? PADL + D.x0 - 14 : PADL + D.x0 + 32 * D.s + 14},${ly} ${lx},${ly}`, fill: 'none', stroke: '#c0392b', 'stroke-width': 1.6});
    el('circle', {cx: px, cy: py, r: 4, fill: '#c0392b'});
    el('text', {x: side === 'L' ? lx - 8 : lx + 8, y: ly + 6, 'font-size': 19, 'text-anchor': side === 'L' ? 'end' : 'start', fill: '#222'}, `${it.ref}  ${it.name}`);
  });
}
el('text', {x: W / 2, y: 36, 'font-size': 26, 'text-anchor': 'middle', 'font-weight': 700, fill: '#222'}, 'ChromaBay Controller rev A - top (business end up)');
document.title = 'done';
</script></body></html>"""

SHOT = r"""const { chromium } = require('playwright');
(async () => { const [,, html, out] = process.argv;
  const b = await chromium.launch({args: ['--allow-file-access-from-files']});
  const p = await b.newPage({viewport: {width: 2600, height: 2600}});
  await p.goto('file://' + html); await p.waitForFunction(() => document.title === 'done');
  await p.waitForTimeout(500);
  const box = await p.evaluate(() => { const w = document.getElementById('w'); return [w.offsetWidth, w.offsetHeight]; });
  await p.setViewportSize({width: box[0], height: box[1]});
  await p.screenshot({path: out}); await b.close(); })();"""

if __name__ == "__main__":
    main()
