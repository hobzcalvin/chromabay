#!/bin/sh
# Re-download symbols, footprints and 3D models (incl. STEP) for every LCSC part in design.py.
# Needs: pip install easyeda2kicad. The repo only keeps the small .wrl models.
cd "$(dirname "$0")/../lib" || exit 1
for c in $(python3 -c "import sys; sys.path.insert(0, '../tools'); import design; print(' '.join(sorted({p['lcsc'] for p in design.parts if p['lcsc']})))"); do
  easyeda2kicad --full --lcsc_id="$c" --output ./lcsc --overwrite >/dev/null 2>&1 && echo "ok $c" || echo "FAILED $c"
done
# easyeda2kicad assigns random electrical pin types; make them passive so ERC is meaningful.
sed -i -E 's/\(pin (input|output|bidirectional|tri_state|unspecified|power_in|power_out|open_collector|open_emitter|free|no_connect) /(pin passive /' lcsc.kicad_sym
kicad-cli sym upgrade --force lcsc.kicad_sym
# NOTE: re-downloading overwrites two local footprint fixes (locating pegs -> NPTH, boost
# thermal vias numbered 21). Re-apply them or run: git checkout lib/lcsc.pretty
