// The auto-layout condition battery: each entry is one physical setup the feature has to survive.
// Grouped by the axes that matter — density/size, distance, lighting, camera behaviour, motion.
import type { SimScenario } from '../src/lib/autoLayoutSim.ts';

export const SCENARIOS: SimScenario[] = [
  // --- baseline ---
  { name: 'baseline-8x8', layout: { kind: 'grid', cols: 8, rows: 8, serpentine: true } },
  { name: 'baseline-16x16', layout: { kind: 'grid', cols: 16, rows: 16, serpentine: true } },
  // --- density / form factor ---
  { name: 'dense-2in-8x8-closeup-bloomy', layout: { kind: 'grid', cols: 8, rows: 8 }, coverage: 0.5, spotFrac: 0.3, bloom: 0.12, ledLevel: 1.5 },
  { name: 'dense-32x8-matrix', layout: { kind: 'grid', cols: 32, rows: 8, serpentine: true }, coverage: 0.9, spotFrac: 0.2 },
  { name: 'dense-32x32-1024', layout: { kind: 'grid', cols: 32, rows: 32, serpentine: true }, coverage: 0.5, imgW: 480, imgH: 270 },
  { name: 'sparse-far-web-12x12-tiny', layout: { kind: 'grid', cols: 12, rows: 12 }, coverage: 0.35, minSpotPx: 0.5, spotFrac: 0.03, ledLevel: 0.4 },
  { name: 'sparse-far-strip-150-line', layout: { kind: 'strip', n: 150, shape: 'line' }, coverage: 0.95, imgW: 480, imgH: 270 },
  { name: 'strip-zigzag-100', layout: { kind: 'strip', n: 100, shape: 'zigzag', rowLen: 10 } },
  { name: 'spiral-120', layout: { kind: 'strip', n: 120, shape: 'spiral' }, coverage: 0.5 },
  // --- lighting ---
  { name: 'dark-room-ae-cranks', layout: { kind: 'grid', cols: 10, rows: 10 }, ambient: 0.002, ledLevel: 0.3 },
  { name: 'bright-room', layout: { kind: 'grid', cols: 10, rows: 10 }, ambient: 0.35, ambientGradient: 0.2, ledLevel: 0.35 },
  { name: 'bright-room-lamp-in-frame', layout: { kind: 'grid', cols: 10, rows: 10 }, ambient: 0.2, lamps: [{ x: 0.9, y: 0.2, r: 0.06, level: 3 }] },
  { name: 'overexposed-full-white', layout: { kind: 'grid', cols: 10, rows: 10 }, ledLevel: 4, bloom: 0.1, spotFrac: 0.25 },
  // --- camera behaviour ---
  { name: 'ae-hunting-fast', layout: { kind: 'grid', cols: 10, rows: 10 }, aeSpeed: 0.5 },
  { name: 'low-fps-15-jittery', layout: { kind: 'grid', cols: 10, rows: 10 }, fps: 15, fpsJitterMs: 10, dropRate: 0.08 },
  { name: 'rolling-shutter-heavy', layout: { kind: 'grid', cols: 10, rows: 10 }, rollingShutterMs: 33, exposureMs: 30 },
  { name: 'device-clock-slow-8pct', layout: { kind: 'grid', cols: 10, rows: 10 }, deviceClockScale: 1.08, deviceJitterMs: 25 },
  // --- geometry / motion ---
  { name: 'oblique-rotated', layout: { kind: 'grid', cols: 12, rows: 8, serpentine: true }, rotDeg: 17, tilt: 0.35 },
  { name: 'handheld-shake', layout: { kind: 'grid', cols: 10, rows: 10 }, shakePx: 0.35 },
  { name: 'dead-leds', layout: { kind: 'grid', cols: 10, rows: 10 }, deadLeds: [7, 33, 45, 64, 88] },
];
