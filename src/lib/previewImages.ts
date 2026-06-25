// Canonical input images for the Add-Node modal's MODIFIER previews. Drawn procedurally
// (no external asset, no licensing, scales to any size) on a BLACK background.
//
//  - getDuckInput(): a "duck on a pond" scene. Recognizable + ASYMMETRIC (so spatial ops
//    like mirror/scroll/tile read clearly) + MULTI-HUE (yellow duck, orange beak, blue
//    water, warm sun, green reeds — so colour ops read clearly).
//  - getRgbVennInput(): three additive R/G/B circles (the classic blend-mode test image),
//    used as Blend's SECOND input.
//
// Both return ImageData at the requested size, cached per (kind,w,h).

const cache = new Map<string, ImageData>();

function makeCanvas(w: number, h: number): { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  return { ctx, canvas };
}

function drawDuck(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const S = Math.min(w, h);
  // Water: lower ~38%, blue gradient.
  const waterTop = h * 0.62;
  const grad = ctx.createLinearGradient(0, waterTop, 0, h);
  grad.addColorStop(0, '#1f6fd0');
  grad.addColorStop(1, '#0a3a7a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, waterTop, w, h - waterTop);

  // Sun, top-right, warm.
  ctx.fillStyle = '#ffcc33';
  ctx.beginPath();
  ctx.arc(w * 0.80, h * 0.22, S * 0.13, 0, Math.PI * 2);
  ctx.fill();

  // Reeds, right side, green.
  ctx.strokeStyle = '#2faa3c';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.lineCap = 'round';
  for (const [bx, lean] of [[0.88, 0.05], [0.93, -0.04]] as const) {
    ctx.beginPath();
    ctx.moveTo(w * bx, h * 0.98);
    ctx.quadraticCurveTo(w * (bx + lean), h * 0.78, w * (bx + lean * 2), h * 0.58);
    ctx.stroke();
  }

  // Duck body (yellow ellipse) sitting on the water line, facing LEFT.
  const bx = w * 0.42, by = h * 0.60;
  ctx.fillStyle = '#ffd21f';
  ctx.beginPath();
  ctx.ellipse(bx, by, S * 0.27, S * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail flick up-right.
  ctx.beginPath();
  ctx.moveTo(bx + S * 0.22, by - S * 0.02);
  ctx.lineTo(bx + S * 0.40, by - S * 0.16);
  ctx.lineTo(bx + S * 0.26, by - S * 0.12);
  ctx.closePath();
  ctx.fill();

  // Head (up-left of body).
  const hx = bx - S * 0.22, hy = by - S * 0.20;
  ctx.beginPath();
  ctx.arc(hx, hy, S * 0.14, 0, Math.PI * 2);
  ctx.fill();

  // Beak (orange triangle, pointing left).
  ctx.fillStyle = '#ff7a18';
  ctx.beginPath();
  ctx.moveTo(hx - S * 0.12, hy);
  ctx.lineTo(hx - S * 0.30, hy + S * 0.03);
  ctx.lineTo(hx - S * 0.12, hy + S * 0.08);
  ctx.closePath();
  ctx.fill();

  // Eye (black dot with white glint).
  ctx.fillStyle = '#101010';
  ctx.beginPath();
  ctx.arc(hx - S * 0.02, hy - S * 0.03, Math.max(1, S * 0.03), 0, Math.PI * 2);
  ctx.fill();
}

function drawRgbVenn(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const S = Math.min(w, h);
  const r = S * 0.30;
  const cx = w / 2, cy = h / 2;
  const off = r * 0.62;
  // Additive compositing so overlaps make yellow/magenta/cyan/white on black.
  ctx.globalCompositeOperation = 'lighter';
  const circles: [number, number, string][] = [
    [cx, cy - off, '#ff0000'],          // top    red
    [cx - off * 0.95, cy + off * 0.6, '#00ff00'], // bottom-left green
    [cx + off * 0.95, cy + off * 0.6, '#0000ff']  // bottom-right blue
  ];
  for (const [x, y, col] of circles) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function get(kind: 'duck' | 'venn', w: number, h: number): ImageData {
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { ctx } = makeCanvas(w, h);
  if (kind === 'duck') drawDuck(ctx, w, h);
  else drawRgbVenn(ctx, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  cache.set(key, data);
  return data;
}

export const getDuckInput = (w: number, h: number) => get('duck', w, h);
export const getRgbVennInput = (w: number, h: number) => get('venn', w, h);
