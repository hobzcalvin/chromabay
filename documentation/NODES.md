# Low-level nodes

Fifteen small operators meant to be combined, for building effects from parts rather than
picking a finished look. Several follow [hydra](https://hydra.ojack.xyz)'s vocabulary (osc,
shape, voronoi, kaleid, thresh, modulate, shift, colorama), the Quasicrystal generator follows
[hypnagogic quasicrystals](https://hypnagogic-quasicrystals.github.io), and Particles follows
WLED's particle-system effects. All are resolution-independent: coordinates are measured
against the display's long side, so a pattern looks the same on a 16×16 and a 64×32 matrix, and
a 1-row strip shows a slice through the middle.

## Generators

| Node | What it makes | Typical use |
|---|---|---|
| **Oscillator** (`osc`) | Sine/triangle/saw/square stripes per colour channel; *Colour offset* splits R, G, B into rainbow bands | Raw periodic signal: a warp map for Displace, stripes for Threshold, grey for Gradient Map |
| **Shape** (`shape`) | One circle or regular polygon (filled or outline), soft edge, spin | A mask (Blend → Multiply), a sprite to Tile or Kaleidoscope |
| **Solid Colour** (`solid`) | A constant colour | The second input of a Blend: tint, floor, multiply down |
| **Voronoi** (`voronoi`) | Drifting cells, as flat colours, a distance field, or glowing borders | Stained glass, cell borders, an organic map for Displace |
| **Quasicrystal** (`quasicrystal`) | Sum of N plane waves at even angles; 5 or 7 waves never repeat | Slow hypnotic rosettes; mono mode for a grey source |
| **Pinwheel** (`pinwheel`) | N spinning arms, optional twist into a spiral | Spirals, radar sweeps, a rotating mask |
| **Particles** (`particles`) | Fountain, fireworks, snow, or sparks, with gravity, life and trails | Motion that isn't a field |

## Modifiers (one input)

| Node | What it does |
|---|---|
| **Kaleidoscope** (`kaleid`) | Folds the input into N mirrored wedges around a centre; spin and zoom |
| **Pixelate** (`pixelate`) | Snaps to a coarse grid of blocks (averaged or centre-sampled) |
| **Threshold** (`threshold`) | Splits by brightness: a white/black mask, or a luma key that keeps colour |
| **Colour Adjust** (`coloradjust`) | Brightness, contrast, saturation, gamma, R/G/B gains |
| **Polar Warp** (`polar`) | Tunnel (x wraps round the centre, y runs outward, with flow) or the inverse unwrap |
| **RGB Split** (`rgbsplit`) | Chromatic aberration: R and B shifted apart, optional wobble |
| **Gradient Map** (`gradmap`) | Recolours by brightness through three chosen colours; Shift cycles them |

## Two inputs

| Node | What it does |
|---|---|
| **Displace** (`displace`) | Warps input 1 by input 2: R/G as an x/y vector, brightness as a lens, or brightness as a swirl |

## Recipes

- **Liquid**: Plasma → Displace input 1; Oscillator (offset 0.3) → Displace input 2.
- **Neon tunnel**: Oscillator (square) → Polar Warp (tunnel, flow 0.5) → Gradient Map.
- **Stained glass**: Voronoi (cells) → Blend (Multiply) with Voronoi (edges) inverted by Threshold.
- **Mandala**: Perlin Noise → Kaleidoscope (8 segments, spin 0.05) → Colour Adjust (contrast 1.6).
- **Shape mask**: any pattern → Blend input 1, Shape → Blend input 2, mode Multiply.

`src/lib/tests/operators.test.ts` renders every operator in the WASM engine at its defaults
and checks that the editor's input count for it matches what it reads.
