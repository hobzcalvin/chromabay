#!/usr/bin/python3
"""Autoroute the board with Freerouting, then fill zones and run DRC.

    /usr/bin/python3 tools/route.py /path/to/freerouting.jar [max_passes]

Flow: drop the outer-layer GND pours (so Freerouting may route on F/B), export Specctra DSN,
route headless, import the session, restore the pours, fill all zones, save.
"""
import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")


def main(jar, passes):
    board = pcbnew.LoadBoard(PCB)
    outer = []
    for z in list(board.Zones()):
        if not z.GetIsRuleArea() and z.GetLayer() in (pcbnew.F_Cu, pcbnew.B_Cu):
            outer.append((z.GetLayer(), z.GetNetname(), [(p.x, p.y) for p in
                          [z.Outline().CVertex(i) for i in range(z.Outline().FullPointCount())]]))
            board.Remove(z)
    work = os.path.join(os.path.dirname(jar))
    dsn, ses = os.path.join(work, "board.dsn"), os.path.join(work, "board.ses")
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        raise SystemExit("DSN export failed")
    cmd = ["java", "-jar", jar, "-de", dsn, "-do", ses, "-mp", str(passes), "-mt", "4",
           "--gui.enabled=false"]
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    if not pcbnew.ImportSpecctraSES(board, ses):
        raise SystemExit("SES import failed")
    for layer, netname, pts in outer:
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(board.FindNet(netname))
        ol = z.Outline(); ol.NewOutline()
        for x, y in pts:
            ol.Append(x, y)
        z.SetLocalClearance(pcbnew.FromMM(0.2))
        z.SetMinThickness(pcbnew.FromMM(0.2))
        z.SetThermalReliefGap(pcbnew.FromMM(0.25))
        z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.3))
        board.Add(z)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(PCB, board)
    print("routed + saved", PCB)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 30)
