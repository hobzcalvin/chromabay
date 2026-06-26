import { describe, it, expect } from 'vitest';
import { buildLedmap, type Pt } from '../autoLayout';

// Build a W×H sequential grid of points (row-major), with optional transforms.
function gridPoints(W: number, H: number, step = 20): Pt[] {
  const pts: Pt[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) pts.push({ x: 50 + c * step, y: 50 + r * step });
  return pts;
}
const rotate = (pts: Pt[], deg: number, cx = 150, cy = 150): Pt[] => {
  const a = (deg * Math.PI) / 180;
  return pts.map((p) => ({ x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a) }));
};
const perspective = (pts: Pt[], k: number, y0 = 50): Pt[] => pts.map((p) => ({ x: 150 + (p.x - 150) * (1 + (k * (p.y - y0)) / 100), y: p.y }));
const jitter = (pts: Pt[], amt: number): Pt[] => pts.map((p, k) => ({ x: p.x + amt * Math.sin(k * 12.9), y: p.y + amt * Math.cos(k * 7.7) }));

// Does the ledmap contain every index 0..n-1 exactly once (no drops, no collisions)?
function allPlacedOnce(map: number[], n: number): boolean {
  const seen = new Set<number>();
  for (const v of map) if (v >= 0) { if (seen.has(v)) return false; seen.add(v); }
  return seen.size === n;
}

describe('buildLedmap grid fitting (lattice)', () => {
  it('recovers a clean 5×5 from a flat grid, LED 0 at top-left', () => {
    const l = buildLedmap(gridPoints(5, 5));
    expect(l.width).toBe(5);
    expect(l.height).toBe(5);
    expect(allPlacedOnce(l.map, 25)).toBe(true);
    expect(l.map[0]).toBe(0); // sequential auto-orients with index 0 top-left
    expect(l.map[24]).toBe(24);
  });

  it('recovers 5×5 under 10°, 25°, and -15° rotation', () => {
    for (const deg of [10, 25, -15]) {
      const l = buildLedmap(rotate(gridPoints(5, 5), deg));
      expect(`${l.width}x${l.height}`, `rot ${deg}`).toBe('5x5');
      expect(allPlacedOnce(l.map, 25), `rot ${deg}`).toBe(true);
    }
  });

  it('recovers 5×5 under perspective + tilt + jitter', () => {
    const l = buildLedmap(jitter(rotate(perspective(gridPoints(5, 5), 0.4), 8), 2));
    expect(`${l.width}x${l.height}`).toBe('5x5');
    expect(allPlacedOnce(l.map, 25)).toBe(true);
  });

  it('recovers a non-square 7×3 grid', () => {
    const l = buildLedmap(rotate(gridPoints(7, 3), 6));
    // dimensions may be transposed by orientation, but the cell count and topology hold
    expect(new Set([`${l.width}x${l.height}`]).has('7x3') || `${l.width}x${l.height}` === '3x7').toBe(true);
    expect(allPlacedOnce(l.map, 21)).toBe(true);
  });

  it('keeps undecoded LEDs (null) as gaps, not phantom cells', () => {
    const pts: (Pt | null)[] = gridPoints(5, 5);
    pts[12] = null; // a hole in the middle
    const l = buildLedmap(pts);
    expect(allPlacedOnce(l.map, 24)).toBe(true);
    expect(l.map.includes(12)).toBe(false);
  });
});
