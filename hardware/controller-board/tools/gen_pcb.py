#!/usr/bin/python3
"""Generate chromabay-controller.kicad_pcb from design.py (run with KiCad's system python).

Fixed positions for the parts that define the layout (connectors, ICs, inductors, switches);
passives are auto-placed next to the IC pad they connect to. Routing is done afterwards by
route.sh (Freerouting); this script only places, assigns nets, draws the outline and zones.
"""
import math
import os
import sys
import uuid

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import design  # noqa: E402
from gen_sch import uid, lib_symbol  # noqa: E402  (same deterministic UUIDs as the schematic)
from sexpr import find, first  # noqa: E402

PIN_NAMES = {}
for _p in design.parts:
    for _u in find(lib_symbol(_p["symbol"]), "symbol"):
        for _pin in find(_u, "pin"):
            PIN_NAMES[(_p["symbol"], first(_pin, "number")[1])] = first(_pin, "name")[1]

W, H = 36.0, 66.0          # board size, mm (business end at y = 0, antenna end at y = H)
OX, OY = 100.0, 100.0      # board origin inside the KiCad page
MM = pcbnew.FromMM


def P(x, y):
    return pcbnew.VECTOR2I(MM(OX + x), MM(OY + y))


# ref: (x, y, rotation_deg)   -- board coordinates
ANCHORS = {
    # --- business end: button, USB-C, power switch packed edge to edge on the end tab (x 5.2..30.8).
    #     The button body overhangs the edge 0.35 mm and its plunger 0.95 mm; the switch handle 1.0 mm.
    #     The case face is flush with the board edge, so both stick out past the case by that much.
    "SW2": (8.67, 1.65, 180), "J1": (17.1, 4.85, 180), "SW1": (26.48, 2.35, 180),
    "D1": (22.3, 9.35, 180),
    "U8": (25.6, 6.95, 90),          # USB ESD right beside the USB-C, between it and the switch         # set back, aimed at the slot beside the USB-C opening
    "MK1": (9.0, 6.0, 0),           # bottom-port mic; case channel exits the end face under the board
    # --- CHARGER (hand layout, see DESIGN.md 0g). BQ25606 turned 270 deg so VBUS faces the USB-C,
    #     PMID/REGN/BTST/SW run down its right side toward L1, SYS/BAT face down, and the control
    #     pins face left. Chain: USB VBUS -> U2 -> SW -> L1 -> VSYS (C5/C6) ; BAT -> C7 -> Q1 -> BAT_IN.
    "U2": (13.0, 11.6, 270), "C2": (18.3, 10.85, 0), "C4": (16.1, 12.25, 270), "L1": (19.0, 13.8, 180),
    "C5": (22.9, 12.55, 90), "C6": (24.6, 12.55, 90), "C7": (9.5, 14.65, 90),
    "Q1": (5.2, 15.6, 90), "J4": (11.95, 20.8, 270), "J3": (1.6, 28.0, 270),
    # --- BOOST: SW pins straight down into L2, VOUT pins straight up into the output caps,
    #     load switch Q2 -> fuse F1 -> EXT jumper JP5 below it.
    "U3": (10.5, 32.5, 0), "L2": (11.3, 37.0, 0), "C11": (14.7, 33.2, 90),
    "C18": (10.7, 28.3, 90), "C19": (12.3, 28.3, 90), "C20": (13.9, 28.3, 90), "C22": (15.85, 27.9, 90),
    "Q2": (18.9, 28.9, 270), "F1": (17.6, 33.9, 270), "JP5": (17.6, 38.0, 0),
    # boost control parts fanned out around their pins (ILIM/COMP/FB top-left, SS right, VCC left,
    # FSW straddling its pin and the SW pour, BOOT cap left of L2 through a via pair)
    "R20": (7.6, 30.2, 180), "R19": (8.3, 29.35, 180), "C17": (8.3, 28.45, 180), "C16": (6.6, 29.35, 180),
    "R18": (9.3, 25.7, 180), "R17": (10.8, 25.7, 180), "C15": (13.5, 32.3, 90), "C13": (7.05, 33.25, 180),
    "R16": (7.6, 34.95, 180), "C14": (7.5, 36.6, 0),
    # charger set-up parts beside their jumpers / pins
    "JP3": (7.4, 10.6, 90), "R7": (1.9, 13.3, 90), "R8": (1.9, 15.0, 90), "R13": (7.6, 13.6, 90),
    "C3": (17.5, 9.25, 0), "C24": (16.2, 40.6, 180),
    # --- LED OUTPUTS (right side), 2.5 mm lower than before to give the charger the band above them
    "J2": (27.85, 18.3, 180), "J6": (27.85, 26.2, 180), "J5": (34.8, 31.4, 0),
    "U7": (23.9, 38.4, 0), "U9": (29.4, 32.7, 90), "U10": (29.4, 40.1, 90),
    # --- user header across the board above the module
    "J7": (1.3, 46.6, 90),
    # --- charge-current jumpers side by side (bridge one or both), left of the charger's control pins
    "JP1": (2.4, 10.3, 90), "JP2": (4.9, 10.3, 90),
    # --- MCU end: ESP32 module (antenna overhangs the far edge), 3.3 V LDO and IMU beside it
    "U1": (18.0, 58.1, 180), "U6": (5.0, 55.0, 0), "U5": (30.0, 57.5, 0),
}
# User pads: two columns in the strip right of the module.
TP_ORDER = ["3V3", "GND", "SDA", "SCL", "T1", "T2", "T3", "T4", "BOOT", "MIC_BCLK", "MIC_WS",
            "MIC_SD", "EXTSW_A", "EXTSW_B", "TXD0", "RXD0"]

KEEPOUT_ANTENNA = None   # antenna overhangs the board edge
import outline  # noqa: E402
NO_PLACE = [(0, 0, W, 0.4), (0, 0, 3.0, 9.0), (W - 3.0, 0, W, 9.0),       # edge + nose corners
            (outline.NOTCH[0], outline.NOTCH[1] - 0.3, outline.NOTCH[2] + 0.3, outline.NOTCH[3] + 0.3)]


def fp_lib_path(nick):
    return {"lcsc": os.path.join(BOARD_DIR, "lib", "lcsc.pretty"),
            "cb": os.path.join(BOARD_DIR, "lib", "cb.pretty")}.get(
        nick, f"/usr/share/kicad/footprints/{nick}.pretty")


def bbox_mm(fp, pad=0.2):
    """Pads + courtyard/silk/fab outlines, ignoring text (easyeda footprints carry big text)."""
    box = None
    items = list(fp.Pads()) + [g for g in fp.GraphicalItems()
                               if g.GetClass() != "PCB_TEXT" and g.GetLayer() in
                               (pcbnew.F_CrtYd, pcbnew.F_SilkS, pcbnew.F_Fab, pcbnew.F_Cu)]
    for it in items:
        b = it.GetBoundingBox()
        r = (b.GetLeft(), b.GetTop(), b.GetRight(), b.GetBottom())
        box = r if box is None else (min(box[0], r[0]), min(box[1], r[1]), max(box[2], r[2]), max(box[3], r[3]))
    return (pcbnew.ToMM(box[0]) - OX - pad, pcbnew.ToMM(box[1]) - OY - pad,
            pcbnew.ToMM(box[2]) - OX + pad, pcbnew.ToMM(box[3]) - OY + pad)


def overlaps(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def inside(b):
    if not (b[0] >= 0.3 and b[1] >= 0.3 and b[2] <= W - 0.3 and b[3] <= H - 0.3):
        return False
    return all(outline.inside(x, y) for x in (b[0], b[2]) for y in (b[1], b[3]))


def main():
    board = pcbnew.NewBoard(os.path.join(BOARD_DIR, "chromabay-controller.kicad_pcb"))
    board.SetCopperLayerCount(4)
    ds = board.GetDesignSettings()
    ds.SetBoardThickness(MM(1.6))
    ds.m_TrackMinWidth = MM(0.127)
    ds.m_MinClearance = MM(0.1)
    ds.m_ViasMinSize = MM(0.35)          # 0.35/0.2 vias only where a 0.6 won't fit
    ds.m_MinThroughDrill = MM(0.2)
    ds.m_ViasMinAnnularWidth = MM(0.075)
    ds.m_HoleClearance = MM(0.2)
    ds.m_CopperEdgeClearance = MM(0.3)
    ds.SetCustomViaSize(MM(0.45))
    ds.SetCustomViaDrill(MM(0.25))
    ds.UseCustomTrackViaSize(False)
    # Net classes: power nets get fat tracks.
    nc_power = pcbnew.NETCLASS("Power")
    nc_power.SetTrackWidth(MM(0.4))
    nc_power.SetClearance(MM(0.15))
    nc_power.SetViaDiameter(MM(0.55))
    nc_power.SetViaDrill(MM(0.3))
    nc_def = ds.m_NetSettings.GetDefaultNetclass()
    nc_def.SetTrackWidth(MM(0.15))
    nc_def.SetClearance(MM(0.125))     # JLC 4-layer minimum is 0.09; keep some margin
    nc_def.SetViaDiameter(MM(0.45))
    nc_def.SetViaDrill(MM(0.25))
    ds.m_NetSettings.SetNetclass("Power", nc_power)
    power_nets = {"VBUS", "VSYS", "BAT", "BAT_IN", "5V_BOOST", "VLED_SW", "VLED_F", "VLED",
                  "CHG_SW", "BST_SW", "CHG_PMID"}
    for n in power_nets:
        ds.m_NetSettings.SetNetclassPatternAssignment("/" + n, "Power")

    nets = {}

    def net(name):
        if name not in nets:
            # Root-sheet local labels are "/NAME" in KiCad's netlist; match so the board and the
            # schematic agree (Update PCB from Schematic, DRC parity).
            ni = pcbnew.NETINFO_ITEM(board, "/" + name)
            board.Add(ni)
            nets[name] = ni
        return nets[name]

    # ---- outline: rounded nose at the business end, battery notch on the left (tools/outline.py)
    pts = outline.points()
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        e = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_SEGMENT)
        e.SetStart(P(x1, y1)); e.SetEnd(P(x2, y2)); e.SetLayer(pcbnew.Edge_Cuts); e.SetWidth(MM(0.1))
        board.Add(e)

    placed = []  # bboxes
    fps = {}

    def load(p):
        nick, name = p["footprint"].split(":", 1)
        fp = pcbnew.FootprintLoad(fp_lib_path(nick), name)
        if fp is None:
            raise SystemExit(f"footprint not found: {p['footprint']}")
        fp.SetFPID(pcbnew.LIB_ID(nick, name))
        fp.SetReference(p["ref"])
        fp.SetValue(p["value"])
        fp.SetPath(pcbnew.KIID_PATH(f"/{uid('sym', p['ref'])}"))
        if p["lcsc"]:
            fp.SetField("LCSC", p["lcsc"])
        for fname in ("LCSC", "Value", "Footprint", "Datasheet", "Description"):
            f = fp.GetFieldByName(fname)
            if f:
                f.SetVisible(False)
        for t in fp.GraphicalItems():
            if t.GetClass() == "PCB_TEXT":
                t.SetLayer(pcbnew.Cmts_User)   # easyeda puts LCSC codes on silk; park them
        if p["dnp"]:
            fp.SetDNP(True)
            fp.SetExcludedFromBOM(True)
            fp.SetExcludedFromPosFiles(True)
        if not p["lcsc"]:
            fp.SetExcludedFromBOM(True)
            fp.SetExcludedFromPosFiles(True)
        for pad in fp.Pads():
            n = p["pins"].get(pad.GetNumber())
            if n and not n.startswith("NC"):
                pad.SetNet(net(n))
            elif n and n.startswith("NC"):
                pname = PIN_NAMES.get((p["symbol"], pad.GetNumber()), pad.GetNumber())
                nm = (f"unconnected-({p['ref']}-Pad{pad.GetNumber()})" if pname in (pad.GetNumber(), "~", "")
                      else f"unconnected-({p['ref']}-{pname}-Pad{pad.GetNumber()})")
                if nm not in nets:
                    ni = pcbnew.NETINFO_ITEM(board, nm); board.Add(ni); nets[nm] = ni
                pad.SetNet(nets[nm])
            elif pad.GetNumber() == "" and pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                if pad.GetDrillSize().x >= pad.GetSize(pcbnew.F_Cu).x - 1000:
                    pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)      # easyeda locating pegs
                else:                                              # thermal vias under an EP:
                    ep = next(q for q in fp.Pads()                    # join the exposed pad's pin
                              if q.GetNumber() and q.GetAttribute() == pcbnew.PAD_ATTRIB_SMD
                              and q.HitTest(pad.GetPosition()))
                    pad.SetNumber(ep.GetNumber())
                    pad.SetNet(net(p["pins"][ep.GetNumber()]))
        if p["ref"] == "J7":   # header outline would run through the pin labels: Fab only
            for g in fp.GraphicalItems():
                if g.GetClass() != "PCB_TEXT" and g.GetLayer() == pcbnew.F_SilkS:
                    g.SetLayer(pcbnew.F_Fab)
        if p["ref"] == "J1":
            fp.SetLocalClearance(MM(0.1))   # USB-C VBUS/GND pads sit 0.1 mm apart by design
        # Reference text small, on silkscreen only where there's room: keep it on Fab.
        fp.Value().SetVisible(False)
        for t in fp.GraphicalItems():
            if t.GetClass() == "PCB_TEXT" and t.GetLayer() in (pcbnew.F_SilkS, pcbnew.F_Fab):
                t.SetVisible(False) if hasattr(t, "SetVisible") else None
        fp.Reference().SetLayer(pcbnew.F_Fab)
        fp.Reference().SetTextSize(pcbnew.VECTOR2I(MM(0.5), MM(0.5)))
        fp.Reference().SetTextThickness(MM(0.08))
        board.Add(fp)
        fps[p["ref"]] = fp
        return fp

    def put(fp, x, y, rot):
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(P(x, y))
        # Correct for footprints whose origin isn't their centre? Positions above are origins.

    by_ref = {p["ref"]: p for p in design.parts}

    # ---- anchors
    for ref, (x, y, rot) in ANCHORS.items():
        fp = load(by_ref[ref])
        put(fp, x, y, rot)
        placed.append(bbox_mm(fp, 0.15))
    # User header labels: above the top row, below the bottom row, rotated to fit 2.54 mm
    hdr = fps["J7"]
    ys = sorted({pad.GetPosition().y for pad in hdr.Pads()})
    for pad in hdr.Pads():
        hnet = by_ref["J7"]["pins"][pad.GetNumber()]
        x, y = pcbnew.ToMM(pad.GetPosition().x) - OX, pcbnew.ToMM(pad.GetPosition().y) - OY
        top = pad.GetPosition().y == ys[0]
        t = pcbnew.PCB_TEXT(board)
        t.SetText(design.HEADER_LABELS[hnet]); t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(MM(0.42), MM(0.6))); t.SetTextThickness(MM(0.1))
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER)
        t.SetPosition(P(x, y - 1.55 if top else y + 1.55))
        board.Add(t)
    placed.append((0.3, 41.8, 31.0, 48.9))   # header + its labels
    # Wire-pad labels: battery pads (label to the right of each pad), LED pads (label to the left)
    PAD_TEXT = {"J3": ({"1": "BAT+", "2": "BAT-", "3": "NTC"}, +1),
                "J5": ({"1": "GND", "2": "5V", **{str(3 + i): n for i, n in enumerate(
                    ["C1", "D1", "C2", "D2", "C3", "D3", "C4", "D4"])}}, -1)}
    for ref, (names, side) in PAD_TEXT.items():
        for pad in fps[ref].Pads():
            text = names[pad.GetNumber()]
            px, py = pcbnew.ToMM(pad.GetPosition().x) - OX, pcbnew.ToMM(pad.GetPosition().y) - OY
            hw = pcbnew.ToMM(pad.GetSize(pcbnew.F_Cu).x) / 2
            tw = 0.5 * len(text)
            cx = px + side * (hw + 0.25 + tw / 2)
            t = pcbnew.PCB_TEXT(board)
            t.SetText(text); t.SetLayer(pcbnew.F_SilkS)
            t.SetTextSize(pcbnew.VECTOR2I(MM(0.5), MM(0.65))); t.SetTextThickness(MM(0.11))
            t.SetPosition(P(cx, py)); board.Add(t)
            placed.append((cx - tw / 2 - 0.1, py - 0.45, cx + tw / 2 + 0.1, py + 0.45))
    import power_layout
    placed.extend(power_layout.RESERVED)     # hand-laid power copper (tools/power_layout.py)
    placed.append((0.9, 7.6, 6.4, 8.75))     # "+0.45A  +1A" labels above the charge jumpers
    placed.append((2.6, 12.1, 4.6, 13.1))  # "CHG" below them
    tps = []

    # ---- passives + jumpers: auto-place near the IC pad they share a net with
    anchor_refs = set(ANCHORS) | {p["ref"] for p in tps}
    rest = [p for p in design.parts if p["ref"] not in anchor_refs]

    def pad_pos(ref, netname):
        fp = fps.get(ref)
        if not fp:
            return None
        for pad in fp.Pads():
            if pad.GetNetname().lstrip("/") == netname:
                v = pad.GetPosition()
                return pcbnew.ToMM(v.x) - OX, pcbnew.ToMM(v.y) - OY
        return None

    RAILS = {"GND", "3V3", "VSYS", "5V_BOOST", "VBUS", "BAT", "BAT_IN", "VLED"}

    def target_info(p):
        """(tier, position): tier 0 = sits on a charger/boost control pin, 1 = charger/boost rail cap,
        2 = other chip pin, 3 = other chip rail, 4 = anything else. Lower tiers are placed first."""
        best = None
        is_cap = p["ref"].startswith("C")
        for netname in p["pins"].values():
            if netname == "GND" or netname.startswith("NC"):
                continue
            rail = netname in RAILS
            for ref in ANCHORS:
                if ref == p["ref"]:
                    continue
                pp = pad_pos(ref, netname)
                if not pp:
                    continue
                chip = ref[0] in "UQD" or ref.startswith(("MK", "L", "J1"))
                if ref in ("U2", "U3") and not rail:
                    tier = 0
                elif ref in ("U2", "U3") and is_cap:
                    tier = 1
                elif chip and not rail:
                    tier = 2
                elif chip:
                    tier = 3
                else:
                    tier = 4
                if best is None or tier < best[0]:
                    best = (tier, pp)
        return best or (5, (W / 2, H / 2))

    def target(p):
        return target_info(p)[1]

    # place the most constrained first: parts that sit on a specific charger/boost pin, then the
    # caps on those chips' rails, then other chip pins, rails, and the rest
    rest.sort(key=lambda p: (target_info(p)[0], p["ref"]))
    for p in rest:
        fp = load(p)
        tx, ty = target(p)
        done = False
        for radius in [i * 0.3 for i in range(0, 150)]:
            steps = max(1, int(2 * math.pi * radius / 0.5))
            for k in range(steps):
                a = 2 * math.pi * k / steps
                x, y = tx + radius * math.cos(a), ty + radius * math.sin(a)
                for rot in (0, 90):
                    put(fp, round(x * 10) / 10, round(y * 10) / 10, rot)
                    bb = bbox_mm(fp, 0.12)
                    if inside(bb) and not any(overlaps(bb, o) for o in placed + NO_PLACE):
                        placed.append(bb)
                        if os.environ.get("PLACE_DEBUG"):
                            print("place", p["ref"], target_info(p)[0], round(radius, 1))
                        done = True
                        break
                if done:
                    break
            if done:
                break
        if not done:
            print("could not place", p["ref"])

    # ---- solder-jumper labels (what bridging / cutting does)
    JP_TEXT = {"JP1": "+0.45A", "JP2": "+1A", "JP3": "NTC", "JP4": "SW", "JP5": "EXT5V", "JP7": "MIC"}
    # Put each label on the first side of its jumper that is clear of every part and earlier label.
    def mm_box(b, pad):
        return (pcbnew.ToMM(b.GetLeft()) - OX - pad, pcbnew.ToMM(b.GetTop()) - OY - pad,
                pcbnew.ToMM(b.GetRight()) - OX + pad, pcbnew.ToMM(b.GetBottom()) - OY + pad)
    taken = []   # every pad and silkscreen stroke, individually (tighter than part bounding boxes)
    for f in fps.values():
        taken += [mm_box(q.GetBoundingBox(), 0.1) for q in f.Pads()]
        taken += [mm_box(g.GetBoundingBox(), 0.1) for g in f.GraphicalItems()
                  if g.GetClass() != "PCB_TEXT" and g.GetLayer() == pcbnew.F_SilkS]
    taken += [mm_box(d.GetBoundingBox(), 0.1) for d in board.GetDrawings() if d.GetLayer() == pcbnew.F_SilkS]

    def label(text, cands):
        tw, th = 0.5 * len(text) + 0.4, 1.0
        for cx, cy, rot in cands:
            w, h = (th, tw) if rot else (tw, th)
            box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
            if inside(box) and not any(overlaps(box, o) for o in taken):
                break
        else:
            print("label overlaps:", text)
            cx, cy, rot = cands[0]
            box = (cx - tw / 2, cy - th / 2, cx + tw / 2, cy + th / 2)
        taken.append(box)
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text); t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(MM(0.45), MM(0.55))); t.SetTextThickness(MM(0.1))
        t.SetPosition(P(cx, cy)); t.SetTextAngleDegrees(rot); board.Add(t)

    label("CHG", [(3.6, 12.6, 0), (3.6, 8.2, 0)])
    for ref, text in JP_TEXT.items():
        fp = fps.get(ref)
        if not fp:
            continue
        bb = bbox_mm(fp, 0)
        mx, my, hw = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, 0.25 * len(text) + 0.2
        cands = [(mx, bb[1] - 0.6, 0), (mx, bb[3] + 0.6, 0), (bb[0] - hw - 0.1, my, 0),
                 (bb[2] + hw + 0.1, my, 0), (bb[0] - 0.6, my, 90), (bb[2] + 0.6, my, 90)]
        for r in (1.0, 1.5, 2.0, 2.5, 3.0):          # then a widening ring around the jumper
            for k in range(16):
                a = 2 * math.pi * k / 16
                cands += [(mx + (r + hw) * math.cos(a), my + (r + 0.5) * math.sin(a), 0),
                          (mx + (r + 0.5) * math.cos(a), my + (r + hw) * math.sin(a), 90)]
        label(text, cands)

    # ---- zones: In1 = solid GND plane, B.Cu GND pour, antenna keepout
    def zone(layer, netname, rect, priority=0):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        if netname:
            z.SetNet(net(netname))
        x0, y0, x1, y1 = rect
        ol = z.Outline()
        ol.NewOutline()
        for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
            ol.Append(MM(OX + x), MM(OY + y))
        z.SetAssignedPriority(priority)
        z.SetLocalClearance(MM(0.2))
        z.SetMinThickness(MM(0.2))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetThermalReliefGap(MM(0.25))
        z.SetThermalReliefSpokeWidth(MM(0.3))
        board.Add(z)
        return z

    zone(pcbnew.In1_Cu, "GND", (0, 0, W, H))
    zone(pcbnew.B_Cu, "GND", (0, 0, W, H))
    zone(pcbnew.F_Cu, "GND", (0, 0, W, H))

    # ---- silkscreen: name, rev, business-end labels
    def silk(text, x, y, size=0.8, layer=pcbnew.F_SilkS, mirror=False):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text); t.SetLayer(layer); t.SetMirrored(mirror)
        t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size))); t.SetTextThickness(MM(size * 0.15))
        t.SetPosition(P(x, y)); board.Add(t)
    silk("ChromaBay Controller rev A", 18, 30.0, 1.0, pcbnew.B_SilkS, True)
    silk("battery side - keep separator between board and cell", 18, 32.0, 0.6, pcbnew.B_SilkS, True)

    board.BuildConnectivity()
    out = os.path.join(BOARD_DIR, "chromabay-controller.kicad_pcb")
    pcbnew.SaveBoard(out, board)
    import re
    txt = open(out, encoding="utf-8").read()
    txt = re.sub(r'\(model "(?:[^"]*/)?lcsc\.3dshapes/([^"]+)\.wrl"',
                 r'(model "${KIPRJMOD}/lib/lcsc.3dshapes/\1.wrl"', txt)
    open(out, "w", encoding="utf-8").write(txt)
    print("wrote", out, len(fps), "footprints")


if __name__ == "__main__":
    main()
