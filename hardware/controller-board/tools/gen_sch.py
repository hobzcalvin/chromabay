#!/usr/bin/env python3
"""Generate chromabay-controller.kicad_sch from design.py.

Layout style: every symbol pin gets a short wire stub and a net label, and parts are grouped by
functional block with a title. It reads like a netlist-driven schematic (as most generated
schematics do) and is fully editable in KiCad afterwards.
"""
import os
import uuid

import design
from sexpr import Sym, dump, find, first, parse

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.dirname(HERE)
PROJECT = "chromabay-controller"
KICAD_SYM = "/usr/share/kicad/symbols"
LIBS = {
    "lcsc": os.path.join(BOARD, "lib", "lcsc.kicad_sym"),
    **{n: f"{KICAD_SYM}/{n}.kicad_sym" for n in
       ["Device", "Jumper", "Connector", "Connector_Generic", "Mechanical", "power"]},
}
NS = uuid.UUID("6f1d3c2a-5b7e-4c1a-9d2e-0c4b8a7f3e21")


def uid(*key):
    return str(uuid.uuid5(NS, "/".join(map(str, key))))


ROOT = uid("root")
_lib_cache = {}


def load_lib(nick):
    if nick not in _lib_cache:
        tree = parse(open(LIBS[nick], encoding="utf-8").read())
        _lib_cache[nick] = {s[1]: s for s in find(tree, "symbol")}
    return _lib_cache[nick]


def lib_symbol(lib_id):
    """Return a flattened copy of the symbol, renamed to lib_id, for lib_symbols."""
    nick, name = lib_id.split(":", 1)
    lib = load_lib(nick)
    sym = lib[name]
    ext = first(sym, "extends")
    if ext:
        parent = lib[ext[1]]
        props = {p[1]: p for p in find(sym, "property")}
        body = []
        for x in parent[2:]:
            if isinstance(x, list) and x[0] == "property" and x[1] in props:
                body.append(props.pop(x[1]))
            elif isinstance(x, list) and x[0] == "symbol":
                body.append([Sym("symbol"), x[1].replace(ext[1], name, 1)] + x[2:])
            else:
                body.append(x)
        body += list(props.values())
        sym = [Sym("symbol"), name] + body
    out = [Sym("symbol"), lib_id] + sym[2:]
    if nick == "lcsc":
        # easyeda2kicad marks pins Input/Unspecified at random; treat them all as passive so
        # ERC reports real problems (unconnected pins, single-pin nets) instead of noise.
        for unit in find(out, "symbol"):
            for pin in find(unit, "pin"):
                pin[1] = Sym("passive")
    return out


def pins_of(lib_id):
    sym = lib_symbol(lib_id)
    out = {}
    for unit in find(sym, "symbol"):
        parts = unit[1].rsplit("_", 2)
        if len(parts) == 3 and parts[1] not in ("0", "1"):
            continue
        for p in find(unit, "pin"):
            at = first(p, "at")
            num = first(p, "number")[1]
            out.setdefault(num, (float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0))
    return out


def bbox(lib_id):
    xs, ys = [], []
    for x, y, r in pins_of(lib_id).values():
        xs.append(x)
        ys.append(y)
    sym = lib_symbol(lib_id)

    def walk(n):
        if isinstance(n, list):
            if n and n[0] in ("start", "end", "xy", "center") and len(n) >= 3:
                try:
                    xs.append(float(n[1]))
                    ys.append(float(n[2]))
                except ValueError:
                    pass
            for c in n:
                walk(c)
    for unit in find(sym, "symbol"):
        walk(unit)
    if not xs:
        return -2.54, -2.54, 2.54, 2.54
    return min(xs), min(ys), max(xs), max(ys)


def snap(v, g=1.27):
    return round(v / g) * g


def prop(name, value, x, y, hide=False, size=1.27):
    eff = [Sym("effects"), [Sym("font"), [Sym("size"), size, size]]]
    if hide:
        eff.append([Sym("hide"), Sym("yes")])
    return [Sym("property"), name, value, [Sym("at"), x, y, 0], eff]


STUB = 2.54


def build():
    items = []
    lib_ids = sorted({p["symbol"] for p in design.parts} | {"power:PWR_FLAG"})
    lib_symbols = [Sym("lib_symbols")] + [lib_symbol(l) for l in lib_ids]

    # ---- block layout on an A1 sheet
    order = ["usb", "charger", "battery", "gauge", "power", "boost", "loadsw", "shifter",
             "mcu", "leds", "sensors", "pads", "mech"]
    titles = {"usb": "USB-C input", "charger": "Charger + power path (BQ25606)",
              "battery": "Battery input + reverse protection", "gauge": "Fuel gauge",
              "power": "Power switch + 3.3 V", "boost": "5 V LED boost (TPS61088)",
              "loadsw": "LED load switch + output protection",
              "shifter": "Level shifter + LED outputs", "mcu": "ESP32-S3",
              "leds": "Indicators", "sensors": "IMU + microphone", "pads": "User pads",
              "mech": "Mechanical"}
    cells = {}
    col_w, row_h = [205, 205, 205, 205], [200, 190, 175]
    grid = [["usb", "charger", "boost", "mcu"],
            ["battery", "gauge", "loadsw", "shifter"],
            ["power", "leds", "sensors", "pads"]]
    for r, row in enumerate(grid):
        for c, name in enumerate(row):
            cells[name] = (15 + sum(col_w[:c]), 20 + sum(row_h[:r]), col_w[c], row_h[r])
    cells["mech"] = (15 + 3 * 205 + 120, 20 + 390 + 120, 80, 40)

    by_block = {}
    for p in design.parts:
        by_block.setdefault(p["block"], []).append(p)

    for b in order:
        x0, y0, w, h = cells[b]
        items.append([Sym("text"), titles[b], [Sym("exclude_from_sim"), Sym("no")],
                      [Sym("at"), x0, y0, 0],
                      [Sym("effects"), [Sym("font"), [Sym("size"), 3, 3], [Sym("bold"), Sym("yes")]],
                       [Sym("justify"), Sym("left"), Sym("bottom")]], [Sym("uuid"), uid("title", b)]])
        cx, cy, row_max = x0 + 4, y0 + 10, 0
        for p in by_block.get(b, []):
            bx0, by0, bx1, by1 = bbox(p["symbol"])
            labw = max([len(n) for n in p["pins"].values()] + [4]) * 1.05 + STUB + 2
            left, right = -bx0 + labw, bx1 + labw
            top, bottom = by1 + 6, -by0 + 6          # library Y is up; schematic Y is down
            if cx + left + right > x0 + w:
                cx, cy, row_max = x0 + 4, cy + row_max + 4, 0
            sx, sy = snap(cx + left, 2.54), snap(cy + top, 2.54)
            place_symbol(items, p, sx, sy, bx1, by1)
            cx += left + right + 4
            row_max = max(row_max, top + bottom)

    # PWR_FLAGs so ERC knows the supply nets are driven.
    fx, fy = 15 + 3 * 205 + 10, 20 + 390 + 140
    for i, net in enumerate(["VBUS", "GND", "BAT_IN", "VSYS", "3V3", "5V_BOOST", "BAT", "VLED",
                             "MIC_VDD", "VLED_SW", "VLED_F", "CHG_REGN", "BST_VCC",
                             "LDO_EN"]):
        x, y = snap(fx + (i % 5) * 22, 2.54), snap(fy + (i // 5) * 14, 2.54)
        ref = f"#FLG{i + 1:02d}"
        u = uid("flag", net)
        items.append([Sym("symbol"), [Sym("lib_id"), "power:PWR_FLAG"], [Sym("at"), x, y, 0],
                      [Sym("unit"), 1], [Sym("exclude_from_sim"), Sym("no")],
                      [Sym("in_bom"), Sym("yes")], [Sym("on_board"), Sym("yes")],
                      [Sym("dnp"), Sym("no")], [Sym("uuid"), u],
                      prop("Reference", ref, x, y - 3, hide=True),
                      prop("Value", "PWR_FLAG", x, y - 4),
                      prop("Footprint", "", x, y, hide=True), prop("Datasheet", "", x, y, hide=True),
                      [Sym("pin"), "1", [Sym("uuid"), uid("flagpin", net)]],
                      [Sym("instances"), [Sym("project"), PROJECT,
                                          [Sym("path"), "/" + ROOT, [Sym("reference"), ref],
                                           [Sym("unit"), 1]]]]])
        add_label(items, net, x, y, 270, key=("flag", net))

    sch = [Sym("kicad_sch"), [Sym("version"), 20250114], [Sym("generator"), "eeschema"],
           [Sym("generator_version"), "9.0"], [Sym("uuid"), ROOT], [Sym("paper"), "A1"],
           [Sym("title_block"), [Sym("title"), "ChromaBay battery LED controller"],
            [Sym("rev"), "A"], [Sym("company"), "ChromaBay"],
            [Sym("comment"), 1, "Generated by tools/gen_sch.py from tools/design.py - edit design.py, then regenerate"]],
           lib_symbols] + items + [
        [Sym("sheet_instances"), [Sym("path"), "/", [Sym("page"), "1"]]],
        [Sym("embedded_fonts"), Sym("no")]]
    return sch


def add_label(items, net, x, y, angle, key):
    just = {0: "left", 180: "right", 90: "left", 270: "right"}[angle]
    items.append([Sym("label"), net, [Sym("at"), x, y, angle],
                  [Sym("effects"), [Sym("font"), [Sym("size"), 1.27, 1.27]],
                   [Sym("justify"), Sym(just), Sym("bottom")]],
                  [Sym("uuid"), uid("label", *key)]])


def place_symbol(items, p, sx, sy, bx1, by1):
    ref = p["ref"]
    u = uid("sym", ref)
    pins = pins_of(p["symbol"])
    node = [Sym("symbol"), [Sym("lib_id"), p["symbol"]], [Sym("at"), sx, sy, 0], [Sym("unit"), 1],
            [Sym("exclude_from_sim"), Sym("no")], [Sym("in_bom"), Sym("yes" if p["lcsc"] else "no")],
            [Sym("on_board"), Sym("yes")], [Sym("dnp"), Sym("yes" if p["dnp"] else "no")],
            [Sym("uuid"), u],
            prop("Reference", ref, sx, sy - by1 - 2.5),
            prop("Value", p["value"], sx, sy + 2.5 - bbox(p["symbol"])[1]),
            prop("Footprint", p["footprint"], sx, sy, hide=True),
            prop("Datasheet", "", sx, sy, hide=True),
            prop("LCSC", p["lcsc"] or "", sx, sy, hide=True)]
    if p["note"]:
        node.append(prop("Note", p["note"], sx, sy, hide=True))
    for num in pins:
        node.append([Sym("pin"), num, [Sym("uuid"), uid("pin", ref, num)]])
    node.append([Sym("instances"), [Sym("project"), PROJECT,
                                    [Sym("path"), "/" + ROOT, [Sym("reference"), ref],
                                     [Sym("unit"), 1]]]])
    items.append(node)

    for num, (px, py, rot) in pins.items():
        net = p["pins"].get(num)
        ax, ay = sx + px, sy - py
        if net is None or net.startswith("NC"):
            items.append([Sym("no_connect"), [Sym("at"), ax, ay], [Sym("uuid"), uid("nc", ref, num)]])
            continue
        # Outward direction is opposite the pin's own direction.
        dx, dy, ang = {0: (-1, 0, 180), 180: (1, 0, 0), 90: (0, 1, 270), 270: (0, -1, 90)}[int(rot) % 360]
        ex, ey = ax + dx * STUB, ay + dy * STUB
        items.append([Sym("wire"), [Sym("pts"), [Sym("xy"), ax, ay], [Sym("xy"), ex, ey]],
                      [Sym("stroke"), [Sym("width"), 0], [Sym("type"), Sym("default")]],
                      [Sym("uuid"), uid("wire", ref, num)]])
        add_label(items, net, ex, ey, ang, key=(ref, num))


if __name__ == "__main__":
    missing = [(p["ref"], n) for p in design.parts for n in p["pins"]
               if n not in pins_of(p["symbol"])]
    unmapped = [(p["ref"], n) for p in design.parts for n in pins_of(p["symbol"])
                if n not in p["pins"]]
    if missing:
        raise SystemExit(f"design.py names pins the symbols don't have: {missing}")
    if unmapped:
        print("pins left unconnected (no_connect):", unmapped)
    out = os.path.join(BOARD, f"{PROJECT}.kicad_sch")
    with open(out, "w", encoding="utf-8") as f:
        f.write(dump(build()) + "\n")
    print("wrote", out)
