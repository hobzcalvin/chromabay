import { FrameBuffer, Color } from './frame-buffer';

export interface Pattern {
  apply(buffer: FrameBuffer, time: number): void;
}

export type PatternDefinition = {
  type: string;
  [key: string]: any;
};

export function parsePattern(def: PatternDefinition): Pattern {
  switch (def.type) {
    case 'gradient':
      return new GradientPattern(def.start, def.end);
    case 'invert':
      return new InvertPattern();
    case 'sine':
      return new SineWavePattern(def.color ?? { r: 255, g: 255, b: 255 }, def.frequency ?? 1);
    case 'noise':
      return new NoisePattern(def.scale ?? 1);
    default:
      throw new Error(`Unknown pattern type: ${def.type}`);
  }
}

export class GradientPattern implements Pattern {
  start: Color;
  end: Color;

  constructor(start: Color, end: Color) {
    this.start = start;
    this.end = end;
  }

  apply(buffer: FrameBuffer): void {
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const t = x / (buffer.width - 1);
        const r = this.start.r + (this.end.r - this.start.r) * t;
        const g = this.start.g + (this.end.g - this.start.g) * t;
        const b = this.start.b + (this.end.b - this.start.b) * t;
        buffer.setPixel(x, y, { r, g, b, a: 255 });
      }
    }
  }
}

export class InvertPattern implements Pattern {
  apply(buffer: FrameBuffer): void {
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const p = buffer.getPixel(x, y);
        buffer.setPixel(x, y, { r: 255 - p.r, g: 255 - p.g, b: 255 - p.b, a: p.a });
      }
    }
  }
}

export class SineWavePattern implements Pattern {
  color: Color;
  frequency: number;

  constructor(color: Color, frequency: number) {
    this.color = color;
    this.frequency = frequency;
  }

  apply(buffer: FrameBuffer, time: number): void {
    for (let x = 0; x < buffer.width; x++) {
      const wave = (Math.sin((x / buffer.width) * Math.PI * 2 * this.frequency + time) + 1) / 2;
      for (let y = 0; y < buffer.height; y++) {
        buffer.setPixel(x, y, {
          r: this.color.r * wave,
          g: this.color.g * wave,
          b: this.color.b * wave,
          a: 255
        });
      }
    }
  }
}

// Simple value noise as placeholder for Perlin
export class NoisePattern implements Pattern {
  scale: number;
  constructor(scale: number) {
    this.scale = scale;
  }

  apply(buffer: FrameBuffer, time: number): void {
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const n = Math.random();
        const v = Math.floor(n * 255);
        buffer.setPixel(x, y, { r: v, g: v, b: v, a: 255 });
      }
    }
  }
}
