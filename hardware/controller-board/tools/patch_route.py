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
CLEAR = 0.16
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
    edge.Deflate(MM(0.3), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.01))

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
            if t.GetEffectiveShape(t.GetLayer()).Collide(sh, MM(CLEAR - 0.01)):
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


def main(report, rounds=6):
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
    if best is not None:
        shutil.copy(PCB + ".best", PCB)
        os.remove(PCB + ".best")
        print("kept the best clean result:", best, "unconnected")


if __name__ == "__main__":
    main(sys.argv[1])
