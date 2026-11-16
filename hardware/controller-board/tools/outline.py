"""Board outline shared by gen_pcb.py (Edge.Cuts) and case/case.py (case shell).

Board frame: x across (0..W), y along the board (0 = business end, H = antenna end), mm.

* Business end: a "very round" nose. Each corner is a quarter ellipse that starts right where
  the controls (button, USB-C, switch) end and runs NOSE_RY down the long side. The straight
  middle of the end is a TAB-deep tab that runs out through the case end wall, so the board edge is
  flush with the case's outer face and the button and switch reach past it with no printed parts.
* Left side: a notch the JST-PH battery plug sits in, so the plug never collides with the case
  wall and the battery lead drops straight down through the notch to a cell under the board.
* Antenna end: plain 1.5 mm corners (the ESP32 antenna overhangs this edge).
"""
import math

W, H = 36.0, 66.0
NOSE_RX = 5.0          # rounding starts 5 mm in from each side (button..switch span x 5.2..30.8)
NOSE_RY = 15.0
TAB = 1.9              # = case GAP + WALL: the end tab passes through the case end wall
FAR_R = 1.5
NOTCH = (0.0, 16.8, 5.0, 24.8)   # x0, y0, x1, y1: JST-PH plug + battery lead pocket (8 x 5 mm)


def _ellipse(cx, cy, rx, ry, a0, a1, n=24):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def points(notch=True, far_extend=0.0, tab=True):
    """Closed outline, clockwise in board coords (y down). far_extend lengthens the far end (case).
    tab=False leaves out the end tab: that is the shape the case shell is offset from."""
    Hf = H + far_extend
    cy = NOSE_RY + TAB
    pts = []
    pts += _ellipse(NOSE_RX, cy, NOSE_RX, NOSE_RY, 180, 270)                 # top-left nose
    if tab:
        pts += [(NOSE_RX, 0.0), (W - NOSE_RX, 0.0)]
    pts += _ellipse(W - NOSE_RX, cy, NOSE_RX, NOSE_RY, 270, 360)             # top-right nose
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


def inside(x, y, pts=None):
    """Point-in-board test (even-odd)."""
    pts = pts or _BOARD
    c = False
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


_BOARD = points()
