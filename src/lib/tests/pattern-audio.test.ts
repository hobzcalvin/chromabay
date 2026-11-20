import { test, expect } from 'vitest';
import { patternUsesAudio, displayPatternName, liveUsesAudio, withAudioMark } from '../patternAudio';
import type { SerializedPattern } from '../patternSerializer';

const pat = (nodes: SerializedPattern['nodes'], name = 'Waves'): SerializedPattern => ({ nodes, meta: { name, output: 0 } });

test('a pattern with an Audio node or audio automation is shown with a microphone', () => {
  expect(displayPatternName(pat([{ t: 'plasma', o: 0 }]))).toBe('Waves');
  expect(displayPatternName(pat([{ t: 'plasma', o: 0 }, { t: 'audio', o: 1 }]))).toBe('🎤 Waves');
  // Automation: clock shapes (0-5) don't count, audio shapes (6+) do.
  expect(displayPatternName(pat([{ t: 'plasma', o: 0, m: { speed: { s: 0, lo: 0, hi: 1, pr: 5 } } }]))).toBe('Waves');
  expect(displayPatternName(pat([{ t: 'plasma', o: 0, m: { speed: { s: 10, lo: 0, hi: 1, pr: 0.3 } } }]))).toBe('🎤 Waves');
  expect(displayPatternName(pat([{ t: 'plasma', o: 0, m: { speed: { s: 12, lo: 0, hi: 1, pr: 4 } } }]))).toBe('🎤 Waves');
});

test('the mark is derived, never stored: removing the audio removes it', () => {
  const p = pat([{ t: 'plasma', o: 0 }, { t: 'audio', o: 1 }]);
  expect(patternUsesAudio(p)).toBe(true);
  expect(p.meta.name).toBe('Waves');
  p.nodes = p.nodes.filter((n) => n.t !== 'audio');
  expect(displayPatternName(p)).toBe('Waves');
});

test('live editor state and odd inputs', () => {
  expect(liveUsesAudio(['plasma', 'output'], [0, 5])).toBe(false);
  expect(liveUsesAudio(['plasma', 'audio'], [])).toBe(true);
  expect(liveUsesAudio(['plasma'], [7])).toBe(true);
  expect(withAudioMark('X', false)).toBe('X');
  expect(displayPatternName(null)).toBe('Unnamed');
  expect(displayPatternName({ meta: { output: 0 } } as any)).toBe('Unnamed');
});
