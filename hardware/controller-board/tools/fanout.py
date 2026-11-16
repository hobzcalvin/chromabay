#!/usr/bin/python3
"""Drop a stitching via beside every GND (and optionally other plane-net) SMD pad.

    /usr/bin/python3 tools/fanout.py [board.kicad_pcb]

Each via gets a short track from the pad and lands on the In1 GND plane, so the autorouter
only has signals and power left. Vias are only placed where they clear every pad, via and
track by the board clearance; pads with no room are reported and left to the router.
"""
import math
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
MM = pcbnew.FromMM
VIA_D, VIA_DRILL, TRACK_W, CLEAR = 0.45, 0.25, 0.25, 0.15
NETS = {"/GND"}


def main():
    b = pcbnew.LoadBoard(PCB)
    edge = b.GetBoardEdgesBoundingBox()
    obstacles = []   # (shape, net) on copper
    for f in b.GetFootprints():
        for p in f.Pads():
            obstacles.append(p)
    vias = []
    done = skipped = 0
    for f in b.GetFootprints():
        for p in f.Pads():
            if p.GetNetname() not in NETS or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            layer = pcbnew.F_Cu if p.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
            c = p.GetPosition()
            bb = p.GetBoundingBox()
            r0 = max(bb.GetWidth(), bb.GetHeight()) / 2e6
            placed = False
            for extra in (0.45, 0.6, 0.8, 1.0, 1.3):
                for k in range(16):
                    a = 2 * math.pi * k / 16
                    # walk out from the pad centre until clear of the pad itself
                    d = r0 + extra
                    pos = pcbnew.VECTOR2I(int(c.x + MM(d) * math.cos(a)), int(c.y + MM(d) * math.sin(a)))
                    if not edge.Contains(pos):
                        continue
                    ok = True
                    shape = pcbnew.SHAPE_CIRCLE(pos, MM(VIA_D / 2))
                    for q in obstacles:
                        if q.GetNetname() == p.GetNetname() and q is not p and q.GetAttribute() == pcbnew.PAD_ATTRIB_SMD:
                            pass
                        sh = q.GetEffectiveShape(pcbnew.F_Cu if q.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu)
                        if sh.Collide(shape, MM(CLEAR)):
                            if q is p or (q.GetNetname() == p.GetNetname()):
                                if q is p:
                                    ok = False if sh.Collide(shape, 0) else ok
                                continue
                            ok = False
                            break
                        # THT pads are on every layer: same test already covers them
                    if ok:
                        for v in vias:
                            if math.dist((v.x, v.y), (pos.x, pos.y)) < MM(VIA_D + CLEAR + 0.05):
                                ok = False
                                break
                    if ok and not inside_board(b, pos):
                        ok = False
                    if ok:
                        # the short track must also clear other nets' pads
                        seg = pcbnew.SHAPE_SEGMENT(c, pos, MM(TRACK_W))
                        for q in obstacles:
                            if q.GetNetname() == p.GetNetname():
                                continue
                            if not q.IsOnLayer(layer):
                                continue
                            if q.GetEffectiveShape(layer).Collide(seg, MM(CLEAR)):
                                ok = False
                                break
                    if ok:
                        via = pcbnew.PCB_VIA(b)
                        via.SetPosition(pos); via.SetWidth(MM(VIA_D)); via.SetDrill(MM(VIA_DRILL))
                        via.SetNet(p.GetNet()); b.Add(via)
                        t = pcbnew.PCB_TRACK(b)
                        t.SetStart(c); t.SetEnd(pos); t.SetWidth(MM(TRACK_W)); t.SetLayer(layer)
                        t.SetNet(p.GetNet()); b.Add(t)
                        vias.append(pos)
                        placed = True
                        break
                if placed:
                    break
            if placed:
                done += 1
            else:
                skipped += 1
                print("no room:", f.GetReference(), p.GetNumber())
    pcbnew.SaveBoard(PCB, b)
    print(f"fanout: {done} vias, {skipped} pads left to the router")


_POLY = None


def inside_board(b, pos):
    global _POLY
    if _POLY is None:
        _POLY = pcbnew.SHAPE_POLY_SET()
        b.GetBoardPolygonOutlines(_POLY)
        _POLY.Deflate(MM(0.3 + VIA_D / 2), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))
    return _POLY.Contains(pos)


if __name__ == "__main__":
    main()
