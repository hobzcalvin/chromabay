// Canonical input images for the Add-Node modal's MODIFIER previews, on a BLACK background.
//
//  - getVennInput(): three additive R/G/B circles (the classic blend-mode test image).
//    Used as the input to ALL single-input modifiers. Drawn PER-PIXEL with HARD edges and
//    pure 0/255 channels (no antialiasing) — antialiased edges produce muddy in-between
//    colours that make hue-rotate / brightness->rainbow boundaries look broken.
//  - getWhiteXInput(): a white X on black, used as Blend's SECOND input.
//
// Returns ImageData at the requested size, cached per (kind,w,h).

const cache = new Map<string, ImageData>();

function vennImage(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  const S = Math.min(w, h);
  const r = S * 0.30, r2 = r * r;
  const cx = w / 2, cy = h / 2, off = r * 0.62;
  const circles: [number, number, number][] = [
    [cx, cy - off, 0],                       // red   (channel 0)
    [cx - off * 0.95, cy + off * 0.6, 1],    // green (channel 1)
    [cx + off * 0.95, cy + off * 0.6, 2]     // blue  (channel 2)
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let R = 0, G = 0, B = 0;
      for (const [ccx, ccy, ch] of circles) {
        const dx = x + 0.5 - ccx, dy = y + 0.5 - ccy;
        if (dx * dx + dy * dy <= r2) {
          if (ch === 0) R = 255; else if (ch === 1) G = 255; else B = 255;
        }
      }
      data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

function whiteXImage(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  const half = Math.max(1, Math.min(w, h) * 0.11); // bar half-thickness, in pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Normalized [-1,1]; lit when near either diagonal (|u-v| or |u+v| small).
      const u = (x + 0.5) / w * 2 - 1, v = (y + 0.5) / h * 2 - 1;
      const d = Math.min(Math.abs(u - v), Math.abs(u + v)) * 0.70710678;
      const lit = d * Math.min(w, h) * 0.5 <= half && Math.abs(u) <= 0.85 && Math.abs(v) <= 0.85;
      const i = (y * w + x) * 4;
      const c = lit ? 255 : 0;
      data[i] = c; data[i + 1] = c; data[i + 2] = c; data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

function get(kind: 'venn' | 'whitex', w: number, h: number): ImageData {
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = kind === 'venn' ? vennImage(w, h) : whiteXImage(w, h);
  cache.set(key, data);
  return data;
}

export const getVennInput = (w: number, h: number) => get('venn', w, h);
export const getWhiteXInput = (w: number, h: number) => get('whitex', w, h);
