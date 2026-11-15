#!/usr/bin/env python3
"""Parametric 3D-printable clamshell case for the ChromaBay controller (CadQuery).

    python3 case/case.py [variant ...]      variants: external, slim, thick   (default: all)

Writes case/out/<variant>-bottom.step/.stl and <variant>-lid.step/.stl, plus a battery
placeholder. Coordinates match the PCB: x across (0..BOARD_W), y along (0 = business end),
z up from the board's bottom face. (Exported models use y = -y_pcb so they are right-handed.) Board features the case must line up with are the
constants in the FEATURES block - keep them in sync with tools/gen_pcb.py.
"""
import os
import sys

import cadquery as cq

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

# ---------------------------------------------------------------- board + general
BOARD_W, BOARD_L, PCB_T = 32.0, 64.0, 0.8
COMP_H = 3.3            # tallest part above the PCB (USB-C 3.2 mm)
WALL, FLOOR, ROOF = 1.6, 1.2, 1.2
GAP = 0.3               # board-to-wall clearance
LID_CLEAR = 0.5         # above the tallest part
CORNER_R = 2.5

VARIANTS = {            # battery bay height under the PCB (0 = no internal cell)
    "external": dict(bay=1.0, cell=None),
    "slim": dict(bay=6.6, cell=(30.0, 45.0, 6.0)),     # 603045 pouch, ~900 mAh
    "thick": dict(bay=10.6, cell=(30.0, 45.0, 10.0)),  # 103045 pouch, ~1500 mAh
}
CELL_Y0 = 10.0          # cell starts here (business-end strip stays clear for the mic channel)

# ---------------------------------------------------------------- FEATURES (from gen_pcb.py)
USB_X, USB_Z = 16.0, PCB_T + 1.6            # receptacle centre
USB_CUT = (9.6, 3.8)                        # plug shell 8.4 x 2.6 + clearance
LED_X, LED_Z = 24.4, PCB_T + 0.6            # side-view LED
MIC_X, MIC_Y = 24.4, 7.6                    # bottom-port mic (port hole through the PCB)
BTN_Y, BTN_Z = 5.0, PCB_T + 0.8             # user button, left long side
SW_Y, SW_Z = 5.0, PCB_T + 0.75              # power slide switch, right long side
NOTCHES = [  # (x_centre, width, depth into the lid, label) at the seam on the end face
    (7.2, 4.6, 2.4, "BAT + O1"),
    (28.0, 4.6, 2.4, "O2-O4"),
]


def outer(bay):
    z0 = -(bay + FLOOR)
    z1 = PCB_T + COMP_H + LID_CLEAR + ROOF
    return z0, z1


def shell_box(bay):
    z0, z1 = outer(bay)
    w, l = BOARD_W + 2 * (GAP + WALL), BOARD_L + 2 * (GAP + WALL)
    return (cq.Workplane("XY").box(w, l, z1 - z0, centered=False)
            .translate((-(GAP + WALL), -(GAP + WALL), z0))
            .edges("|Z").fillet(CORNER_R)), z0, z1


def cavity(z0, z1):
    return (cq.Workplane("XY").box(BOARD_W + 2 * GAP, BOARD_L + 2 * GAP, z1 - z0, centered=False)
            .translate((-GAP, -GAP, z0)).edges("|Z").fillet(max(0.5, CORNER_R - WALL)))


def build(name, bay, cell):
    body, z0, z1 = shell_box(bay)
    seam = PCB_T                                      # split at the PCB top surface
    # Inner cavity: under-board bay + board + component space
    body = body.cut(cavity(z0 + FLOOR, z1 - ROOF))
    # Ledge the PCB rests on (1.2 mm wide rim around the bay), only when there is a bay below
    rim = cavity(-0.0001 - 0.6, 0).cut(
        cq.Workplane("XY").box(BOARD_W - 2.4, BOARD_L - 2.4, 1, centered=False).translate((1.2, 1.2, -0.7)))
    body = body.union(rim)
    # Business-strip block under the board with the mic channel (keeps the cell out of y < CELL_Y0)
    if bay > 1.5:
        block = (cq.Workplane("XY").box(BOARD_W + 2 * GAP, CELL_Y0 - 0.5 + GAP, bay, centered=False)
                 .translate((-GAP, -GAP, -bay)))
        body = body.union(block)
    # Mic acoustic channel: end face -> under the mic port, 1.2 x 1.0 mm, just under the PCB
    chan = cq.Workplane("XY").box(1.2, MIC_Y + GAP + WALL + 0.6, 1.0, centered=False).translate(
        (MIC_X - 0.6, -(GAP + WALL) - 0.1, -1.0))
    body = body.cut(chan)
    # Battery-wire pass-through from the bay to the top side (left wall, beside the battery pads)
    if bay > 1.5:
        body = body.cut(cq.Workplane("XY").box(1.6, 6.0, bay + 1.0, centered=False)
                        .translate((-GAP - 0.4, 14.0, -bay)))

    # ---- end face (y < 0) cutouts
    ey = -(GAP + WALL) - 0.5
    usb = cq.Workplane("XZ").center(USB_X, USB_Z).rect(*USB_CUT).extrude(-3).translate((0, ey, 0))
    usb = usb.edges("|Y").fillet(1.2)
    body = body.cut(usb)
    body = body.cut(cq.Workplane("XZ").center(LED_X, LED_Z + 0.4).circle(0.9).extrude(-3).translate((0, ey, 0)))
    for x, w, d, _ in NOTCHES:   # U-notches open toward the seam, split between both halves
        n = cq.Workplane("XZ").center(x, seam).rect(w, 2 * d).extrude(-3).translate((0, ey, 0))
        body = body.cut(n.edges("|Y").fillet(min(w, 2 * d) / 2 - 0.01))
    # ---- long sides near the business end: button (left) + power switch (right)
    sx = -(GAP + WALL) - 0.5
    body = body.cut(cq.Workplane("YZ").center(BTN_Y, BTN_Z).rect(3.6, 2.0).extrude(3).translate((sx, 0, 0)))
    body = body.cut(cq.Workplane("YZ").center(SW_Y, SW_Z).rect(5.0, 1.8).extrude(-3)
                    .translate((BOARD_W + GAP + WALL + 0.5, 0, 0)))
    # ---- strain-relief comb posts just inside the notches (zip-tie anchors), on the bottom half
    for x, w, d, _ in NOTCHES:
        for dx in (-w / 2 - 1.2, w / 2 + 1.2):
            body = body.union(cq.Workplane("XY").box(1.0, 1.0, 1.6, centered=True)
                              .translate((x + dx, 1.4, seam + 0.8)))
    # ---- two M2 screw bosses at the antenna end corners (outside the antenna keep-out)
    for bx in (2.6, BOARD_W - 2.6):
        boss = cq.Workplane("XY").circle(2.0).extrude(z1 - ROOF - seam).translate((bx, BOARD_L - 2.6, seam))
        body = body.union(boss)
        body = body.cut(cq.Workplane("XY").circle(0.8).extrude(z1 - z0 + 2).translate((bx, BOARD_L - 2.6, z0 - 1)))

    # ---- split into bottom (z < seam) and lid (z > seam)
    big = 200
    bottom = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                            .translate((0, 0, seam - big)))
    lid = body.intersect(cq.Workplane("XY").box(big, big, big, centered=(True, True, False))
                         .translate((0, 0, seam)))
    # The PCB frame has y running *down* the page; flip to a right-handed CAD frame (y up, business
    # end at y = 0, board occupying y in [-BOARD_L, 0]) so the case isn't a mirror image of the board.
    bottom, lid = bottom.mirror("XZ"), lid.mirror("XZ")
    # labels embossed on the lid top
    zt = z1
    # text reads correctly when the business end faces you
    lid = lid.union(cq.Workplane("XY").workplane(offset=zt).center(BOARD_W / 2, -BOARD_L * 0.55)
                    .transformed(rotate=(0, 0, 180)).text("ChromaBay", 4.0, 0.4, combine=False, halign="center", valign="center"))
    for x, w, d, label in NOTCHES:
        lid = lid.union(cq.Workplane("XY").workplane(offset=zt).center(x, -5.0)
                        .transformed(rotate=(0, 0, 180)).text(label, 1.8, 0.3, combine=False, halign="center", valign="center"))

    os.makedirs(OUT, exist_ok=True)
    for part, shape in (("bottom", bottom), ("lid", lid)):
        cq.exporters.export(shape, os.path.join(OUT, f"{name}-{part}.step"))
        cq.exporters.export(shape, os.path.join(OUT, f"{name}-{part}.stl"), tolerance=0.05)
    if cell:
        cw, cl, ch = cell
        c = (cq.Workplane("XY").box(cw, cl, ch, centered=False)
             .translate(((BOARD_W - cw) / 2, -CELL_Y0 - cl, -0.4 - ch)).edges("|Y").fillet(1.0))
        cq.exporters.export(c, os.path.join(OUT, f"{name}-cell.stl"), tolerance=0.05)
    print(name, "outer size: %.1f x %.1f x %.1f mm" % (BOARD_W + 2 * (GAP + WALL),
                                                       BOARD_L + 2 * (GAP + WALL), z1 - z0))


if __name__ == "__main__":
    for v in sys.argv[1:] or list(VARIANTS):
        build(v, **VARIANTS[v])
