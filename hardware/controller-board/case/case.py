#!/usr/bin/env python3
"""Parametric 3D-printable clamshell case for the ChromaBay controller (CadQuery).

    python3 case/case.py [variant ...]        variants: external, slim, thick (default: all)

The shell follows the board outline (tools/outline.py): the rounded business-end nose and the
battery notch. Variants differ in the battery bay under the board:
  external  no cell inside; battery leads leave through the left-side notch
  slim      603450 pouch (~1.1 Ah) under the board
  thick     103450 pouch (~2 Ah) under the board
Every variant has the OUT1 push-in window (wires go in from outside) and the button/USB/switch/LED/
mic openings on the business end.

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

VARIANTS = {
    "external": dict(bay=1.0, cell=None),
    "slim": dict(bay=6.6, cell=(34.0, 46.0, 6.0)),     # 603450-class pouch, ~1.1 Ah
    "thick": dict(bay=10.6, cell=(34.0, 46.0, 10.0)),  # 103450-class pouch, ~2 Ah
    # 1S2P 18650 pack (two cells side by side + PCM + JST lead), ~6-7 Ah: the 200-LED / 4-hour
    # target. The bay is wider and longer than the board, so this one is a "brick".
    "brick": dict(bay=1.0, cell=None, pack=(37.6, 70.0, 19.0, 12.0)),   # w, l, h, y0 of the pack
}
CELL_Y0 = 11.0          # the strip under the nose stays solid (mic channel)

# ---------------------------------------------------------------- features (match gen_pcb.py)
END = [  # business-end cutouts: (name, x_centre, z_centre, width, height, corner radius)
    ("button", 6.3, TOP + 0.85, 2.8, 1.9, 0.4),   # plunger hole
    ("led", 12.15, TOP + 0.55, 1.8, 1.6, 0.6),
    ("usb", 19.48, TOP + 1.6, 9.6, 3.8, 1.2),
    ("switch", 28.86, TOP + 0.85, 5.0, 2.0, 0.4), # slot for the slide cap (travel 1.5 mm)
]
MIC_X, MIC_Y = 12.2, 7.9          # bottom-port mic -> channel under the board -> end face (under the LED)
SIDE_NOTCHES = [  # (side, y_centre, width): U-notches at the seam for laid-in wires
    ("left", 20.8, 5.0),          # battery lead, external-battery builds (beside the JST notch)
]
# One opening in the right wall covers the OUT1 push-in entries and all ten LED wire pads.
WAGO_WINDOW = (11.6, 53.0, 4.8)   # y0, y1, height above the PCB top
WAGO_SLOT = (30.6, 12.2, 34.6, 27.4)  # lid slot over the WAGO release buttons


# Printed extenders: the button and switch sit 2.3 mm back from the board edge (so the nose can
# taper), so each gets a small printed part that reaches out through the end wall.
# Tune ACT_TIP_Y / handle pocket to the real parts on the first print.
ACT_TIP_Y = 2.3        # board y of the button actuator tip and the switch handle tip
WALL_FACE_Y = -(GAP + WALL)  # outer face of the end wall (nose is flat there to within 0.4 mm)
PROTRUDE = 1.2


def extenders():
    """Button plunger and switch slide-cap, in board coordinates (assembled positions)."""
    bx, bz = END[0][1], END[0][2]
    y0, y1 = WALL_FACE_Y - PROTRUDE, ACT_TIP_Y - 0.1
    plunger = (cq.Workplane("XY").box(2.4, y1 - y0, 1.5).translate((bx, (y0 + y1) / 2, bz))
               .union(cq.Workplane("XY").box(4.4, 0.8, 1.5).translate((bx, 0.6, bz))))  # flange inside the wall
    sx, sz = END[3][1], END[3][2]
    c_y1 = ACT_TIP_Y + 1.0                       # overlaps the handle by 1 mm
    cap = (cq.Workplane("XY").box(3.2, c_y1 - y0, 1.6).translate((sx, (y0 + c_y1) / 2, sz))
           .union(cq.Workplane("XY").box(6.6, 0.8, 1.6).translate((sx, 0.6, sz)))       # retaining plate
           .cut(cq.Workplane("XY").box(1.8, 1.3, 1.2).translate((sx, c_y1 - 0.6, sz))))  # handle pocket
    return plunger, cap


def prism(pts, z0, z1, offset=0.0):
    wp = cq.Workplane("XY").workplane(offset=z0).polyline(pts).close()
    if offset:
        wp = wp.offset2D(offset, "arc")
    return wp.extrude(z1 - z0)


def build(name, bay, cell, pack=None):
    z0 = -(bay + FLOOR)
    z1 = TOP + COMP_H + LID_CLEAR + ROOF
    case_pts = outline.points(notch=False, far_extend=ANT_OVERHANG)
    body = prism(case_pts, z0, z1, GAP + WALL)
    body = body.cut(prism(case_pts, z0 + FLOOR, z1 - ROOF, GAP))
    # 1.2 mm ledge the board rests on, open under the battery notch so the lead can drop through
    board_pts = outline.points(notch=False)
    ledge = prism(board_pts, -bay, 0, GAP).cut(prism(board_pts, -bay - 1, 1, -1.2))
    nx0, ny0, nx1, ny1 = outline.NOTCH
    ledge = ledge.cut(cq.Workplane("XY").box(nx1 + GAP + 1, ny1 - ny0, bay + 2, centered=False)
                      .translate((-GAP - 1, ny0, -bay - 1)))
    body = body.union(ledge)
    # solid strip under the nose (keeps the cell out of it); the mic channel is cut through it
    nose = prism(board_pts, -bay, 0, GAP).intersect(
        cq.Workplane("XY").box(60, CELL_Y0 + GAP - 0.5, bay, centered=False).translate((-10, -GAP, -bay)))
    body = body.union(nose)
    body = body.cut(cq.Workplane("XY").box(1.4, MIC_Y + GAP + WALL + 0.7, 1.0, centered=False)
                    .translate((MIC_X - 0.7, -(GAP + WALL) - 0.1, -1.0)))
    # business-end openings
    ey = -(GAP + WALL) - 0.5
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
        n = cq.Workplane("YZ").center(y, TOP + 0.6).rect(w, 4.4).extrude(3 if side == "left" else -3)
        body = body.cut(n.edges("|X").fillet(min(w, 4.4) / 2 - 0.01).translate((xw, 0, 0)))
    # big-pack bay under the board (brick variant): a box wider and longer than the board
    if pack:
        pw, pl, ph, py0 = pack
        iw, il = pw + 0.8, pl + 0.8
        ix0 = (outline.W - iw) / 2
        bz0 = -(ph + 1.5 + FLOOR)
        box = (cq.Workplane("XY").box(iw + 2 * WALL, il + 2 * WALL, -bz0, centered=False)
               .translate((ix0 - WALL, py0 - 0.4 - WALL, bz0)).edges("|Z").fillet(2.0))
        body = body.union(box).cut(cq.Workplane("XY").box(iw, il, ph + 0.5, centered=False)
                                   .translate((ix0, py0 - 0.4, bz0 + FLOOR)))
        z0 = bz0
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
    plunger, cap = extenders()
    cq.exporters.export(plunger.mirror("XZ"), os.path.join(OUT, "button-plunger.stl"), tolerance=0.02)
    cq.exporters.export(cap.mirror("XZ"), os.path.join(OUT, "switch-cap.stl"), tolerance=0.02)
    if pack:
        pw, pl, ph, py0 = pack
        r = ph / 2
        cells = None
        for cx in (outline.W / 2 - pw / 4, outline.W / 2 + pw / 4):
            cyl = (cq.Workplane("XZ").center(cx, -1.2 - r).circle(r).extrude(-65.0)
                   .translate((0, py0 + 3.0, 0)))
            cells = cyl if cells is None else cells.union(cyl)
        pcm = cq.Workplane("XY").box(pw - 2, 3.0, ph - 4, centered=False).translate(
            ((outline.W - pw) / 2 + 1, py0, -1.2 - ph + 2))
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
