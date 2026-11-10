// Showing LED colours on a screen.
//
// An addressable LED's light output is linear in the value it is sent: 128 is half the light
// of 255. A screen is not: it treats pixel values as sRGB-encoded, where 128 is only about a
// fifth of full light. Drawing the engine's values straight onto a canvas therefore shows every
// mid-tone far darker than the LEDs do. The worst case is yellow: FastLED's rainbow makes it
// (171, 170, 0), which a strip shows as a bright yellow and a screen as olive ("muddy").
//
// The previews encode the values for the screen first (the sRGB transfer curve, approximated
// by the 1/2.2 power). This is DISPLAY ONLY: the values operators read and devices are sent are
// never changed. Strips with their own gamma configured (Show Settings → Color correction)
// will look a little darker on the LEDs than here, as they should.
export const LED_DISPLAY_EXPONENT = 1 / 2.2;

const LUT = new Uint8ClampedArray(256);
for (let i = 0; i < 256; i++) LUT[i] = Math.round(255 * Math.pow(i / 255, LED_DISPLAY_EXPONENT));

/** Encode RGBA `src` for the screen into `dst` (same size; may be `src` itself). Alpha kept. */
export function ledToScreen(src: ImageData, dst: ImageData = src): ImageData {
  const s = src.data, d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = LUT[s[i]]; d[i + 1] = LUT[s[i + 1]]; d[i + 2] = LUT[s[i + 2]]; d[i + 3] = s[i + 3];
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

/** The value a byte shows as on screen (for tests and CSS colour swatches). */
export const ledByteToScreen = (v: number): number => LUT[Math.max(0, Math.min(255, v | 0))];
