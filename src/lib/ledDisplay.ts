// Showing LED colours on a screen.
//
// An addressable LED's light output is linear in the value it is sent: 128 is half the light
// of 255. A screen is not: it treats pixel values as sRGB-encoded, where 128 is only about a
// fifth of full light. Drawing the engine's values straight onto a canvas therefore shows every
// mid-tone far darker than the LEDs do. The worst case is yellow: FastLED's rainbow makes it
// (171, 170, 0), which a strip shows as a bright yellow and a screen as olive ("muddy").
//
// The previews brighten each pixel for the screen by its BRIGHTEST channel only: that channel
// is encoded with the sRGB-like 1/2.2 curve and the other two are scaled by the same factor. A
// pixel's colour (the ratio between its channels) never changes, only how bright it reads.
// Encoding each channel separately (the first attempt) is closer to the physics on paper but
// lifts small channels hugely, so rainbow red (215, 0, 40) turned pink and looked washed out.
// This is DISPLAY ONLY: the values operators read and devices are sent are never changed.
export const LED_DISPLAY_EXPONENT = 1 / 2.2;

// GAIN[m] = the factor that takes a brightest channel of m to its encoded value, in 1/256ths.
const GAIN = new Uint16Array(256);
for (let m = 1; m < 256; m++) GAIN[m] = Math.round((255 * Math.pow(m / 255, LED_DISPLAY_EXPONENT) / m) * 256);

/** Encode RGBA `src` for the screen into `dst` (same size; may be `src` itself). Alpha kept. */
export function ledToScreen(src: ImageData, dst: ImageData = src): ImageData {
  const s = src.data, d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i], g = s[i + 1], b = s[i + 2];
    const k = GAIN[r > g ? (r > b ? r : b) : (g > b ? g : b)];
    d[i] = (r * k) >> 8; d[i + 1] = (g * k) >> 8; d[i + 2] = (b * k) >> 8; d[i + 3] = s[i + 3];
  }
  return dst;
}

/** A scratch ImageData per size, so the per-frame conversion doesn't allocate. */
export function screenScratch(): (src: ImageData) => ImageData {
  let buf: ImageData | null = null;
  return (src) => {
    if (!buf || buf.width !== src.width || buf.height !== src.height) buf = new ImageData(src.width, src.height);
    return ledToScreen(src, buf);
  };
}

/** How one pixel shows on screen (for tests). */
export function ledPixelToScreen(r: number, g: number, b: number): [number, number, number] {
  const k = GAIN[Math.max(r, g, b)];
  return [(r * k) >> 8, (g * k) >> 8, (b * k) >> 8];
}
