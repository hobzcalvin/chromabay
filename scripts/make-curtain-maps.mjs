// Build two WLED-ledmap layouts for two 20x20 curtains, each 270° CW + horizontal flip,
// curtain 2 offset +0.5 unit down & right, interleaved on a 2x (0.5-unit) grid.
//
// Output per curtain: { width:40, height:40, map:[1600 ints] }  (-1 = gap)
// Paste each into Devices → strip → "Paste WLED ledmap" and set the strip's
// orientation to NONE (rotation 0 / no flip / no serpentine) — the transform is baked
// into the map, so any extra orientation would double it.
//
// ASSUMPTIONS (flip these constants if your curtain is wired differently):
import { writeFileSync } from 'node:fs';
const N = 20;                 // 20x20 per curtain
const SERPENTINE = false;     // true = boustrophedon (alternate rows reverse)
const START = 'TL';           // LED 0 corner before rotation: TL/TR/BL/BR
const ROW_MAJOR = true;       // true = index runs along rows (x fastest); false = along columns

// --- native wiring: LED index n -> native cell (nx, ny), x right / y down ---
function nativeCell(n) {
  let major = ROW_MAJOR ? Math.floor(n / N) : (n % N);     // which row (row-major) / col
  let minor = ROW_MAJOR ? (n % N) : Math.floor(n / N);     // position within it
  if (SERPENTINE && (major % 2 === 1)) minor = N - 1 - minor;
  let x = ROW_MAJOR ? minor : major;
  let y = ROW_MAJOR ? major : minor;
  if (START === 'TR' || START === 'BR') x = N - 1 - x;
  if (START === 'BL' || START === 'BR') y = N - 1 - y;
  return [x, y];
}

// --- orientation: 270° clockwise, then horizontal flip ---
const rot90cw = ([x, y]) => [N - 1 - y, x];               // (x,y) -> (N-1-y, x)
const flipH   = ([x, y]) => [N - 1 - x, y];
function oriented(n) {
  let p = nativeCell(n);
  p = rot90cw(rot90cw(rot90cw(p)));                        // 270° CW = three 90° CW
  p = flipH(p);
  return p;                                                // (ox, oy) in [0,N)
}

// --- place on the combined 2x grid; curtain 2 shifted +1 cell (=+0.5 unit) ---
const ROTATE_180 = true;                                  // rotate the whole combined image 180° (confirmed correct)
// Curtain 2's offset from curtain 1, in 2× grid cells, in the FINAL displayed frame
// (x = right, y = down). Half-unit UP and RIGHT = (+1, -1).
const OFF = { x: +1, y: -1 };

// Raw final cell of LED n for a curtain, on the 2× grid (pre-normalization).
function rawCell(n, curtain) {
  let [ox, oy] = oriented(n);
  let gx = 2 * ox, gy = 2 * oy;                           // curtain footprint on the 2× grid
  if (ROTATE_180) { gx = 2 * N - 1 - gx; gy = 2 * N - 1 - gy; }
  if (curtain === 1) { gx += OFF.x; gy += OFF.y; }
  return [gx, gy];
}

// Size the grid to the tight bounding box across BOTH curtains so the offset direction
// doesn't matter and both maps share identical W×H.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const c of [0, 1]) for (let n = 0; n < N * N; n++) {
  const [gx, gy] = rawCell(n, c);
  if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
  if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
}
const W = maxX - minX + 1, H = maxY - minY + 1;
function buildMap(curtain /* 0 or 1 */) {
  const map = new Array(W * H).fill(-1);
  for (let n = 0; n < N * N; n++) {
    const [gx, gy] = rawCell(n, curtain);
    map[(gy - minY) * W + (gx - minX)] = n;
  }
  return map;
}

const c1 = buildMap(0), c2 = buildMap(1);
const out1 = { width: W, height: H, map: c1 };
const out2 = { width: W, height: H, map: c2 };
writeFileSync('scratchpad/curtain1-ledmap.json', JSON.stringify(out1));
writeFileSync('scratchpad/curtain2-ledmap.json', JSON.stringify(out2));

// --- sanity report ---
const cnt = (m) => m.filter((v) => v >= 0).length;
const distinct = (m) => new Set(m.filter((v) => v >= 0)).size;
console.log(`grid ${W}x${H} = ${W * H} cells`);
console.log(`curtain1: ${cnt(c1)} placed, ${distinct(c1)} distinct LEDs (expect 400/400)`);
console.log(`curtain2: ${cnt(c2)} placed, ${distinct(c2)} distinct LEDs (expect 400/400)`);
// overlap check: no cell used by both
let overlap = 0; for (let i = 0; i < W * H; i++) if (c1[i] >= 0 && c2[i] >= 0) overlap++;
console.log(`cells used by BOTH curtains: ${overlap} (expect 0)`);
// preview top-left 8x8 cells: '1'=curtain1 '2'=curtain2 '.'=gap
let pv = '';
for (let y = 0; y < 8; y++) { let row = ''; for (let x = 0; x < 8; x++) { const i = y * W + x; row += c1[i] >= 0 ? '1 ' : c2[i] >= 0 ? '2 ' : '. '; } pv += row + '\n'; }
console.log('top-left 8x8 (1=curtain1, 2=curtain2, .=gap):\n' + pv);
// show where LED 0 and LED 19 (end of native first row) land, oriented
console.log('LED 0  oriented ->', oriented(0), ' LED 19 ->', oriented(19), ' LED 380 ->', oriented(380));
