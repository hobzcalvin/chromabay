#!/usr/bin/python3
"""Move a few small parts on the routed board to the nearest clear spot by a target point,
ripping only their own traces (re-route the gaps afterwards with tools/patch_route.py).

    /usr/bin/python3 tools/relocate.py REF:x,y [REF:x,y ...] [--rip-net NET ...]

For each REF: delete the tracks that touch its pads (and any dead-end stubs that leaves), then
search outward from (x, y) (board mm) for a position / rotation where its pads clear every other
net's copper by 0.2 mm, its courtyard clears other parts, and it is inside the board. Nets given
with --rip-net are deleted entirely first (e.g. a net that only links the moved parts).
"""
import math
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
MM, TO = pcbnew.FromMM, pcbnew.ToMM
OX = OY = 100.0
CU = (pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu)


def strip_dangling(b, nets):
    """Remove track ends that touch nothing (repeat until stable) on the given nets."""
    while True:
        tracks = [t for t in b.GetTracks() if t.GetNetname() in nets]
        pads = [p for f in b.GetFootprints() for p in f.Pads() if p.GetNetname() in nets]
        zones = [z for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() in nets]
        dead = []
        for t in tracks:
            if t.GetClass() != "PCB_TRACK":
                continue
            for end in (t.GetStart(), t.GetEnd()):
                touch = False
                for o in tracks:
                    if o is t:
                        continue
                    if o.GetClass() == "PCB_VIA":
                        if (o.GetPosition() - end).EuclideanNorm() < MM(0.02):
                            touch = True
                    elif o.GetLayer() == t.GetLayer() and ((o.GetStart() - end).EuclideanNorm() < MM(0.02)
                                                           or (o.GetEnd() - end).EuclideanNorm() < MM(0.02)):
                        touch = True
                    if touch:
                        break
                if not touch:
                    touch = any(p.IsOnLayer(t.GetLayer()) and p.HitTest(end) for p in pads)
                if not touch:
                    touch = any(z.GetLayer() == t.GetLayer() and z.HitTestFilledArea(t.GetLayer(), end) for z in zones)
                if not touch:
                    dead.append(t)
                    break
        for v in [v for v in tracks if v.GetClass() == "PCB_VIA"]:
            n = sum(1 for t in tracks if t.GetClass() == "PCB_TRACK"
                    and ((t.GetStart() - v.GetPosition()).EuclideanNorm() < MM(0.02)
                         or (t.GetEnd() - v.GetPosition()).EuclideanNorm() < MM(0.02)))
            if n == 0 and not v.IsLocked() and not any(z.HitTestFilledArea(z.GetLayer(), v.GetPosition()) for z in zones):
                dead.append(v)
        for t in dead:
            b.Remove(t)
        return len(dead)        # one pass per process: pcbnew wrappers go stale after Remove()


RIP_RECTS = []


def parse(args):
    rip, moves = [], []
    it = iter(args)
    for a in it:
        if a == "--rip-net":
            rip.append(next(it))
        elif a == "--rip-rect":     # x0,y0,x1,y1 board mm: drop top-layer signal tracks crossing it
            RIP_RECTS.append(tuple(map(float, next(it).split(","))))
        else:
            ref, xy = a.split(":")
            x, y = map(float, xy.split(","))
            moves.append((ref, x, y))
    return rip, moves


def strip(args):
    """Phase 1: delete the ripped nets and every track touching a moved part's pads."""
    rip, moves = parse(args)
    b = pcbnew.LoadBoard(PCB)
    padinfo = []                      # read everything before removing anything (stale SWIG)
    for ref, _, _ in moves:
        for p in b.FindFootprintByReference(ref).Pads():
            padinfo.append((p.GetNetname(), p))
    kill = [t for t in b.GetTracks() if t.GetNetname() in rip]
    for x0, y0, x1, y1 in RIP_RECTS:
        box = pcbnew.BOX2I(pcbnew.VECTOR2I(MM(OX + x0), MM(OY + y0)), pcbnew.VECTOR2L(MM(x1 - x0), MM(y1 - y0)))
        for t in b.GetTracks():
            via_in = t.GetClass() == "PCB_VIA" and box.Contains(t.GetPosition())
            if (via_in or (t.GetClass() == "PCB_TRACK" and t.GetLayer() == pcbnew.F_Cu
                           and t.GetNetname() != "/GND" and t.HitTest(box, False))) and not t.IsLocked():
                kill.append(t)
                rip.append(t.GetNetname()) if t.GetNetname() not in rip else None
    for net, p in padinfo:
        kill += [t for t in b.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetNetname() == net
                 and (p.HitTest(t.GetStart()) or p.HitTest(t.GetEnd()))]
    nets = set(rip) | {n for n, _ in padinfo}
    seen = set()
    for t in kill:
        if id(t) not in seen:
            seen.add(id(t))
            b.Remove(t)
    pcbnew.SaveBoard(PCB, b)
    print("stripped", len(seen), "items on", sorted(nets))
    open(PCB + ".nets", "w").write("\n".join(sorted(nets - {"/GND"})))


def dangle():
    nets = set(open(PCB + ".nets").read().split())
    b = pcbnew.LoadBoard(PCB)
    n = strip_dangling(b, nets)
    pcbnew.SaveBoard(PCB, b)
    sys.exit(0 if n else 3)


def place(args):
    """Phase 2 (fresh process): find each part a clear spot near its target."""
    _, moves = parse(args)
    b = pcbnew.LoadBoard(PCB)
    edge = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(edge)
    edge.Deflate(MM(0.6), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))
    for ref, tx, ty in moves:
        f = b.FindFootprintByReference(ref)
        copper = [t for t in b.GetTracks()] + [p for g in b.GetFootprints() if g.GetReference() != ref for p in g.Pads()]
        zones = [z for z in b.Zones() if not z.GetIsRuleArea()]
        others = [g.GetBoundingBox(False) for g in b.GetFootprints() if g.GetReference() != ref]

        def ok():
            for p in f.Pads():
                if not edge.Contains(p.GetPosition()):
                    return False
                sh = p.GetEffectiveShape(pcbnew.F_Cu)
                for o in copper:
                    if o.IsOnLayer(pcbnew.F_Cu) and o.GetNetname() != p.GetNetname() \
                            and o.GetEffectiveShape(pcbnew.F_Cu).Collide(sh, MM(0.2)):
                        return False
                for z in zones:
                    if z.GetLayer() == pcbnew.F_Cu and z.GetNetname() not in (p.GetNetname(), "/GND") \
                            and z.Outline().Collide(p.GetPosition(), MM(0.9)):
                        return False
            bb = f.GetBoundingBox(False)
            return not any(bb.Intersects(o) for o in others)

        best = None
        for rot in (0, 90, 180, 270):
            f.SetOrientationDegrees(rot)
            for r in range(0, 61):
                if best and r * 0.1 >= best[0]:
                    break
                steps = max(1, int(2 * math.pi * r))
                for k in range(steps):
                    a = 2 * math.pi * k / steps
                    x, y = tx + r * 0.1 * math.cos(a), ty + r * 0.1 * math.sin(a)
                    f.SetPosition(pcbnew.VECTOR2I(MM(OX + x), MM(OY + y)))
                    if ok():
                        best = (r * 0.1, x, y, rot)
                        break
        if not best:
            raise SystemExit(f"no room for {ref} near ({tx}, {ty})")
        _, x, y, rot = best
        f.SetOrientationDegrees(rot)
        f.SetPosition(pcbnew.VECTOR2I(MM(OX + x), MM(OY + y)))
        print(f"{ref} -> ({x:.2f}, {y:.2f}) rot {rot}, {best[0]:.1f} mm from target")
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(PCB, b)


def main(args):
    import subprocess
    me = os.path.abspath(__file__)
    subprocess.run(["/usr/bin/python3", me, "--phase-strip"] + args, check=True)
    while subprocess.run(["/usr/bin/python3", me, "--phase-dangle"]).returncode == 0:
        pass                                       # repeat until a pass removes nothing
    os.remove(PCB + ".nets")
    subprocess.run(["/usr/bin/python3", me, "--phase-place"] + args, check=True)


if __name__ == "__main__":
    if sys.argv[1] == "--phase-strip":
        strip(sys.argv[2:])
    elif sys.argv[1] == "--phase-dangle":
        dangle()
    elif sys.argv[1] == "--phase-place":
        place(sys.argv[2:])
    else:
        main(sys.argv[1:])
