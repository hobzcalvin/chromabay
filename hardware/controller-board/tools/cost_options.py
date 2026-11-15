#!/usr/bin/env python3
"""What each optional feature costs, per board, at a given order size (live JLC prices).

    python3 tools/cost_options.py [qty]     (default 10)

Each option lists the parts it removes (refs from design.py) and parts it adds (LCSC code, count).
"Fee" is JLC's $3.07 per-order loading fee for an Extended part, which disappears only when no
other part on the board uses the same LCSC code.
"""
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import design  # noqa: E402
from jlc_lookup import kind, price_at, search  # noqa: E402

EXT_FEE, SETUP, STENCIL, JOINT = 3.07, 8.18, 1.53, 0.0016
_cache = {}


def info(code):
    if code not in _cache:
        _cache[code] = search(code, 1)[0]
    return _cache[code]


def board_cost(parts, qty):
    counts = collections.Counter(p["lcsc"] for p in parts if p["lcsc"] and not p["dnp"])
    parts_cost = sum(price_at(info(c), n * qty) * n for c, n in counts.items())
    ext = [c for c in counts if kind(info(c)) == "EXTENDED"]
    joints = sum(len(p["pins"]) for p in parts if p["lcsc"] and not p["dnp"])
    fees = SETUP + STENCIL + EXT_FEE * len(ext) + JOINT * joints * qty
    return parts_cost, fees


OPTIONS = [  # (name, refs removed, [(lcsc, count) added], note)
    ("Fuel gauge -> voltage divider on an ADC pin", ["U4"], [("C25744", 2)], "battery % from voltage only (+-10-15% under LED load)"),
    ("Drop the IMU (accel + gyro)", ["U5"], [], "no motion/tap/wake-on-shake"),
    ("IMU -> LIS2DH12 accel only", ["U5"], [("C110926", 1)], "no gyro; same wake-on-motion"),
    ("Drop the onboard mic", ["MK1", "JP7"], [], "external I2S mic pads still work"),
    ("Drop output ESD (2x SRV05-4)", ["U9", "U10"], [], "hot-plugging strips gets riskier"),
    ("Drop the JST-PH (pads only)", ["J4"], [], "no plug-and-play battery"),
    ("Drop the WAGO push-in terminals (pads only)", ["J2", "J6"], [], "no solder-free LED wiring"),
    ("Drop reverse-polarity FET", ["Q1"], [], "a backwards pack can kill the charger; not recommended"),
]


def main(qty):
    by_ref = {p["ref"]: p for p in design.parts}
    base_parts, base_fees = board_cost(design.parts, qty)
    base = base_parts + base_fees / qty
    print(f"Baseline at qty {qty}: parts ${base_parts:.2f}/board + fees ${base_fees:.2f}/order "
          f"= ${base:.2f}/board (PCBA only)\n")
    print(f"{'option':48} {'parts':>7} {'fees/ord':>9} {'per board':>10}  note")
    for name, removed, added, note in OPTIONS:
        parts = [p for p in design.parts if p["ref"] not in removed]
        for code, n in added:
            for i in range(n):
                parts.append(dict(ref=f"ADD{code}{i}", lcsc=code, pins={"1": "x", "2": "y"}, dnp=False))
        pc, fe = board_cost(parts, qty)
        d_parts, d_fees = pc - base_parts, fe - base_fees
        print(f"{name:48} {d_parts:>+7.2f} {d_fees:>+9.2f} {d_parts + d_fees / qty:>+10.2f}  {note}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
