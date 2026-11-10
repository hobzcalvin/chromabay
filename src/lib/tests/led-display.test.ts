import { test, expect } from 'vitest';
import { ledPixelToScreen } from '../ledDisplay';

test('brightens by the brightest channel without changing the colour', () => {
  const [r, g, b] = ledPixelToScreen(171, 170, 0);   // FastLED rainbow yellow: olive raw
  expect(r).toBeGreaterThan(205);
  expect(Math.abs(r - g)).toBeLessThanOrEqual(2);
  expect(b).toBe(0);
  const red = ledPixelToScreen(215, 0, 40);          // rainbow red keeps its saturation
  expect(red[2] / red[0]).toBeCloseTo(40 / 215, 2);
  expect(ledPixelToScreen(255, 0, 0)).toEqual([255, 0, 0]);
  expect(ledPixelToScreen(255, 255, 255)).toEqual([255, 255, 255]);
  expect(ledPixelToScreen(0, 0, 0)).toEqual([0, 0, 0]);
});
