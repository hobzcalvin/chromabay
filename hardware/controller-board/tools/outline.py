"""Board outline shared by gen_pcb.py (Edge.Cuts) and case/case.py (case shell).

Board frame: x across (0..W), y along the board (0 = business end, H = antenna end), mm.

* Business end: a "very round" nose. Each corner is a quarter ellipse that starts right where
  the controls (button, LED, USB-C, switch) end and runs NOSE_RY down the long side.
* Left side: a notch the JST-PH battery plug sits in, so the plug never collides with the case
  wall and the battery lead drops straight down through the notch to a cell under the board.
* Antenna end: plain 1.5 mm corners (the ESP32 antenna overhangs this edge).
"""
import math

W, H = 36.0, 66.0
NOSE_RX = 2.6          # = where the business-end controls start/stop, minus edge clearance
NOSE_RY = 12.0
FAR_R = 1.5
NOTCH = (0.0, 15.6, 6.6, 25.4)   # x0, y0, x1, y1: JST-PH plug + battery lead pocket


def _ellipse(cx, cy, rx, ry, a0, a1, n=24):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def points(notch=True, far_extend=0.0):
    """Closed outline, clockwise in board coords (y down). far_extend lengthens the far end (case)."""
    Hf = H + far_extend
    pts = []
    pts += _ellipse(NOSE_RX, NOSE_RY, NOSE_RX, NOSE_RY, 180, 270)            # top-left nose
    pts += _ellipse(W - NOSE_RX, NOSE_RY, NOSE_RX, NOSE_RY, 270, 360)        # top-right nose
    pts += _ellipse(W - FAR_R, Hf - FAR_R, FAR_R, FAR_R, 0, 90, 8)           # bottom-right
    pts += _ellipse(FAR_R, Hf - FAR_R, FAR_R, FAR_R, 90, 180, 8)             # bottom-left
    if notch:
        x0, y0, x1, y1 = NOTCH
        pts += [(0.0, y1), (x1, y1), (x1, y0), (0.0, y0)]
    out = []
    for p in pts:  # drop duplicates
        if not out or math.dist(out[-1], p) > 1e-6:
            out.append((round(p[0], 4), round(p[1], 4)))
    if math.dist(out[0], out[-1]) < 1e-6:
        out.pop()
    return out


def inside(x, y):
    """Point-in-board test (even-odd)."""
    pts = points()
    c = False
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c
