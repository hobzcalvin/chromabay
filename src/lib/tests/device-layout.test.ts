import { describe, it, expect } from 'vitest';
import { litCells, shapeFromConfig, shapeSize, xyToIndex, cellMap, stripRotation, applyStripRotation } from '$lib/stores/deviceLayoutStore';

const cfg = (o: any) => ({ chipset: 22, pin: 13, colorOrder: 2, rmtChannel: 0, orientation: 0, ...o });

describe('device layout shapes', () => {
  it('a strip is a single row of its LEDs', () => {
    const s = shapeFromConfig(cfg({ numLeds: 4, width: 4, height: 1 }));
    expect(s.kind).toBe('strip');
    expect(shapeSize(s)).toEqual({ width: 4, height: 1 });
    expect([...litCells(s)]).toEqual([1, 1, 1, 1]);
  });

  it('a matrix only lights cells its LED count reaches', () => {
    const s = shapeFromConfig(cfg({ numLeds: 5, width: 3, height: 2 }));
    expect(s.kind).toBe('matrix');
    expect([...litCells(s)]).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it('serpentine wiring matches the firmware', () => {
    // Row 1 runs right-to-left: (0,1) is the last LED of the row.
    expect(xyToIndex(0, 1, 3, 2, 0x08, 6)).toBe(5);
    expect(xyToIndex(2, 1, 3, 2, 0x08, 6)).toBe(3);
  });

  it('a custom layout lights its mapped cells at the layout size', () => {
    const s = { ...shapeFromConfig(cfg({ numLeds: 3, width: 3, height: 1 })), kind: 'custom' as const,
      layout: { width: 2, height: 2, map: [0, -1, 1, 2] } };
    expect(shapeSize(s)).toEqual({ width: 2, height: 2 });
    expect([...litCells(s)]).toEqual([1, 0, 1, 1]);
  });

  it('strip rotation turns a strip into a row or a column, either way round', () => {
    const s: any = { numLeds: 3, width: 3, height: 1, orientation: 0 };
    applyStripRotation(s, 1);
    expect([s.width, s.height, stripRotation(s)]).toEqual([1, 3, 1]);
    expect(cellMap(shapeFromConfig(cfg(s)))).toEqual([0, 1, 2]);   // top to bottom
    applyStripRotation(s, 3);
    expect(cellMap(shapeFromConfig(cfg(s)))).toEqual([2, 1, 0]);   // bottom to top
    applyStripRotation(s, 2);
    expect([s.width, s.height, stripRotation(s)]).toEqual([3, 1, 2]);
    expect(cellMap(shapeFromConfig(cfg(s)))).toEqual([2, 1, 0]);   // right to left
  });
});
