#!/usr/bin/env python3
"""Parametric 3D-printable clamshell case for the ChromaBay controller (CadQuery).

    python3 case/case.py [variant ...]

Variants: external, slim, thick (battery bay under the board). Every variant has the OUT1 push-in
terminal window, so the all-in-one build (cell inside, LEDs pushed into the terminals) never opens.

Writes case/out/<variant>-bottom.stl, <variant>-lid.stl and (with a cell) <variant>-cell.stl.
Built in PCB coordinates (x across, y along with 0 = business end, z up from the board's bottom
face) and mirrored to a right-handed frame on export (y_model = -y_pcb). The FEATURES block must
match tools/gen_pcb.py.
"""
import os
import sys

import cadquery as cq

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

# ---------------------------------------------------------------- board + general
BOARD_W, BOARD_L, PCB_T = 36.0, 68.0, 1.6
ANT_OVERHANG = 5.2      # ESP32-S3-MINI-1 antenna hangs past the board end
COMP_H = 5.6            # tallest part above the PCB without the terminal (JST-PH 5.5 mm)
WALL, FLOOR, ROOF = 1.6, 1.2, 1.2
GAP = 0.3               # board-to-wall clearance
LID_CLEAR = 0.4
CORNER_R = 2.5
CAV_L = BOARD_L + ANT_OVERHANG

VARIANTS = {            # battery bay height under the PCB
    "external": dict(bay=1.0, cell=None),
    "slim": dict(bay=6.6, cell=(34.0, 50.0, 6.0)),     # 603450 pouch, ~1100-1200 mAh
    "thick": dict(bay=10.6, cell=(34.0, 50.0, 10.0)),  # 103450 pouch, ~2000 mAh
}
CELL_Y0 = 10.0          # the business-end strip under the board stays solid (mic channel)

# ---------------------------------------------------------------- FEATURES (from gen_pcb.py)
TOP = PCB_T             # PCB top surface z
END = [  # end-face cutouts: (name, x_centre, z_centre, width, height, corner radius)
    ("button", 3.7, TOP + 0.9, 3.6, 2.2, 0.6),
    ("led", 9.5, TOP + 0.55, 1.8, 1.6, 0.6),
    ("usb", 18.0, TOP + 1.6, 9.6, 3.8, 1.2),
    ("switch", 31.4, TOP + 0.75, 5.2, 1.9, 0.4),
]
MIC_X, MIC_Y = 9.5, 8.6            # bottom-port mic -> channel under the board -> end face
SIDE_NOTCHES = [  # (side, y_centre, width, label): U-notches at the seam, laid-in wires
    ("left", 17.5, 4.4, "BAT"),       # JST-PH battery lead (or wires to the battery pads)
    ("right", 39.5, 6.0, "OUT pads"), # wires soldered to the LED output pads
]
# OUT1 push-in terminals (2x WAGO 2060, 4.5 mm tall): a window in the right wall lines up with the
# four wire entries, and a slot in the lid roof reaches the release buttons. Wiring OUT1 never
# needs the case opened.
WAGO_WINDOW = (9.9, 25.2, 4.8)     # y0, y1, height above the PCB top
WAGO_SLOT = (30.6, 10.2, 34.6, 24.9)  # x0, y0, x1, y1 of the button slot in the lid


def build(name, bay, cell):
    z0 = -(bay + FLOOR)
    z1 = TOP + COMP_H + LID_CLEAR + ROOF
    W, L = BOARD_W + 2 * (GAP + WALL), CAV_L + 2 * (GAP + WALL)
    body = (cq.Workplane("XY").box(W, L, z1 - z0, centered=False)
            .translate((-(GAP + WALL), -(GAP + WALL), z0)).edges("|Z").fillet(CORNER_R))
    cav = (cq.Workplane("XY").box(BOARD_W + 2 * GAP, CAV_L + 2 * GAP, (z1 - ROOF) - (z0 + FLOOR),
                                  centered=False).translate((-GAP, -GAP, z0 + FLOOR))
           .edges("|Z").fillet(0.8))
    body = body.cut(cav)
    # ledge the PCB sits on (1.2 mm rim), and a shelf under the antenna overhang
    rim = (cq.Workplane("XY").box(BOARD_W + 2 * GAP, BOARD_L + 2 * GAP, bay, centered=False)
           .translate((-GAP, -GAP, -bay))
           .cut(cq.Workplane("XY").box(BOARD_W - 2.4, BOARD_L - 2.4, bay + 1, centered=False)
                .translate((1.2, 1.2, -bay - 0.5))))
    body = body.union(rim)
    # business-end strip under the board stays solid; the mic channel is cut through it
    body = body.union(cq.Workplane("XY").box(BOARD_W + 2 * GAP, CELL_Y0 + GAP - 0.5, bay,
                                             centered=False).translate((-GAP, -GAP, -bay)))
    body = body.cut(cq.Workplane("XY").box(1.4, MIC_Y + GAP + WALL + 0.7, 1.0, centered=False)
                    .translate((MIC_X - 0.7, -(GAP + WALL) - 0.1, -1.0)))
    # end-face cutouts (business end): button, LED window, USB-C, power switch
    ey = -(GAP + WALL) - 0.5
    for _, x, z, w, h, r in END:
        c = cq.Workplane("XZ").center(x, z).rect(w, h).extrude(-3).translate((0, ey, 0))
        body = body.cut(c.edges("|Y").fillet(r) if r else c)
    # OUT1 push-in terminals: wire-entry window in the right wall + button slot in the lid roof
    wy0, wy1, wh = WAGO_WINDOW
    body = body.cut(cq.Workplane("XY").box(WALL + 1.0, wy1 - wy0, wh, centered=False)
                    .translate((BOARD_W + GAP - 0.2, wy0, TOP)))
    sx0, sy0, sx1, sy1 = WAGO_SLOT
    body = body.cut(cq.Workplane("XY").box(sx1 - sx0, sy1 - sy0, ROOF + 2, centered=False)
                    .translate((sx0, sy0, z1 - ROOF - 1)).edges("|Z").fillet(0.8))
    # side U-notches at the seam for wires (laid in, not threaded)
    for side, y, w, _ in SIDE_NOTCHES:
        xw = -(GAP + WALL) - 0.5 if side == "left" else BOARD_W + GAP + WALL + 0.5
        n = cq.Workplane("YZ").center(y, TOP + 0.6).rect(w, 4.4).extrude(3 if side == "left" else -3)
        body = body.cut(n.edges("|X").fillet(min(w, 4.4) / 2 - 0.01).translate((xw, 0, 0)))
    # battery lead pass-through from the bay up to the JST-PH (left wall, next to the plug)
    if bay > 1.5:
        body = body.cut(cq.Workplane("XY").box(1.4, 5.0, bay + 1.0, centered=False)
                        .translate((-GAP - 0.3, 20.0, -bay)))
    # zip-tie / strain-relief posts inside each side notch (bottom half, below the seam)
    for side, y, w, _ in SIDE_NOTCHES:
        x = 0.9 if side == "left" else BOARD_W - 0.9
        for dy in (-w / 2 - 1.3, w / 2 + 1.3):
            body = body.union(cq.Workplane("XY").box(1.0, 1.0, 1.4).translate((x, y + dy, TOP + 0.7)))
    # two M2 screw bosses past the antenna end
    for bx in (2.4, BOARD_W - 2.4):
        by = CAV_L - 2.4
        body = body.union(cq.Workplane("XY").circle(1.9).extrude(z1 - ROOF - z0 - FLOOR)
                          .translate((bx, by, z0 + FLOOR)))
        body = body.cut(cq.Workplane("XY").circle(0.8).extrude(z1 - z0 + 2).translate((bx, by, z0 - 1)))

    big = 300
    seam = TOP
    bottom = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                            .translate((0, 0, seam - big)))
    lid = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                         .translate((0, 0, seam)))
    bottom, lid = bottom.mirror("XZ"), lid.mirror("XZ")
    lid = lid.union(cq.Workplane("XY").workplane(offset=z1).center(BOARD_W / 2 - 3, -BOARD_L * 0.62)
                    .transformed(rotate=(0, 0, 180))
                    .text("ChromaBay", 4.0, 0.4, combine=False, halign="center", valign="center"))
    os.makedirs(OUT, exist_ok=True)
    tag = name
    cq.exporters.export(bottom, os.path.join(OUT, f"{tag}-bottom.stl"), tolerance=0.05)
    cq.exporters.export(lid, os.path.join(OUT, f"{tag}-lid.stl"), tolerance=0.05)
    if cell:
        cw, cl, ch = cell
        c = (cq.Workplane("XY").box(cw, cl, ch, centered=False)
             .translate(((BOARD_W - cw) / 2, -CELL_Y0 - cl, -0.4 - ch)).edges("|Y").fillet(1.0))
        cq.exporters.export(c, os.path.join(OUT, f"{name}-cell.stl"), tolerance=0.05)
    print(f"{tag:10} outer {W:.1f} x {L:.1f} x {z1 - z0:.1f} mm")


if __name__ == "__main__":
    for n in sys.argv[1:] or list(VARIANTS):
        build(n, **VARIANTS[n])
