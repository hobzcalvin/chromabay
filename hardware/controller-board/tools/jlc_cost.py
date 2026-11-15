#!/usr/bin/env python3
"""JLCPCB order cost estimate from design.py, with live part prices from JLC's parts API.

    python3 tools/jlc_cost.py [qty ...]        default: 5 10 30

Fees (Economic PCBA, from JLCPCB's help pages, Nov 2026 - re-check before ordering):
setup $8.18, stencil $1.53, $3.07 per unique Extended part (Basic and Preferred-Extended are
free), $0.0016 per solder joint. PCB fabrication, shipping and import duties are NOT included.
"""
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import design  # noqa: E402
from jlc_lookup import kind, price_at, search  # noqa: E402

SETUP, STENCIL, EXT_FEE, JOINT = 8.18, 1.53, 3.07, 0.0016


def main(qtys):
    counts = collections.Counter(p["lcsc"] for p in design.parts if p["lcsc"] and not p["dnp"])
    joints_per_board = sum(len(p["pins"]) for p in design.parts if p["lcsc"] and not p["dnp"])
    info = {}
    for code in counts:
        r = search(code, 1)
        if not r or r[0]["componentCode"] != code:
            raise SystemExit(f"{code} not found at JLC")
        info[code] = r[0]
    ext = sorted(c for c in counts if kind(info[c]) == "EXTENDED")
    print(f"{len(counts)} unique parts, {sum(counts.values())} placements/board, "
          f"~{joints_per_board} joints/board")
    print(f"{len(ext)} unique Extended parts (each ${EXT_FEE}/order):")
    for c in ext:
        p = info[c]
        print(f"   {c:>9} {p['componentModelEn'][:26]:26} x{counts[c]}  ${price_at(p, 10):.3f}")
    print()
    print(f"{'qty':>5} {'parts/board':>12} {'fees/order':>11} {'PCBA/board':>11}   (+ PCB fab, shipping, duty)")
    for q in qtys:
        parts = sum(price_at(info[c], n * q) * n for c, n in counts.items())
        fees = SETUP + STENCIL + EXT_FEE * len(ext) + JOINT * joints_per_board * q
        print(f"{q:>5} {parts:>12.2f} {fees:>11.2f} {parts + fees / q:>11.2f}")
    print()
    print("most expensive lines per board (qty 10):")
    rows = sorted(((price_at(info[c], n * 10) * n, c, n) for c, n in counts.items()), reverse=True)
    for cost, c, n in rows[:10]:
        print(f"   ${cost:5.2f}  {info[c]['componentModelEn'][:28]:28} x{n} ({kind(info[c])})")


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or [5, 10, 30])
