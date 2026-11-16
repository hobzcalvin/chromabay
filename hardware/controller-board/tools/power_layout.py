#!/usr/bin/python3
"""Hand layout of the charger (BQ25606) and boost (TPS61088) power paths.

    /usr/bin/python3 tools/power_layout.py [board.kicad_pcb]

Adds, on top of the placed board (gen_pcb.py):
  * copper pours (zones, solid pad connection, priority above the GND pour) for every
    high-current node: VBUS, PMID, the two switch nodes, VSYS, BAT, BAT_IN, 5V_BOOST,
    VLED_SW, VLED_F, VLED
  * In2 plane regions: VSYS (charger -> boost) and VLED (fuse -> push-ins / pad strip)
  * via arrays between those layers, and a few short locked links at fine-pitch pins
Everything is locked, so the autorouter (tools/route.py) routes the signals around it.

Coordinates are board mm (origin top-left, y towards the antenna end), like gen_pcb.py.
RESERVED is imported by gen_pcb.py so auto-placed passives keep out of these areas.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
OX = OY = 100.0

F, B, IN2 = "F.Cu", "B.Cu", "In2.Cu"

# (net, layer, polygon) -- polygons may overlap same-net pads (they merge solid)
ZONES = [
    # ---- charger
    ("VBUS", F, [(14.45, 7.6), (15.05, 7.6), (15.05, 9.9), (15.42, 9.9), (15.42, 10.5), (14.62, 10.5),
                 (14.62, 10.0), (14.1, 10.0), (14.1, 8.25), (14.45, 8.25)]),
    ("CHG_SW", F, [(15.0, 12.3), (16.5, 12.3), (16.5, 13.02), (15.0, 13.02)]),
    ("VSYS", F, [(12.55, 13.1), (13.45, 13.1), (13.45, 15.1), (20.3, 15.1), (20.3, 12.45), (25.4, 12.45),
                 (25.4, 14.0), (21.3, 14.0), (21.3, 16.4), (12.55, 16.4)]),
    ("BAT", F, [(11.55, 13.15), (12.45, 13.15), (12.45, 16.4), (6.25, 16.4), (6.25, 15.0), (7.4, 15.0),
                (7.4, 14.5), (11.55, 14.5)]),
    ("BAT_IN", F, [(3.3, 14.3), (6.05, 14.3), (6.05, 17.0), (6.9, 17.0), (6.9, 26.2), (3.4, 29.3),
                   (0.5, 29.3), (0.5, 26.5), (3.3, 23.1)]),
    ("BAT_IN", F, [(16.5, 21.15), (17.75, 21.15), (17.75, 22.45), (16.5, 22.45)]),
    ("BAT_IN", B, [(3.5, 21.0), (17.75, 21.0), (17.75, 22.6), (3.5, 22.6)]),
    # ---- boost
    ("BST_SW", F, [(9.7, 33.9), (11.25, 33.9), (11.25, 36.2), (8.57, 36.2), (8.57, 35.3), (9.7, 35.3)]),
    ("VSYS", F, [(12.6, 34.8), (14.0, 34.8), (14.0, 33.45), (15.45, 33.45), (15.45, 38.1), (12.6, 38.1)]),
    ("5V_BOOST", F, [(10.05, 28.5), (16.95, 28.5), (16.95, 27.6), (17.85, 27.6), (17.85, 29.45),
                     (16.85, 29.45), (16.85, 30.25), (11.45, 30.25), (11.45, 31.2), (10.05, 31.2)]),
    ("VLED_SW", F, [(18.15, 27.6), (20.85, 27.6), (20.85, 30.9), (19.4, 30.9), (19.4, 32.8), (15.8, 32.8),
                    (15.8, 31.3), (18.15, 31.3)]),
    ("VLED_F", F, [(15.85, 35.0), (19.35, 35.0), (19.35, 36.5), (17.45, 36.5), (17.45, 37.3), (16.45, 37.3),
                   (16.45, 36.5), (15.85, 36.5)]),
    ("VLED", F, [(17.75, 37.2), (18.75, 37.2), (18.75, 40.1), (16.5, 40.1), (16.5, 39.75), (17.75, 39.75)]),
    ("VLED", F, [(24.9, 19.5), (29.6, 19.5), (29.6, 21.1), (24.9, 21.1)]),     # joins J2's two V pads
    # ---- inner plane regions
    # VSYS: charger area -> 4 mm corridor (x 17-21) -> boost area; leaves In2 free on the left for signals
    ("VSYS", IN2, [(12.5, 10.8), (25.5, 10.8), (25.5, 18.0), (21.0, 18.0), (21.0, 36.3), (17.0, 36.3),
                   (17.0, 38.4), (12.3, 38.4), (12.3, 33.0), (17.0, 33.0), (17.0, 18.0), (12.5, 18.0)]),
    ("VLED", IN2, [(17.3, 36.7), (30.4, 36.7), (30.4, 21.2), (26.8, 21.2), (26.8, 19.4), (33.5, 19.4), (33.5, 33.2), (35.6, 33.2),
                   (35.6, 34.7), (33.5, 34.7), (33.5, 39.6), (17.3, 39.6)]),
]

# (net, x, y): through vias (0.6 / 0.3) stitching the pours to the inner planes / bottom band
VIAS = (
    [("VSYS", x, 15.75) for x in (13.0, 14.5, 16.0, 17.5, 19.0, 20.6)]
    + [("VSYS", 14.85, y) for y in (35.5, 36.3, 37.1, 37.75)]
    + [("BAT_IN", x, y) for x in (4.1, 5.0, 5.9) for y in (21.45, 22.2)]
    + [("BAT_IN", 17.25, 21.55), ("BAT_IN", 17.25, 22.1)]
    + [("VLED", 18.25, 39.15)]
    + [("BST_BOOT", 11.75, 35.35), ("BST_BOOT", 6.4, 36.6)]
    + [("VLED", 27.3, y) for y in (19.95, 20.65)]
)

# 0.35 / 0.2 mm vias where a 0.6 won't fit (JLC multilayer minimum is 0.25 / 0.15)
SMALL_VIAS = [("CHG_REGN", 15.5, 11.38), ("CHG_REGN", 15.9, 9.25)]

# (net, layer, width, [(x, y), ...]): short locked links at fine-pitch pins
TRACKS = [
    ("CHG_PMID", F, 0.2, [(15.3, 10.85), (17.0, 10.85)]),           # U2 PMID -> C2
    ("CHG_REGN", F, 0.15, [(15.25, 11.35), (15.5, 11.38)]),        # U2 REGN -> small via (boxed in by PMID/BTST)
    ("CHG_REGN", B, 0.2, [(15.5, 11.38), (15.9, 9.25)]),           # -> under the pins -> via by C3
    ("CHG_REGN", F, 0.2, [(15.9, 9.25), (16.75, 9.25)]),            # -> C3 REGN pad
    ("CHG_BTST", F, 0.15, [(15.3, 11.85), (15.95, 11.85)]),          # U2 BTST -> C4 (C4 SW pad sits in the SW pour)
    ("VSYS", F, 0.25, [(12.25, 34.5), (12.25, 34.85), (12.7, 35.2)]),  # boost VIN pin -> VSYS pour
    ("BST_BOOT", F, 0.2, [(11.75, 34.5), (11.75, 35.35)]),          # boost BOOT pin -> via (under L2)
    ("BST_BOOT", B, 0.3, [(11.75, 35.35), (10.6, 36.6), (6.4, 36.6)]),  # -> via by C14
    ("BST_BOOT", F, 0.2, [(6.4, 36.6), (7.08, 36.6)]),              # -> C14 BOOT pad
    ("BST_SW", F, 0.3, [(7.92, 36.6), (8.7, 36.6)]),                # C14 SW pad -> L2 SW pad
    ("BST_SW", F, 0.2, [(7.18, 35.1), (7.18, 35.7), (7.92, 36.3), (7.92, 36.6)]),  # R16 SW pad -> C14
    ("BAT", F, 0.3, [(7.6, 14.02), (7.6, 14.6)]),                   # battery-sense divider top -> BAT pour
    ("BST_FSW", F, 0.15, [(9.25, 34.5), (9.25, 34.95), (8.0, 34.95)]),  # FSW pin -> R16 (under EN pin)
]

# keep-out rectangles for the auto-placer (x0, y0, x1, y1)
RESERVED = [
    (14.0, 7.9, 15.5, 10.6), (15.0, 12.1, 16.6, 13.1), (12.5, 14.9, 21.9, 16.5), (6.2, 14.45, 12.5, 16.5),
    (3.2, 16.9, 7.0, 26.4), (16.4, 21.0, 17.9, 22.6), (8.5, 33.85, 11.45, 36.25), (12.5, 33.4, 15.5, 38.15),
    (10.0, 28.4, 17.9, 31.2), (15.75, 27.5, 20.9, 32.85), (15.8, 34.9, 19.4, 37.4), (17.7, 37.2, 18.8, 39.6),
    (24.8, 19.4, 29.7, 21.2), (5.9, 36.0, 8.4, 37.2), (11.4, 34.6, 12.1, 35.7),
]


def main():
    import pcbnew
    MM = pcbnew.FromMM
    b = pcbnew.LoadBoard(PCB)
    layer = {F: pcbnew.F_Cu, B: pcbnew.B_Cu, IN2: pcbnew.In2_Cu}

    def net(n):
        ni = b.FindNet("/" + n)
        if ni is None:
            raise SystemExit("no net " + n)
        return ni

    for name, lay, pts in ZONES:
        z = pcbnew.ZONE(b)
        z.SetLayer(layer[lay])
        z.SetNet(net(name))
        z.SetAssignedPriority(2 if lay != IN2 else 1)
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
        z.SetLocalClearance(MM(0.2))
        z.SetMinThickness(MM(0.2))
        z.SetIsFilled(False)
        z.SetLocked(True)
        ol = z.Outline()
        ol.NewOutline()
        for x, y in pts:
            ol.Append(MM(OX + x), MM(OY + y))
        b.Add(z)
    for name, x, y in VIAS + SMALL_VIAS:
        small = (name, x, y) in SMALL_VIAS
        v = pcbnew.PCB_VIA(b)
        v.SetPosition(pcbnew.VECTOR2I(MM(OX + x), MM(OY + y)))
        v.SetWidth(MM(0.35 if small else 0.6))
        v.SetDrill(MM(0.2 if small else 0.3))
        v.SetNet(net(name))
        v.SetLocked(True)
        b.Add(v)
    for name, lay, w, pts in TRACKS:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(pcbnew.VECTOR2I(MM(OX + x0), MM(OY + y0)))
            t.SetEnd(pcbnew.VECTOR2I(MM(OX + x1), MM(OY + y1)))
            t.SetWidth(MM(w))
            t.SetLayer(layer[lay])
            t.SetNet(net(name))
            t.SetLocked(True)
            b.Add(t)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(PCB, b)
    print(f"power layout: {len(ZONES)} pours, {len(VIAS)} vias, {len(TRACKS)} links")


if __name__ == "__main__":
    main()
