#!/usr/bin/python3
"""Autoroute the placed board with Freerouting, then fill zones.

    /usr/bin/python3 tools/route.py /path/to/freerouting-1.9.0.jar [max_passes]

Use Freerouting 1.9.0: 2.x ignores the pass limit and only writes its result when it exits.
1.9 needs a display; run under `xvfb-run -a` on a headless machine (this script does that if
xvfb-run is installed).

Flow:
  1. tools/fanout.py: a via beside every GND SMD pad, down to the In1 GND plane
  2. drop the outer GND pours (so the router can use F/B), add a 0.35 mm no-track ring along the
     board edge, export Specctra DSN with In1 marked as a plane layer (no signals on it)
  3. route, import the session, restore the pours, fill zones, save
"""
import os
import shutil
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
MM = pcbnew.FromMM


def edge_keepout(board):
    inner = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(inner)
    inner.Deflate(MM(0.35), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))
    ring = pcbnew.SHAPE_POLY_SET()
    ring.NewOutline()
    for x, y in [(90, 90), (146, 90), (146, 176), (90, 176)]:   # well outside the 100,100 origin board
        ring.Append(MM(x), MM(y))
    ring.BooleanSubtract(inner)
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetDoNotAllowTracks(True)
    z.SetDoNotAllowVias(True)
    z.SetDoNotAllowPads(False)
    z.SetDoNotAllowFootprints(False)
    layers = pcbnew.LSET()
    for layer in (pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu):
        layers.AddLayer(layer)
    z.SetLayerSet(layers)
    z.SetOutline(ring)
    ring.thisown = False      # the zone owns it now
    board.Add(z)
    return z


def power_keepouts(board):
    """Router-only keep-outs over every non-GND pour (tools/power_layout.py), so signal traces go
    around the power copper instead of cutting it into islands. Vias may pass through the In2
    plane regions (that's how signals cross the power area) but not through outer-layer pours."""
    shapes = []                       # read every outline first: pcbnew's SWIG wrappers go stale
    for i in range(board.GetAreaCount()):   # once zones are added/removed (index access is safe)
        z = board.GetArea(i)
        if z.GetIsRuleArea() or z.GetNetname() == "/GND":
            continue
        ol = z.Outline()
        shapes.append((z.GetLayer(), [(ol.CVertex(i).x, ol.CVertex(i).y) for i in range(ol.FullPointCount())]))
    for layer, pts in shapes:
        k = pcbnew.ZONE(board)
        k.SetIsRuleArea(True)
        k.SetDoNotAllowTracks(True)
        k.SetDoNotAllowVias(layer != pcbnew.In2_Cu)
        k.SetDoNotAllowPads(False)
        k.SetDoNotAllowFootprints(False)
        k.SetLayer(layer)
        ol = k.Outline()          # build in place: a Python-owned SHAPE_POLY_SET handed to
        ol.NewOutline()           # SetOutline() gets freed later and crashes the zone filler
        for x, y in pts:
            ol.Append(x, y)
        board.Add(k)


def main(jar, passes):
    subprocess.run(["/usr/bin/python3", os.path.join(HERE, "fanout.py"), PCB], check=True)
    # 2. DSN from a throwaway copy (outer GND pours off, router keep-outs on; power pours stay
    #    as planes). Each step in a fresh process: pcbnew's SWIG wrappers go stale after Remove().
    work = os.path.dirname(os.path.abspath(jar))
    dsn, ses = os.path.join(work, "board.dsn"), os.path.join(work, "board.ses")
    tmp_pcb = os.path.join(work, "dsn-prep.kicad_pcb")
    me = os.path.abspath(__file__)
    shutil.copy(PCB.replace(".kicad_pcb", ".kicad_pro"), tmp_pcb.replace(".kicad_pcb", ".kicad_pro"))  # net classes
    subprocess.run(["/usr/bin/python3", me, "--strip-gnd", PCB, tmp_pcb], check=True)
    subprocess.run(["/usr/bin/python3", me, "--export", tmp_pcb, dsn], check=True)
    text = open(dsn).read()
    plane = "(layer In1.Cu\n      (type signal)"
    if plane not in text:
        raise SystemExit("unexpected DSN layer block")
    open(dsn, "w").write(text.replace(plane, "(layer In1.Cu\n      (type power)"))
    # 3. route
    cmd = ["java", "-jar", jar, "-de", dsn, "-do", ses, "-mp", str(passes), "-mt", "1"]
    if shutil.which("xvfb-run"):
        cmd = ["xvfb-run", "-a"] + cmd
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=work)
    # import in a fresh process: pcbnew segfaults with two boards loaded in one run
    subprocess.run(["/usr/bin/python3", os.path.abspath(__file__), "--import", ses], check=True)


def import_session(ses):
    """Import a Freerouting session into the board (outer pours lifted while importing)."""
    board = pcbnew.LoadBoard(PCB)
    outer = [z for z in board.Zones() if not z.GetIsRuleArea() and z.GetLayer() in (pcbnew.F_Cu, pcbnew.B_Cu)
             and z.GetNetname() == "/GND"]
    saved = [(z.GetLayer(), z.GetNetname(), [(z.Outline().CVertex(i).x, z.Outline().CVertex(i).y)
              for i in range(z.Outline().FullPointCount())]) for z in outer]
    for z in outer:
        board.Remove(z)
    if not pcbnew.ImportSpecctraSES(board, ses):
        raise SystemExit("SES import failed")
    for layer, netname, pts in saved:
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(board.FindNet(netname))
        ol = z.Outline(); ol.NewOutline()
        for x, y in pts:
            ol.Append(x, y)
        z.SetLocalClearance(MM(0.2))
        z.SetMinThickness(MM(0.2))
        z.SetThermalReliefGap(MM(0.25))
        z.SetThermalReliefSpokeWidth(MM(0.3))
        board.Add(z)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(PCB, board)
    print("routed + saved", PCB)


def strip_gnd(src, dst):
    board = pcbnew.LoadBoard(src)
    for z in [board.GetArea(i) for i in range(board.GetAreaCount())]:
        if not z.GetIsRuleArea() and z.GetLayer() in (pcbnew.F_Cu, pcbnew.B_Cu) and z.GetNetname() == "/GND":
            board.Remove(z)
    pcbnew.SaveBoard(dst, board)


def label_keepouts(board):
    """Router-only via keep-outs under the user-header pin labels, so no drilled hole lands in
    the middle of a label (tracks may still pass under them: they're under solder mask)."""
    sys.path.insert(0, HERE)
    import design
    names = set(design.HEADER_LABELS.values())
    boxes = []
    for t in board.GetDrawings():
        if t.GetClass() == "PCB_TEXT" and t.GetLayer() == pcbnew.F_SilkS and t.GetText() in names:
            bb = t.GetBoundingBox()
            boxes.append((bb.GetLeft() - MM(0.1), bb.GetTop() - MM(0.1), bb.GetRight() + MM(0.1), bb.GetBottom() + MM(0.1)))
    for x0, y0, x1, y1 in boxes:
        k = pcbnew.ZONE(board)
        k.SetIsRuleArea(True)
        k.SetDoNotAllowTracks(False)
        k.SetDoNotAllowVias(True)
        k.SetDoNotAllowPads(False)
        k.SetDoNotAllowFootprints(False)
        ls = pcbnew.LSET()
        for layer in (pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu):
            ls.AddLayer(layer)
        k.SetLayerSet(ls)
        ol = k.Outline()
        ol.NewOutline()
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            ol.Append(x, y)
        board.Add(k)


def export(src, dsn):
    board = pcbnew.LoadBoard(src)
    label_keepouts(board)
    power_keepouts(board)
    edge_keepout(board)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        raise SystemExit("DSN export failed")


if __name__ == "__main__":
    if sys.argv[1] == "--strip-gnd":
        strip_gnd(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "--export":
        export(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "--import":          # re-import an existing session file
        import_session(sys.argv[2])
    else:
        main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 30)
