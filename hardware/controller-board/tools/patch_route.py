#!/usr/bin/python3
"""Finish the few connections the autorouter leaves: a small grid maze router (A*) per gap.

    /usr/bin/python3 tools/patch_route.py drc-report.rpt

Reads the `unconnected_items` pairs from a KiCad DRC report (kicad-cli pcb drc), and for each pair
searches a path on F.Cu / In2.Cu / B.Cu (vias allowed; In1 is the GND plane) that clears every
other net's copper, then adds the tracks and vias and saves the board. Pairs it can't solve are
listed. Re-run DRC afterwards.
"""
import heapq
import math
import os
import re
import sys

import numpy as np
import pcbnew
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(os.path.dirname(HERE), "chromabay-controller.kicad_pcb")
MM, TO = pcbnew.FromMM, pcbnew.ToMM
G = 0.05                     # grid, mm
CLEAR = 0.21                # 0.13-0.15 rule + grid/raster margin
VIA_D, VIA_DR = 0.45, 0.25
LAYERS = [pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]
RIPUP = "--rip" in sys.argv     # rip-up mode tends to thrash in the dense charger corner
POWER = {"/VBUS", "/VSYS", "/BAT", "/BAT_IN", "/5V_BOOST", "/VLED", "/VLED_SW", "/VLED_F",
         "/CHG_PMID", "/CHG_SW", "/BST_SW"}


def pairs_from_report(path):
    txt = open(path).read()
    out = []
    for block in txt.split("[unconnected_items]")[1:]:
        pts = re.findall(r"@\(([\d.]+) mm, ([\d.]+) mm\): (.*)", block)[:2]
        if len(pts) == 2:
            net = re.search(r"\[(/[^\]]+)\]", pts[0][2])
            out.append((net.group(1) if net else None,
                        [(float(x), float(y), d) for x, y, d in pts]))
    return out


def snap_zone_endpoints(board, netname, a, b):
    """DRC reports a pour by its first outline corner. Replace that with the point of the pour's
    filled copper nearest the other end, pulled 0.25 mm inside, so the patch joins real copper."""
    def fix(p, other):
        if not p[2].startswith("Zone"):
            return p
        best = None
        for zi in range(board.GetAreaCount()):
            z = board.GetArea(zi)
            if z.GetIsRuleArea() or z.GetNetname() != netname:
                continue
            lay = z.GetLayer()
            if layer_of(p[2]) not in (None, lay):
                continue
            fp = z.GetFilledPolysList(lay)
            tgt = pcbnew.VECTOR2I(MM(other[0]), MM(other[1]))
            for oi in range(fp.OutlineCount()):
                ol = fp.Outline(oi)
                q = ol.NearestPoint(tgt)
                d = math.hypot(TO(q.x) - other[0], TO(q.y) - other[1])
                if best is None or d < best[0]:
                    # step inside: towards the outline's bounding-box centre
                    bb = ol.BBox()
                    cx, cy = TO(bb.Centre().x), TO(bb.Centre().y)
                    qx, qy = TO(q.x), TO(q.y)
                    L = math.hypot(cx - qx, cy - qy) or 1
                    best = (d, qx + 0.25 * (cx - qx) / L, qy + 0.25 * (cy - qy) / L, lay)
        if best is None:
            return p
        name = {pcbnew.F_Cu: "F.Cu", pcbnew.In2_Cu: "In2.Cu", pcbnew.B_Cu: "B.Cu"}.get(best[3], "")
        return (best[1], best[2], "Zone on " + name)
    return fix(a, b), fix(b, a)


def layer_of(desc):
    for name, l in (("F.Cu", pcbnew.F_Cu), ("In2.Cu", pcbnew.In2_Cu), ("B.Cu", pcbnew.B_Cu)):
        if "on " + name in desc:
            return l
    return None   # through-hole pad / via: any layer


def route_pair(board, netname, a, b, width, allow_rip=False):
    margin = 4.0
    x0, y0 = min(a[0], b[0]) - margin, min(a[1], b[1]) - margin
    x1, y1 = max(a[0], b[0]) + margin, max(a[1], b[1]) + margin
    nx, ny = int((x1 - x0) / G) + 1, int((y1 - y0) / G) + 1
    infl = CLEAR + width / 2
    vinfl = CLEAR + VIA_D / 2
    blocked, soft = {}, {}
    vblocked = np.zeros((ny, nx), bool)
    vsoft = np.zeros((ny, nx), bool)
    edge = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(edge)
    edge.Deflate(MM(0.35 + width / 2), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))

    def px(v):
        return ((TO(v) - x0) / G)

    def py(v):
        return ((TO(v) - y0) / G)

    for layer in LAYERS + [pcbnew.In1_Cu]:
        img = Image.new("1", (nx, ny), 0)
        d = ImageDraw.Draw(img)
        vimg = Image.new("1", (nx, ny), 0)
        vd = ImageDraw.Draw(vimg)
        simg = Image.new("1", (nx, ny), 0)
        sd = ImageDraw.Draw(simg)
        svimg = Image.new("1", (nx, ny), 0)
        svd = ImageDraw.Draw(svimg)
        for t in board.GetTracks():
            if t.GetNetname() == netname:
                continue
            if t.GetClass() == "PCB_TRACK" and t.GetLayer() == layer:
                # other nets' tracks can be ripped up (at a cost); GND fan-out stubs can't
                hard = t.GetNetname() == "/GND"
                for dd, inf in (((d, infl), (vd, vinfl)) if hard else ((sd, infl), (svd, vinfl))):
                    w = (TO(t.GetWidth()) / 2 + inf) / G
                    dd.line([px(t.GetStart().x), py(t.GetStart().y), px(t.GetEnd().x), py(t.GetEnd().y)],
                            fill=1, width=max(1, int(2 * w)))
                    for p in (t.GetStart(), t.GetEnd()):
                        dd.ellipse([px(p.x) - w, py(p.y) - w, px(p.x) + w, py(p.y) + w], fill=1)
            elif t.GetClass() == "PCB_VIA" and layer != pcbnew.In1_Cu:
                for dd, inf in ((d, infl), (vd, vinfl)):
                    r = (TO(t.GetWidth(pcbnew.F_Cu)) / 2 + inf) / G
                    dd.ellipse([px(t.GetPosition().x) - r, py(t.GetPosition().y) - r,
                                px(t.GetPosition().x) + r, py(t.GetPosition().y) + r], fill=1)
        for fp in board.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() == netname or not p.IsOnLayer(layer):
                    continue
                if layer == pcbnew.In1_Cu and p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD:
                    continue
                for dd, inf in ((d, infl), (vd, vinfl)):
                    poly = pcbnew.SHAPE_POLY_SET()
                    p.TransformShapeToPolygon(poly, layer, MM(inf), MM(0.01), pcbnew.ERROR_OUTSIDE)
                    for oi in range(poly.OutlineCount()):
                        ol = poly.Outline(oi)
                        pts = [(px(ol.CPoint(i).x), py(ol.CPoint(i).y)) for i in range(ol.PointCount())]
                        if len(pts) >= 3:
                            dd.polygon(pts, fill=1)
        # other nets' power pours (not the GND pours: those just get carved around new copper)
        for zi in range(board.GetAreaCount()):
            z = board.GetArea(zi)
            if z.GetIsRuleArea() or z.GetNetname() in (netname, "/GND") or z.GetLayer() != layer:
                continue
            fp = z.GetFilledPolysList(layer)
            for oi in range(fp.OutlineCount()):
                ol = fp.Outline(oi)
                pts = [(px(ol.CPoint(i).x), py(ol.CPoint(i).y)) for i in range(ol.PointCount())]
                if len(pts) >= 3:
                    for dd, inf in ((d, infl), (vd, vinfl)):
                        dd.polygon(pts, fill=1, outline=1)
                        dd.line(pts + pts[:1], fill=1, width=max(1, int(2 * inf / G)))
        arr = np.array(img, bool)
        if layer in LAYERS:
            blocked[layer] = arr
            soft[layer] = np.array(simg, bool)
        vblocked |= np.array(vimg, bool)
        vsoft |= np.array(svimg, bool)
    # outside the board (minus edge clearance) is blocked everywhere
    out = np.zeros((ny, nx), bool)
    for j in range(ny):
        for i in range(nx):
            if not edge.Contains(pcbnew.VECTOR2I(MM(x0 + i * G), MM(y0 + j * G))):
                out[j, i] = True
    for layer in LAYERS:
        blocked[layer] |= out
    vblocked |= out

    def cell(pt):
        return int(round((pt[0] - x0) / G)), int(round((pt[1] - y0) / G))

    sa, sb = cell(a), cell(b)
    la, lb = layer_of(a[2]), layer_of(b[2])
    starts = [(sa[0], sa[1], k) for k, L in enumerate(LAYERS) if la is None or la == L]
    goals = {(sb[0], sb[1], k) for k, L in enumerate(LAYERS) if lb is None or lb == L}
    # clear a small disc around both endpoints on their layers (the pad/track itself is ours)
    for (cx, cy), lay in ((sa, la), (sb, lb)):
        for k, L in enumerate(LAYERS):
            if lay is None or lay == L:
                r = int(0.25 / G)
                blocked[L][max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1] = False
    VIA_COST = 1.2 / G
    RIP = 2.5 / G           # crossing another net's track costs like 2.5 mm of detour
    if not allow_rip:
        for L in LAYERS:
            blocked[L] |= soft[L]
        vblocked[:] |= vsoft
    h = lambda n: math.hypot(n[0] - sb[0], n[1] - sb[1])
    openq = [(h(s), 0.0, s, None) for s in starts]
    heapq.heapify(openq)
    came, cost = {}, {s: 0.0 for s in starts}
    nbr = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    end = None
    while openq:
        f, g, n, parent = heapq.heappop(openq)
        if n in came:
            continue
        came[n] = parent
        if n in goals:
            end = n
            break
        i, j, k = n
        for di, dj, c in nbr:
            m = (i + di, j + dj, k)
            if not (0 <= m[0] < nx and 0 <= m[1] < ny) or blocked[LAYERS[k]][m[1], m[0]] or m in came:
                continue
            ng = g + c + (RIP if soft[LAYERS[k]][m[1], m[0]] else 0)
            if ng < cost.get(m, 1e18):
                cost[m] = ng
                heapq.heappush(openq, (ng + h(m), ng, m, n))
        if not vblocked[j, i]:
            for k2 in range(len(LAYERS)):
                if k2 != k:
                    m = (i, j, k2)
                    if m in came or blocked[LAYERS[k2]][j, i]:
                        continue
                    ng = g + VIA_COST + (RIP if vsoft[j, i] else 0)
                    if ng < cost.get(m, 1e18):
                        cost[m] = ng
                        heapq.heappush(openq, (ng + h(m), ng, m, n))
    if end is None:
        return False
    path = []
    n = end
    while n is not None:
        path.append(n)
        n = came[n]
    path.reverse()
    # snap the exact endpoints, then emit straight runs
    pts = [(x0 + i * G, y0 + j * G, k) for i, j, k in path]
    pts[0] = (a[0], a[1], pts[0][2])
    pts[-1] = (b[0], b[1], pts[-1][2])
    net = board.FindNet(netname)
    new = []
    run = [pts[0]]

    def flush(run):
        # merge collinear points
        simp = [run[0]]
        for p in run[1:]:
            if len(simp) >= 2:
                (ax, ay, _), (bx, by, _) = simp[-2], simp[-1]
                if abs((bx - ax) * (p[1] - by) - (by - ay) * (p[0] - bx)) < 1e-6:
                    simp[-1] = p
                    continue
            simp.append(p)
        for p, q in zip(simp, simp[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(pcbnew.VECTOR2I(MM(p[0]), MM(p[1])))
            t.SetEnd(pcbnew.VECTOR2I(MM(q[0]), MM(q[1])))
            t.SetWidth(MM(width))
            t.SetLayer(LAYERS[p[2]])
            t.SetNet(net)
            board.Add(t)
            new.append(t)

    for p in pts[1:]:
        if p[2] != run[-1][2]:
            flush(run)
            v = pcbnew.PCB_VIA(board)
            v.SetPosition(pcbnew.VECTOR2I(MM(run[-1][0]), MM(run[-1][1])))
            v.SetWidth(MM(VIA_D))
            v.SetDrill(MM(VIA_DR))
            v.SetNet(net)
            board.Add(v)
            new.append(v)
            run = [(run[-1][0], run[-1][1], p[2])]
        run.append(p)
    flush(run)
    # rip up other nets' tracks the new copper now hits; they get re-routed next round
    ripped = set()
    for t in list(board.GetTracks()):
        if t.GetClass() != "PCB_TRACK" or t.GetNetname() in (netname, "/GND"):
            continue
        for n in new:
            if n.GetClass() == "PCB_TRACK" and n.GetLayer() != t.GetLayer():
                continue
            sh = n.GetEffectiveShape(t.GetLayer())
            if t.GetEffectiveShape(t.GetLayer()).Collide(sh, MM(0.15)):
                ripped.add(t.GetNetname())
                board.Remove(t)
                break
    if ripped:
        print("   ripped up", sorted(ripped))
    return True


def drc(path):
    import subprocess
    subprocess.run(["kicad-cli", "pcb", "drc", "--severity-error", "-o", path, PCB],
                   check=True, capture_output=True)
    return open(path).read()


def main(report, rounds=int(os.environ.get("ROUNDS", "6"))):
    import shutil
    best = None
    for rnd in range(rounds):
        txt = drc(report)
        pairs = pairs_from_report(report)
        bad = txt.count("[clearance]") + txt.count("[shorting_items]") + txt.count("[tracks_crossing]")
        print(f"round {rnd}: {len(pairs)} unconnected, {bad} clearance/short errors", flush=True)
        if bad == 0 and (best is None or len(pairs) < best):
            best = len(pairs)
            shutil.copy(PCB, PCB + ".best")
        if not pairs:
            break
        board = pcbnew.LoadBoard(PCB)
        done, failed = set(), []
        for netname, (a, b) in pairs:          # 1) without disturbing anything
            if not netname or netname == "/GND" or netname in done:
                continue
            a, b = snap_zone_endpoints(board, netname, a, b)
            widths = [0.3, 0.2, 0.15] if netname in POWER else [0.15]
            if any(route_pair(board, netname, a, b, w) for w in widths):
                done.add(netname)
                print("  routed", netname)
            else:
                failed.append((netname, a, b))
        for netname, a, b in failed:           # 2) rip up only where nothing else works
            if not RIPUP:
                print("  NO PATH", netname, a[:2], b[:2])
                continue
            if netname in done:
                continue
            if route_pair(board, netname, a, b, 0.15, allow_rip=True):
                done.add(netname)
                print("  routed with rip-up", netname)
            else:
                print("  NO PATH", netname, a[:2], b[:2])
        pcbnew.ZONE_FILLER(board).Fill(board.Zones())
        pcbnew.SaveBoard(PCB, board)
        del board
    if best is not None and not os.environ.get("KEEP_LAST"):
        shutil.copy(PCB + ".best", PCB)
        os.remove(PCB + ".best")
        print("kept the best clean result:", best, "unconnected")





def merge_close_vias(path=PCB):
    """Merge same-net vias whose holes are closer than 0.25 mm (the patcher can drop one next to
    an existing via): keep the locked / larger one and move every track end onto it."""
    board = pcbnew.LoadBoard(path)
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    gone = set()
    merged = 0
    for i, a in enumerate(vias):
        if id(a) in gone:
            continue
        for b in vias[i + 1:]:
            if id(b) in gone or b.GetNetname() != a.GetNetname():
                continue
            d = TO((a.GetPosition() - b.GetPosition()).EuclideanNorm())
            if d >= (TO(a.GetDrill()) + TO(b.GetDrill())) / 2 + 0.25:
                continue
            keep, drop = (a, b) if (a.IsLocked() or a.GetDrill() >= b.GetDrill()) else (b, a)
            for t in board.GetTracks():
                if t.GetClass() != "PCB_TRACK" or t.GetNetname() != keep.GetNetname():
                    continue
                if TO((t.GetStart() - drop.GetPosition()).EuclideanNorm()) < 0.01:
                    t.SetStart(keep.GetPosition())
                if TO((t.GetEnd() - drop.GetPosition()).EuclideanNorm()) < 0.01:
                    t.SetEnd(keep.GetPosition())
            board.Remove(drop)
            gone.add(id(drop))
            merged += 1
            if drop is a:
                break
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(path, board)
    print("merged", merged, "close vias")


if __name__ == "__main__":
    if sys.argv[1] == "--merge-vias":
        merge_close_vias()
    else:
        main(sys.argv[1])
        merge_close_vias()
