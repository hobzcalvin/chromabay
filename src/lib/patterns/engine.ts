import { FrameBuffer } from './frame-buffer';
import { Pattern, parsePattern, PatternDefinition } from './patterns';

export class PatternEngine {
  buffer: FrameBuffer;
  patterns: Pattern[] = [];

  constructor(width: number, height: number) {
    this.buffer = new FrameBuffer(width, height);
  }

  load(defs: PatternDefinition[]): void {
    this.patterns = defs.map((d) => parsePattern(d));
  }

  render(time: number): FrameBuffer {
    for (const p of this.patterns) {
      p.apply(this.buffer, time);
    }
    return this.buffer;
  }
}
