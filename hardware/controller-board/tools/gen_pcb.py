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

W, H = 36.0, 68.0          # board size, mm (business end at y = 0, antenna end at y = H)
OX, OY = 100.0, 100.0      # board origin inside the KiCad page
MM = pcbnew.FromMM


def P(x, y):
    return pcbnew.VECTOR2I(MM(OX + x), MM(OY + y))


# ref: (x, y, rotation_deg)   -- board coordinates
ANCHORS = {
    # business end (y = 0): user button, LED, USB-C, power switch -- all facing out the end
    "SW2": (3.7, 2.7, 180), "D1": (9.5, 1.7, 180), "J1": (18.0, 4.85, 180), "SW1": (31.4, 3.4, 180),
    "MK1": (9.5, 8.6, 0),           # port hole -> case channel -> end face, under the LED
    # left side: swappable battery (JST-PH opening faces the left wall) + wire pads
    "J4": (6.65, 17.5, 270), "J3": (1.6, 25.0, 270),
    # right side: OUT1 on two WAGO 2060 push-in blocks (wire entry facing the right wall), then
    # every output on 2.54 mm solder pads
    "J2": (28.0, 12.0, 180), "J6": (28.0, 19.9, 180), "J5": (34.6, 26.5, 0),
    # power stage
    "U2": (16.0, 14.5, 0), "L1": (16.0, 21.5, 0), "Q1": (10.0, 25.5, 0),
    "U3": (9.0, 34.0, 0), "L2": (3.0, 35.0, 90), "Q2": (16.0, 30.0, 0), "Q3": (19.5, 32.5, 0),
    # logic
    "U7": (13.5, 43.0, 90), "U6": (8.0, 46.5, 0), "U4": (21.5, 38.5, 0), "U5": (23.0, 46.0, 0),
    # ESP32-S3 module: the antenna overhangs the far edge (Espressif's preferred placement)
    "U1": (18.0, 60.1, 180),
}
# User pads: two columns in the strip right of the module.
TP_ORDER = ["3V3", "GND", "SDA", "SCL", "T1", "T2", "T3", "T4", "BOOT", "MIC_BCLK", "MIC_WS",
            "MIC_SD", "EXTSW_A", "EXTSW_B", "TXD0", "RXD0"]

KEEPOUT_ANTENNA = None   # antenna overhangs the board edge
NO_PLACE = [(0, 0, W, 0.4)]


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
    return b[0] >= 0.3 and b[1] >= 0.3 and b[2] <= W - 0.3 and b[3] <= H - 0.3


def main():
    board = pcbnew.NewBoard(os.path.join(BOARD_DIR, "chromabay-controller.kicad_pcb"))
    board.SetCopperLayerCount(4)
    ds = board.GetDesignSettings()
    ds.SetBoardThickness(MM(1.6))
    ds.m_TrackMinWidth = MM(0.127)
    ds.m_MinClearance = MM(0.1)
    ds.m_ViasMinSize = MM(0.45)
    ds.m_MinThroughDrill = MM(0.2)
    ds.m_ViasMinAnnularWidth = MM(0.1)
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
    nc_def.SetClearance(MM(0.13))
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

    # ---- outline with rounded corners
    r = 1.5
    def seg(a, b):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(P(*a)); s.SetEnd(P(*b)); s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1))
        board.Add(s)
    def arc(c, start, angle):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_ARC)
        s.SetCenter(P(*c)); s.SetStart(P(*start)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(angle, pcbnew.DEGREES_T))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    seg((r, 0), (W - r, 0)); seg((W, r), (W, H - r)); seg((W - r, H), (r, H)); seg((0, H - r), (0, r))
    arc((W - r, r), (W - r, 0), 90); arc((W - r, H - r), (W, H - r), 90)
    arc((r, H - r), (r, H), 90); arc((r, r), (0, r), 90)

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
    # User pads: one column each side of the module, labels toward the module.
    tps = [p for p in design.parts if p["ref"].startswith("TP") and p["value"] in TP_ORDER]
    tps.sort(key=lambda p: TP_ORDER.index(p["value"]))
    for i, p in enumerate(tps):
        fp = load(p)
        left = i < 7
        row = i if left else i - 7
        x, y = (1.3 if left else W - 1.3), H - 14.6 + row * 2.0
        put(fp, x, y, 0)
        txt = pcbnew.PCB_TEXT(board)
        txt.SetText(p["value"].replace("MIC_", "M").replace("EXTSW_", "SW"))
        txt.SetLayer(pcbnew.F_SilkS)
        txt.SetTextSize(pcbnew.VECTOR2I(MM(0.6), MM(0.6)))
        txt.SetTextThickness(MM(0.1))
        txt.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT if left else pcbnew.GR_TEXT_H_ALIGN_RIGHT)
        txt.SetPosition(P(x + 1.0 if left else x - 1.0, y))
        board.Add(txt)
        placed.append(bbox_mm(fp, 0.1))

    # Spare-GPIO pads: one column on the left edge above the user pads.
    gpio_pads = [p for p in design.parts if p["ref"].startswith("TP") and p["value"].startswith("IO")]
    for i, p in enumerate(gpio_pads):
        fp = load(p)
        x, y = 1.3, H - 28.75 + i * 2.0
        put(fp, x, y, 0)
        txt = pcbnew.PCB_TEXT(board)
        txt.SetText(p["value"] + ("*" if p["value"] in ("IO3", "IO45", "IO46") else ""))
        txt.SetLayer(pcbnew.F_SilkS)
        txt.SetTextSize(pcbnew.VECTOR2I(MM(0.6), MM(0.6)))
        txt.SetTextThickness(MM(0.1))
        txt.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        txt.SetPosition(P(x + 1.0, y))
        board.Add(txt)
        placed.append(bbox_mm(fp, 0.1))
        placed.append((x + 0.7, y - 0.5, x + 4.6, y + 0.5))   # keep the label clear
    tps = tps + gpio_pads

    # ---- passives + jumpers: auto-place near the IC pad they share a net with
    anchor_refs = set(ANCHORS) | {p["ref"] for p in tps}
    rest = [p for p in design.parts if p["ref"] not in anchor_refs]

    def pad_pos(ref, netname):
        fp = fps.get(ref)
        if not fp:
            return None
        for pad in fp.Pads():
            if pad.GetNetname() == netname:
                v = pad.GetPosition()
                return pcbnew.ToMM(v.x) - OX, pcbnew.ToMM(v.y) - OY
        return None

    def target(p):
        best = None
        for netname in p["pins"].values():
            if netname in ("GND", "3V3", "VSYS", "5V_BOOST") and best:
                continue
            for ref in ANCHORS:
                if ref == p["ref"]:
                    continue
                pp = pad_pos(ref, netname)
                if pp and netname not in ("GND",):
                    score = 0 if by_ref[ref]["block"] == p["block"] else 1
                    if netname in ("3V3", "VSYS", "5V_BOOST"):
                        score += 2
                    if best is None or score < best[0]:
                        best = (score, pp)
        return best[1] if best else (W / 2, H / 2)

    # place the most constrained first: those whose target is a specific IC pin
    prio = ["usb", "shifter", "charger", "boost", "loadsw", "battery", "gauge", "sensors",
            "power", "leds", "mcu", "pads"]
    rest.sort(key=lambda p: (prio.index(p["block"]), p["ref"]))
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
                        done = True
                        break
                if done:
                    break
            if done:
                break
        if not done:
            print("could not place", p["ref"])

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
    silk("ChromaBay Controller rev A", 18, 34.0, 1.0, pcbnew.B_SilkS, True)
    silk("battery side - keep separator between board and cell", 18, 36.0, 0.6, pcbnew.B_SilkS, True)

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
