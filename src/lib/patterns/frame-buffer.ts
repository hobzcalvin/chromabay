export type Color = { r: number; g: number; b: number; a?: number };

export class FrameBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(width: number, height: number, fill: Color = { r: 0, g: 0, b: 0, a: 255 }) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.fill(fill);
  }

  private index(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  setPixel(x: number, y: number, color: Color): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const i = this.index(x, y);
    this.data[i] = color.r;
    this.data[i + 1] = color.g;
    this.data[i + 2] = color.b;
    this.data[i + 3] = color.a ?? 255;
  }

  getPixel(x: number, y: number): Color {
    const i = this.index(x, y);
    return {
      r: this.data[i],
      g: this.data[i + 1],
      b: this.data[i + 2],
      a: this.data[i + 3]
    };
  }

  fill(color: Color): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.setPixel(x, y, color);
      }
    }
  }

  toImageData(): ImageData {
    return new ImageData(this.data, this.width, this.height);
  }
}
