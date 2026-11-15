#!/usr/bin/env python3
"""Write JLCPCB assembly files: fab/bom-jlc.csv and fab/cpl-jlc.csv (from design.py + the PCB).

    python3 tools/jlc_files.py      (needs kicad-cli on PATH)
"""
import collections
import csv
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import design  # noqa: E402

FAB = os.path.join(BOARD, "fab")
os.makedirs(FAB, exist_ok=True)

groups = collections.OrderedDict()
for p in design.parts:
    if not p["lcsc"] or p["dnp"]:
        continue
    key = (p["value"], p["footprint"].split(":", 1)[1], p["lcsc"])
    groups.setdefault(key, []).append(p["ref"])
with open(os.path.join(FAB, "bom-jlc.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for (value, fp, lcsc), refs in groups.items():
        w.writerow([value, ",".join(refs), fp, lcsc])

with tempfile.TemporaryDirectory() as tmp:
    pos = os.path.join(tmp, "pos.csv")
    subprocess.run(["kicad-cli", "pcb", "export", "pos", "--format", "csv", "--units", "mm",
                    "--side", "front", "--exclude-dnp", "-o", pos,
                    os.path.join(BOARD, "chromabay-controller.kicad_pcb")], check=True,
                   capture_output=True)
    rows = list(csv.DictReader(open(pos)))
assembled = {r for refs in groups.values() for r in refs}
with open(os.path.join(FAB, "cpl-jlc.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for r in rows:
        if r["Ref"] in assembled:
            w.writerow([r["Ref"], r["PosX"] + "mm", r["PosY"] + "mm", "Top", r["Rot"]])
print(f"bom: {len(groups)} lines, cpl: {len(assembled)} placements -> {FAB}")
print("Check part rotations in JLC's preview before ordering (easyeda footprints usually match).")
