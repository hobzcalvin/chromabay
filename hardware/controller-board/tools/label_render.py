#!/usr/bin/python3
"""Top-view render with every part labelled -> renders/board-top-labeled.png

    /usr/bin/python3 tools/label_render.py      (KiCad's python; needs kicad-cli, node + playwright)

Only what you touch or connect gets a callout: controls, every connector pad, every user pad,
and the solder jumpers (purple). Also writes renders/interaction-points.json for the 3D viewer.
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

# Things you touch or connect to. (ref, pad number or None for the part centre, label)
PARTS = [("J1", None, "USB-C: charge + data"), ("SW1", None, "Power switch"),
         ("SW2", None, "Button"), ("D1", None, "LED: red = charging, green = status"),
         ("MK1", None, "Mic (sound port)")]
PAD_LABELS = {
    ("J4", "2"): "Battery JST-PH +", ("J4", "1"): "Battery JST-PH -",
    ("J3", "1"): "Battery pad +", ("J3", "2"): "Battery pad -", ("J3", "3"): "Battery NTC (pack thermistor)",
    ("J2", "2"): "OUT1 push-in G", ("J2", "1"): "OUT1 push-in V (5 V)",
    ("J6", "2"): "OUT1 push-in C (clock)", ("J6", "1"): "OUT1 push-in D (data)",
}
J5 = ["G", "V (5 V)", "C1", "D1", "C2", "D2", "C3", "D3", "C4", "D4"]
TP_TEXT = {"3V3": "3.3 V out", "GND": "GND", "SDA": "I2C SDA", "SCL": "I2C SCL", "T1": "Touch/IO T1",
           "T2": "Touch/IO T2", "T3": "Touch/IO T3", "T4": "Touch/IO T4",
           "BOOT": "BOOT (GND at power-on = flash mode)", "MIC_BCLK": "Ext mic BCLK",
           "MIC_WS": "Ext mic WS", "MIC_SD": "Ext mic SD", "EXTSW_A": "Ext power switch A",
           "EXTSW_B": "Ext power switch B", "IO45": "IO45 (strap: keep low at boot)",
           "IO46": "IO46 (strap: keep low at boot)", "IO3": "IO3 (strap)", "IO43": "IO43 (UART TX)",
           "IO44": "IO44 (UART RX)"}
JUMPERS = {"JP1": "Bridge: charge +0.45 A", "JP2": "Bridge: charge +1.0 A",
           "JP3": "NTC: onboard / pack", "JP4": "Cut: use ext power switch",
           "JP5": "Cut: ext LED supply", "JP7": "Cut: disable mic"}


def interaction_points(board, ox=100.0, oy=100.0):
    pts = []
    fps = {fp.GetReference(): fp for fp in board.GetFootprints()}
    mm = lambda v: (pcbnew.ToMM(v.x) - ox, pcbnew.ToMM(v.y) - oy)
    for ref, _, label in PARTS:
        pts.append(dict(ref=ref, label=label, kind="part", xy=mm(fps[ref].GetPosition())))
    for ref, fp in fps.items():
        for pad in fp.Pads():
            n = pad.GetNumber()
            label = PAD_LABELS.get((ref, n))
            if ref == "J5" and n.isdigit():
                label = "LED pad " + J5[int(n) - 1]
            if ref.startswith("TP"):
                label = TP_TEXT.get(fp.GetValue(), fp.GetValue())
            if ref in JUMPERS and n == "1":
                label = JUMPERS[ref]
            if not label:
                continue
            x, y = mm(pad.GetPosition())
            if any(p["label"] == label for p in pts):   # 2-pad parts (WAGO): keep the edge-side pad
                old = next(p for p in pts if p["label"] == label)
                if x > old["xy"][0]:
                    old["xy"] = (x, y)
                continue
            kind = "config" if ref in JUMPERS else "pad"
            if ref in JUMPERS:
                x, y = mm(fp.GetPosition())
            pts.append(dict(ref=ref, label=label, kind=kind, xy=(x, y)))
    return pts


def main():
    pcb = os.path.join(BOARD, "chromabay-controller.kicad_pcb")
    board = pcbnew.LoadBoard(pcb)
    ox, oy = 100.0, 100.0
    W, H = 36.0, 68.0
    pts = interaction_points(board, ox, oy)
    json.dump(pts, open(os.path.join(BOARD, "renders", "interaction-points.json"), "w"), indent=1)
    items = [dict(ref=p["ref"], x=p["xy"][0], y=p["xy"][1], name=p["label"], kind=p["kind"]) for p in pts]
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
for (const it of []) {
  const [x, y] = P(it.x, it.y);
  el('text', {x, y: y + 4, 'font-size': 11, 'text-anchor': 'middle', fill: '#fff', stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', 'font-weight': 700}, it.ref);
}
// callouts: left half -> left margin, right half -> right margin, sorted by y, spread evenly
const named = D.items.filter(i => i.name);
const sides = {L: named.filter(i => i.x < 18).sort((a, b) => a.y - b.y), R: named.filter(i => i.x >= 18).sort((a, b) => a.y - b.y)};
for (const side of ['L', 'R']) {
  const list = sides[side]; const n = list.length;
  // slots as close to each part's own height as possible, at least GAP apart
  const GAP = 30, slots = []; let last = -1e9;
  list.forEach(it => { const y = Math.max(P(it.x, it.y)[1], last + GAP); slots.push(y); last = y; });
  const over = last - (PADT + D.h - 10); if (over > 0) { for (let k = slots.length - 1, lim = PADT + D.h - 10; k >= 0; k--, lim -= GAP) slots[k] = Math.min(slots[k], lim); }
  list.forEach((it, k) => {
    const [px, py] = P(it.x, it.y);
    const ly = slots[k];
    const lx = side === 'L' ? PADL - 20 : PADL + D.w + 20;
    const col = it.kind === 'config' ? '#7a5af5' : it.kind === 'part' ? '#0b7a75' : '#c0392b';
    el('polyline', {points: `${px},${py} ${side === 'L' ? PADL + D.x0 - 14 : PADL + D.x0 + 36 * D.s + 14},${ly} ${lx},${ly}`, fill: 'none', stroke: col, 'stroke-width': 1.3, opacity: 0.85});
    el('circle', {cx: px, cy: py, r: 5, fill: col, stroke: '#fff', 'stroke-width': 1.5});
    el('text', {x: side === 'L' ? lx - 8 : lx + 8, y: ly + 6, 'font-size': 17, 'text-anchor': side === 'L' ? 'end' : 'start', fill: '#222'}, it.name);
  });
}
el('text', {x: W / 2, y: 36, 'font-size': 26, 'text-anchor': 'middle', 'font-weight': 700, fill: '#222'}, 'ChromaBay Controller rev A - what you touch and connect (business end up)');
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
