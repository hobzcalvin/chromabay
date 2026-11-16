#!/usr/bin/env python3
"""Parametric 3D-printable clamshell case for the ChromaBay controller (CadQuery).

    python3 case/case.py [variant ...]   variants: external, slim, thick, 18650, brick (default: all)

The shell follows the board outline (tools/outline.py): the rounded business-end nose and the
battery notch. Variants differ in the battery bay under the board:
  external  no cell inside; battery leads leave through the left-side notch
  slim      603450 pouch (~1.1 Ah) under the board
  thick     103450 pouch (~2 Ah) under the board
Every variant has the OUT1 push-in window (wires go in from outside) and the button/USB/switch/LED/
mic openings on the business end. The board's end tab is flush with the case face, so the button
and switch stick out past it with no extra parts.

Writes case/out/<variant>-bottom.stl, <variant>-lid.stl and <variant>-cell.stl (placeholder cell).
Built in board coordinates (x across, y along with 0 = business end, z up from the board's
underside) and mirrored to a right-handed frame on export (y_model = -y_board).
"""
import os
import sys

import cadquery as cq

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
import outline  # noqa: E402

OUT = os.path.join(HERE, "out")

# ---------------------------------------------------------------- general
PCB_T = 1.6
ANT_OVERHANG = 5.2      # ESP32-S3-MINI-1 antenna hangs past the far edge
COMP_H = 5.6            # tallest part above the PCB (JST-PH, 5.5 mm)
WALL, FLOOR, ROOF = 1.6, 1.2, 1.2
GAP = 0.3               # board-to-wall clearance
LID_CLEAR = 0.4
TOP = PCB_T

CYL_D, CYL_L, PCM_T = 18.6, 65.0, 3.0   # 18650 cell, and the protection board at its nose end
VARIANTS = {
    "external": dict(bay=1.0, cell=None),
    "slim": dict(bay=6.6, cell=(34.0, 46.0, 6.0)),     # 603450-class pouch, ~1.1 Ah
    "thick": dict(bay=10.6, cell=(34.0, 46.0, 10.0)),  # 103450-class pouch, ~2 Ah
    # 18650 cells lie lengthwise, centred, under the board, with the same outline as every other
    # variant. Two side by side would need ~68 mm of full 37 mm width, but the tapered nose leaves
    # only ~58 mm, so the 2-cell pack is stacked instead.
    "18650": dict(bay=CYL_D + 2.2, cell=None, cyl=1),          # 1 cell, ~3.4 Ah
    "brick": dict(bay=2 * CYL_D + 2.4, cell=None, cyl=2),      # 2 cells stacked (1S2P), ~6.8 Ah
}
CELL_Y0 = 11.0          # the strip under the nose stays solid (mic channel)

# ---------------------------------------------------------------- features (match gen_pcb.py)
# The board's end tab runs through the end wall, so the board edge is flush with the case face.
# The button and switch overhang the board edge and stick out past the case on their own.
END = [  # business-end openings in the lid wall: (name, x_centre, z_centre, width, height, corner radius)
    ("button", 8.67, TOP + 0.95, 5.2, 2.1, 0.4),   # button body + plunger
    ("usb", 17.1, TOP + 1.6, 9.6, 3.8, 1.2),
    ("led", 22.3, TOP + 0.6, 1.4, 1.2, 0.3),       # light slot beside the USB-C; the LED sits behind it
    ("switch", 26.48, TOP + 0.85, 7.0, 1.9, 0.4),  # switch body + handle travel
]
MIC_X, MIC_Y = 9.0, 6.7           # bottom-port mic -> channel under the board -> end face
SIDE_NOTCHES = [  # (side, y_centre, width): U-notches at the seam for laid-in wires
    ("left", 20.8, 4.0),          # battery lead, external-battery builds (two <=1.5 mm OD wires side by side)
]
# One opening in the right wall covers the OUT1 push-in entries and all ten LED wire pads.
WAGO_WINDOW = (11.6, 53.0, 4.8)   # y0, y1, height above the PCB top
WAGO_SLOT = (26.6, 12.0, 30.0, 27.5)  # lid slot over the WAGO release buttons (x 27.2..29.4 on the board)


def prism(pts, z0, z1, offset=0.0):
    wp = cq.Workplane("XY").workplane(offset=z0).polyline(pts).close()
    if offset:
        wp = wp.offset2D(offset, "arc")
    return wp.extrude(z1 - z0)


def build(name, bay, cell, cyl=0):
    z0 = -(bay + FLOOR)
    z1 = TOP + COMP_H + LID_CLEAR + ROOF
    case_pts = outline.points(notch=False, far_extend=ANT_OVERHANG, tab=False)
    body = prism(case_pts, z0, z1, GAP + WALL)
    body = body.cut(prism(case_pts, z0 + FLOOR, z1 - ROOF, GAP))
    # 1.2 mm ledge the board rests on, open under the battery notch so the lead can drop through
    board_pts = outline.points(notch=False, tab=False)
    ledge = prism(board_pts, -bay, 0, GAP).cut(prism(board_pts, -bay - 1, 1, -1.2))
    nx0, ny0, nx1, ny1 = outline.NOTCH
    ledge = ledge.cut(cq.Workplane("XY").box(nx1 + GAP + 1, ny1 - ny0, bay + 2, centered=False)
                      .translate((-GAP - 1, ny0, -bay - 1)))
    body = body.union(ledge)
    # solid strip under the nose (keeps the cell out of it); the mic channel is cut through it
    nose = prism(board_pts, -bay, 0, GAP).intersect(
        cq.Workplane("XY").box(60, CELL_Y0 + GAP - 0.5, bay, centered=False).translate((-10, -GAP, -bay))
        if not cyl else   # cylinder builds: just a 1.6 mm shelf (the PCM sits under the nose)
        cq.Workplane("XY").box(60, CELL_Y0 + GAP - 0.5, 1.6, centered=False).translate((-10, -GAP, -1.6)))
    body = body.union(nose)
    body = body.cut(cq.Workplane("XY").box(1.4, MIC_Y + 1.2, 1.0, centered=False)
                    .translate((MIC_X - 0.7, -0.5, -1.0)))
    # slot for the board's end tab (the tab rests on the bottom half's end wall)
    tx0, tx1 = outline.NOSE_RX - GAP, outline.W - outline.NOSE_RX + GAP
    body = body.cut(cq.Workplane("XY").box(tx1 - tx0, outline.TAB + 1, TOP + 0.05, centered=False)
                    .translate((tx0, -1, 0)))
    # business-end openings
    ey = -0.5
    for _, x, z, w, h, r in END:
        c = cq.Workplane("XZ").center(x, z).rect(w, h).extrude(-3).translate((0, ey, 0))
        body = body.cut(c.edges("|Y").fillet(r))
    # OUT1 push-in window (right wall) + release-button slot (lid)
    wy0, wy1, wh = WAGO_WINDOW
    body = body.cut(cq.Workplane("XY").box(WALL + 1.2, wy1 - wy0, wh, centered=False)
                    .translate((outline.W + GAP - 0.2, wy0, TOP)))
    sx0, sy0, sx1, sy1 = WAGO_SLOT
    body = body.cut(cq.Workplane("XY").box(sx1 - sx0, sy1 - sy0, ROOF + 2, centered=False)
                    .translate((sx0, sy0, z1 - ROOF - 1)).edges("|Z").fillet(0.8))
    # side U-notches at the seam
    for side, y, w in SIDE_NOTCHES:
        xw = -(GAP + WALL) - 0.5 if side == "left" else outline.W + GAP + WALL + 0.5
        n = cq.Workplane("YZ").center(y, TOP + 0.4).rect(w, 2.0).extrude(3 if side == "left" else -3)
        body = body.cut(n.edges("|X").fillet(0.9).translate((xw, 0, 0)))
    # two M2 screw bosses past the antenna end
    for bx in (2.6, outline.W - 2.6):
        by = outline.H + ANT_OVERHANG - 2.4
        body = body.union(cq.Workplane("XY").circle(1.9).extrude(z1 - ROOF - z0 - FLOOR)
                          .translate((bx, by, z0 + FLOOR)))
        body = body.cut(cq.Workplane("XY").circle(0.8).extrude(z1 - z0 + 2).translate((bx, by, z0 - 1)))

    big = 300
    bottom = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                            .translate((0, 0, TOP - big)))
    lid = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                         .translate((0, 0, TOP)))
    bottom, lid = bottom.mirror("XZ"), lid.mirror("XZ")
    lid = lid.union(cq.Workplane("XY").workplane(offset=z1).center(outline.W / 2 - 3, -outline.H * 0.62)
                    .transformed(rotate=(0, 0, 180))
                    .text("ChromaBay", 4.0, 0.4, combine=False, halign="center", valign="center"))
    os.makedirs(OUT, exist_ok=True)
    cq.exporters.export(bottom, os.path.join(OUT, f"{name}-bottom.stl"), tolerance=0.05)
    cq.exporters.export(lid, os.path.join(OUT, f"{name}-lid.stl"), tolerance=0.05)
    if cyl:
        # cells end 0.4 mm short of the far wall; the PCM sits in front of them, under the nose
        y1 = outline.H + ANT_OVERHANG - 0.1
        y0 = y1 - CYL_L
        r = CYL_D / 2
        cells = None
        for k in range(cyl):
            zc = -1.8 - r - k * (CYL_D + 0.2)
            c = cq.Workplane("XZ").center(outline.W / 2, zc).circle(r).extrude(-CYL_L).translate((0, y0, 0))
            cells = c if cells is None else cells.union(c)
        pcm = cq.Workplane("XY").box(CYL_D - 1, PCM_T, cyl * CYL_D - 2, centered=False).translate(
            (outline.W / 2 - (CYL_D - 1) / 2, y0 - PCM_T - 0.2, -1.8 - cyl * CYL_D + 1))
        cq.exporters.export(cells.union(pcm).mirror("XZ"), os.path.join(OUT, f"{name}-cell.stl"), tolerance=0.05)
    if cell:
        cw, cl, ch = cell
        c = (cq.Workplane("XY").box(cw, cl, ch, centered=False)
             .translate(((outline.W - cw) / 2, -CELL_Y0 - cl, -0.4 - ch)).edges("|Y").fillet(1.0))
        cq.exporters.export(c, os.path.join(OUT, f"{name}-cell.stl"), tolerance=0.05)
    bb = body.val().BoundingBox()
    print(f"{name:10} outer {bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")


if __name__ == "__main__":
    for n in sys.argv[1:] or list(VARIANTS):
        build(n, **VARIANTS[n])
