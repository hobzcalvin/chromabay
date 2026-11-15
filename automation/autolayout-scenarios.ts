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
  // --- harsh: messy physical installs + nasty light ---
  { name: 'harsh-fairy-lights-facing', layout: { kind: 'strip', n: 100, shape: 'zigzag', rowLen: 10 }, posJitter: 0.25, facingDeg: 75, ledVarLog: 0.4 },
  { name: 'harsh-wavy-curtain', layout: { kind: 'grid', cols: 12, rows: 12, serpentine: true }, posJitter: 0.22 },
  { name: 'harsh-brightness-spread', layout: { kind: 'grid', cols: 10, rows: 10 }, ledVarLog: 0.9 },
  { name: 'harsh-occluded-20pct', layout: { kind: 'grid', cols: 10, rows: 10 }, occludeFrac: 0.2 },
  { name: 'harsh-floor-reflection', layout: { kind: 'grid', cols: 10, rows: 6 }, coverage: 0.45, reflection: { strength: 0.5, mirrorY: 0.82 } },
  { name: 'harsh-mains-flicker-bright', layout: { kind: 'grid', cols: 10, rows: 10 }, ambient: 0.3, flickerHz: 120, flickerDepth: 0.7, exposureMs: 3, ledLevel: 0.5 },
  { name: 'harsh-pwm-400hz-short-exp', layout: { kind: 'grid', cols: 10, rows: 10 }, pwmHz: 400, exposureMs: 2 },
  { name: 'harsh-pwm-1k2-close-dense', layout: { kind: 'grid', cols: 8, rows: 8 }, coverage: 0.5, spotFrac: 0.3, bloom: 0.12, ledLevel: 1.5, pwmHz: 1200, exposureMs: 4 },
  { name: 'harsh-panel-fills-frame', layout: { kind: 'grid', cols: 16, rows: 16, serpentine: true }, coverage: 0.97, spotFrac: 0.25, bloom: 0.08 },
  { name: 'harsh-defocused', layout: { kind: 'grid', cols: 10, rows: 10 }, minSpotPx: 4.5 },
  { name: 'harsh-low-res-camera', layout: { kind: 'grid', cols: 16, rows: 16, serpentine: true }, imgW: 160, imgH: 90, noise: 4 },
  { name: 'harsh-partly-out-of-frame', layout: { kind: 'grid', cols: 10, rows: 10 }, offsetX: 0.4 },
  { name: 'harsh-everything', layout: { kind: 'grid', cols: 12, rows: 12, serpentine: true }, posJitter: 0.15, facingDeg: 50, ledVarLog: 0.5,
    shakePx: 0.25, aeSpeed: 0.4, ambient: 0.15, lamps: [{ x: 0.1, y: 0.15, r: 0.05, level: 2 }], flickerHz: 100, flickerDepth: 0.5,
    exposureMs: 6, pwmHz: 1200, rollingShutterMs: 30, fps: 24, dropRate: 0.06, deviceClockScale: 1.06, noise: 3, occludeFrac: 0.05 },
  { name: 'dead-leds', layout: { kind: 'grid', cols: 10, rows: 10 }, deadLeds: [7, 33, 45, 64, 88] },
];
