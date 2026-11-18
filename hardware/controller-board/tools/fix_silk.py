#!/usr/bin/python3
"""Nudge the user-header pin labels off vias and pads (routed board, nothing else moves).

    /usr/bin/python3 tools/fix_silk.py

For each header label that sits on a via hole or an exposed pad, try small moves (up to 0.6 mm,
staying beside its own pin) and slightly smaller text, and keep the closest clear spot. Labels that
still collide are listed (the caller can then move the via). Tracks under silk are fine: they are
under solder mask.
"""
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
sys.path.insert(0, HERE)
import design  # noqa: E402

MM, TO = pcbnew.FromMM, pcbnew.ToMM


def main():
    b = pcbnew.LoadBoard(PCB)
    labels = set(design.HEADER_LABELS.values())
    hdr = b.FindFootprintByReference("J7")
    pad_pos = {}
    for p in hdr.Pads():
        pad_pos.setdefault(design.HEADER_LABELS[[n for n in [p.GetNetname().lstrip("/")]][0]]
                           if p.GetNetname().lstrip("/") in design.HEADER_LABELS else None, []).append(p.GetPosition())
    obstacles = []                       # boxes silk must not touch: via holes+ring, exposed pads
    for t in b.GetTracks():
        if t.GetClass() == "PCB_VIA":
            bb = t.GetBoundingBox()       # via pad: the ring already keeps ink 0.1 mm off the hole
            bb.Inflate(MM(0.04))
            obstacles.append(bb)
    for f in b.GetFootprints():
        for p in f.Pads():
            if p.IsOnLayer(pcbnew.F_Cu) or p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                bb = p.GetBoundingBox()
                bb.Inflate(MM(0.04))     # text boxes are already a bit bigger than the ink
                obstacles.append(bb)
    texts = [t for t in b.GetDrawings() if t.GetClass() == "PCB_TEXT" and t.GetLayer() == pcbnew.F_SilkS]
    for f in b.GetFootprints():          # other parts' silkscreen outlines
        for g in f.GraphicalItems():
            if g.GetClass() != "PCB_TEXT" and g.GetLayer() == pcbnew.F_SilkS and f.GetReference() != "J7":
                obstacles.append(g.GetBoundingBox())
    ylabels = [t for t in texts if t.GetText() in labels and hdr.GetBoundingBox().Intersects(t.GetBoundingBox())
               or (t.GetText() in labels and abs(TO(t.GetPosition().y) - TO(hdr.GetPosition().y)) < 5)]

    def clear(t):
        bb = t.GetBoundingBox()
        if any(bb.Intersects(o) for o in obstacles):
            return False
        return not any(o is not t and bb.Intersects(o.GetBoundingBox()) for o in texts)

    left = []
    for t in ylabels:
        if clear(t):
            continue
        x0, y0 = t.GetPosition().x, t.GetPosition().y
        size0 = t.GetTextSize()
        best = None
        for h in (0.6, 0.5):            # 0.5 mm is the smallest that prints legibly
            t.SetTextSize(pcbnew.VECTOR2I(MM(h * 0.7), MM(h)))
            t.SetTextThickness(MM(0.1 if h > 0.5 else 0.09))
            top = TO(t.GetPosition().y) < TO(hdr.GetPosition().y) - 1.0   # label above the top row
            # move along the column, mostly away from the pin (down for bottom-row labels)
            for dy in [i * 0.025 for i in (range(-44, 13) if top else range(-12, 45))]:
                for dx in [i * 0.1 for i in range(-7, 8)]:
                    t.SetPosition(pcbnew.VECTOR2I(x0 + MM(dx), y0 + MM(dy)))
                    if clear(t):
                        cost = abs(dx) + 2 * abs(dy) + (0.6 - h) * 4
                        if abs(dx) > 0.6 + 1e-6:
                            continue
                        if best is None or cost < best[0]:
                            best = (cost, dx, dy, h)
        if best:
            _, dx, dy, h = best
            t.SetTextSize(pcbnew.VECTOR2I(MM(h * 0.7), MM(h)))
            t.SetTextThickness(MM(0.1 if h > 0.5 else 0.09))
            t.SetPosition(pcbnew.VECTOR2I(x0 + MM(dx), y0 + MM(dy)))
            print(f"moved {t.GetText():5} dx {dx:+.1f} dy {dy:+.2f} size {h}")
        else:
            t.SetTextSize(size0)
            t.SetPosition(pcbnew.VECTOR2I(x0, y0))
            left.append(t.GetText())
    pcbnew.SaveBoard(PCB, b)
    print("still blocked:", left or "none")


if __name__ == "__main__" and "--vias" not in sys.argv and "--jumpers" not in sys.argv:
    main()


def move_vias(names=("MBCK", "IO46"), max_mm=0.9):
    """Move the vias under the given labels (with their track ends) to the nearest spot that clears
    the label and every other net's copper by 0.15 mm."""
    b = pcbnew.LoadBoard(PCB)
    CL = MM(float(os.environ.get("VIA_CL", "0.15")))
    for t in [t for t in b.GetDrawings() if t.GetClass() == "PCB_TEXT" and t.GetText() in names
              and t.GetLayer() == pcbnew.F_SilkS]:
        lb = t.GetBoundingBox()
        lb.Inflate(MM(0.08))
        for v in [v for v in b.GetTracks() if v.GetClass() == "PCB_VIA" and lb.Intersects(v.GetBoundingBox())]:
            p0 = v.GetPosition()
            att = [(x, x.GetStart() == p0) for x in b.GetTracks()
                   if x.GetClass() == "PCB_TRACK" and x.GetNetname() == v.GetNetname()
                   and (x.GetStart() == p0 or x.GetEnd() == p0)]
            others = [o for o in b.GetTracks() if o.GetNetname() != v.GetNetname()]
            pads = [p for f in b.GetFootprints() for p in f.Pads() if p.GetNetname() != v.GetNetname()]

            def ok():
                if v.GetBoundingBox().Intersects(lb):
                    return False
                items = [v] + [x for x, _ in att]
                for it in items:
                    for L in (pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu):
                        if not it.IsOnLayer(L):
                            continue
                        sh = it.GetEffectiveShape(L)
                        for o in others:
                            if o.IsOnLayer(L) and o.GetEffectiveShape(L).Collide(sh, CL):
                                return False
                        for p in pads:
                            if p.IsOnLayer(L) and p.GetEffectiveShape(L).Collide(sh, CL):
                                return False
                return True

            best = None
            steps = int(max_mm / 0.05)
            for i in range(-steps, steps + 1):
                for j in range(-steps, steps + 1):
                    d = (i * i + j * j) ** 0.5 * 0.05
                    if d > max_mm or (best and d >= best[0]):
                        continue
                    q = pcbnew.VECTOR2I(p0.x + MM(i * 0.05), p0.y + MM(j * 0.05))
                    v.SetPosition(q)
                    for x, st in att:
                        (x.SetStart if st else x.SetEnd)(q)
                    if ok():
                        best = (d, q)
            q = best[1] if best else p0
            v.SetPosition(q)
            for x, st in att:
                (x.SetStart if st else x.SetEnd)(q)
            print(f"{t.GetText():5} via {v.GetNetname():8}", f"moved {best[0]:.2f} mm" if best else "NOT moved")
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(PCB, b)


if __name__ == "__main__" and "--vias" in sys.argv:
    move_vias(max_mm=float(os.environ.get("VIA_MAX", "0.9")))


JUMPER_LABELS = {"+0.45A": ["JP1"], "+1A": ["JP2"], "CHG": ["JP1", "JP2"], "NTC": ["JP3"], "SW": ["JP4"],
                 "EXT5V": ["JP5"], "MIC": ["JP7"]}


def fix_jumper_labels():
    """Put each solder-jumper label right beside its jumper(s), clear of vias, pads, part
    outlines and other text (searching outward from the jumper)."""
    import math
    b = pcbnew.LoadBoard(PCB)
    obstacles = []
    for t in b.GetTracks():
        if t.GetClass() == "PCB_VIA":
            bb = t.GetBoundingBox()
            bb.Inflate(MM(0.04))
            obstacles.append(bb)
    for f in b.GetFootprints():
        for p in f.Pads():
            if p.IsOnLayer(pcbnew.F_Cu) or p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                bb = p.GetBoundingBox()
                bb.Inflate(MM(0.06))
                obstacles.append(bb)
        for g in f.GraphicalItems():
            if g.GetClass() != "PCB_TEXT" and g.GetLayer() == pcbnew.F_SilkS:
                bb = g.GetBoundingBox()
                bb.Inflate(MM(0.04))
                obstacles.append(bb)
    texts = [t for t in b.GetDrawings() if t.GetClass() == "PCB_TEXT" and t.GetLayer() == pcbnew.F_SilkS]
    edge = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(edge)
    edge.Deflate(MM(0.2), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))
    done = []
    for text, refs in JUMPER_LABELS.items():
        fps = [b.FindFootprintByReference(r) for r in refs]
        bb = fps[0].GetBoundingBox(False, False)
        for f in fps[1:]:
            bb.Merge(f.GetBoundingBox(False, False))
        cx, cy = bb.Centre().x, bb.Centre().y
        cands = [t for t in texts if t.GetText() == text]
        if not cands:
            continue
        t = min(cands, key=lambda t: (t.GetPosition() - bb.Centre()).EuclideanNorm())

        def clear():
            tb = t.GetBoundingBox()
            if any(tb.Intersects(o) for o in obstacles):
                return False
            if any(o is not t and o not in done and tb.Intersects(o.GetBoundingBox()) for o in texts):
                return False
            if any(tb.Intersects(o.GetBoundingBox()) for o in done):
                return False
            return all(edge.Contains(pcbnew.VECTOR2I(x, y)) for x in (tb.GetLeft(), tb.GetRight())
                       for y in (tb.GetTop(), tb.GetBottom()))

        near = TO((t.GetPosition() - bb.Centre()).EuclideanNorm()) < 0.6 * TO(max(bb.GetWidth(), bb.GetHeight())) + 1.5
        if near and clear():
            done.append(t)
            continue
        best = None
        for h in (0.55, 0.5):
            t.SetTextSize(pcbnew.VECTOR2I(MM(h * 0.82), MM(h)))
            t.SetTextThickness(MM(0.1))
            for ang in (0, 90):
                t.SetTextAngleDegrees(ang)
                for r10 in range(0, 45):
                    r = r10 * 0.1
                    if best and r >= best[0]:
                        break
                    n = max(8, int(2 * math.pi * r / 0.2))
                    for k in range(n):
                        a = 2 * math.pi * k / n
                        # walk out from the jumper's edge, not its centre
                        ex = TO(bb.GetWidth()) / 2 + r
                        ey = TO(bb.GetHeight()) / 2 + r
                        t.SetPosition(pcbnew.VECTOR2I(cx + MM(ex * math.cos(a)), cy + MM(ey * math.sin(a))))
                        if clear():
                            best = (r + (0.55 - h), t.GetPosition(), h, ang)
                            break
        if best:
            _, pos, h, ang = best
            t.SetTextSize(pcbnew.VECTOR2I(MM(h * 0.82), MM(h)))
            t.SetTextAngleDegrees(ang)
            t.SetPosition(pos)
            done.append(t)
            print(f"jumper label {text:6} placed by {'/'.join(refs)}")
        else:
            print(f"jumper label {text:6} NO SPOT")
    pcbnew.SaveBoard(PCB, b)


if __name__ == "__main__" and "--jumpers" in sys.argv:
    fix_jumper_labels()
