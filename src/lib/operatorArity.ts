// How many image inputs each operator consumes — an EDITOR concern (which input handles to
// draw, what connections to allow). The renderer always passes in1/in2; generators simply
// ignore them, so this never affects rendering, only the graph UI.
//
// Ground truth is the C++ operators' render() signatures (native/*Operator.h): a GENERATOR
// comments out its first input param (`CRGB* /* inputBuffer1 */`), a TRANSFORM names it, and
// `blend` names both. Keep this in sync when adding operators — a new generator not listed
// here just falls back to 1 (a harmless, ignored input handle), same as before.
const GENERATORS = new Set<string>([
  'bands', 'buggy_rainbow', 'fire', 'gradient', 'interference', 'movingblob', 'perlinnoise', 'plasma',
  'radial_rainbow', 'rainbow', 'raindrops', 'static', 'strobe', 'svgfill', 'symbol',
  'test', 'text', 'clock', 'venn', 'wave',
]);

/** 0 = generator (no input), 1 = transform (+ the Output node), 2 = blend. */
export function operatorInputCount(type: string | undefined): 0 | 1 | 2 {
  if (type === 'blend') return 2;
  if (type === 'output') return 1;      // the Output node takes exactly one input
  if (type && GENERATORS.has(type)) return 0;
  return 1;
}

export const isGeneratorType = (type: string | undefined): boolean => operatorInputCount(type) === 0;
