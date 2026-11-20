/**
 * Patterns that react to sound are shown with a 🎤 before their name, everywhere a name is
 * displayed. The mark is derived from the pattern's contents each time, never stored in the
 * name, so it appears the moment audio is added and disappears the moment the last of it is
 * removed (and a renamed or shared pattern never carries a stale one).
 *
 * "Uses audio" means an Audio node, or any parameter automation following the audio input
 * (the 🎵 shapes in native/Modulation.h: Volume … Beat ramp).
 */
import type { SerializedPattern } from './patternSerializer';
import { isAudioShape } from './stores/modulatorStore';

export const AUDIO_MARK = '🎤';

/** Does a saved pattern (library, device, gallery) use audio input? */
export function patternUsesAudio(p: SerializedPattern | null | undefined): boolean {
  if (!p || !Array.isArray(p.nodes)) return false;
  return p.nodes.some((n) =>
    n?.t === 'audio' || (n?.m != null && Object.values(n.m).some((c) => c && isAudioShape(Number(c.s)))));
}

/** The same test on the editor's live state: node types, and the shapes of every automation. */
export function liveUsesAudio(nodeTypes: string[], modShapes: number[]): boolean {
  return nodeTypes.includes('audio') || modShapes.some((s) => isAudioShape(s));
}

/** A name as displayed: "🎤 Name" for a pattern that uses audio, else the name. */
export function withAudioMark(name: string, usesAudio: boolean): string {
  return usesAudio ? `${AUDIO_MARK} ${name}` : name;
}

/** A saved pattern's display name. */
export function displayPatternName(p: SerializedPattern | null | undefined, fallback = 'Unnamed'): string {
  return withAudioMark(p?.meta?.name || fallback, patternUsesAudio(p));
}
