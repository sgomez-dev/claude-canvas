import type { DecodedImage } from "../png";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** The colour transparent pixels are composited over. */
export const DEFAULT_BACKGROUND: RGB = { r: 0, g: 0, b: 0 };

/**
 * Maps one target index onto its source span, never empty.
 *
 * The `max(end, start + 1)` is what guarantees every target cell gets at
 * least one source pixel when the source is smaller than the target, or
 * when the two do not divide evenly -- an empty span would average nothing
 * and produce a division by zero.
 */
export function span(index: number, targetExtent: number, sourceExtent: number): [number, number] {
  const start = Math.floor((index * sourceExtent) / targetExtent);
  const end = Math.floor(((index + 1) * sourceExtent) / targetExtent);
  return [start, Math.max(end, start + 1)];
}

/**
 * Averages the source pixels covering one box of the target grid.
 *
 * Box-averaged rather than sampled: a nearest-neighbour downscale of a
 * screenshot drops entire rows of text, which is exactly the content these
 * tiers exist to make legible. Alpha is composited over `background`,
 * because a terminal cannot tell us its own colour and a transparent pixel
 * has to resolve to something.
 *
 * Shared by the half-block renderer (which averages two boxes per cell) and
 * the Sixel encoder (which resamples to a pixel grid). One implementation,
 * because two would drift and only one of them has snapshots.
 */
export function averageBox(
  img: DecodedImage,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  background: RGB
): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      const a = img.pixels[o + 3]! / 255;
      r += img.pixels[o]! * a + background.r * (1 - a);
      g += img.pixels[o + 1]! * a + background.g * (1 - a);
      b += img.pixels[o + 2]! * a + background.b * (1 - a);
      n++;
    }
  }
  if (n === 0) return background;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/**
 * Resamples an image to an exact pixel grid, returning packed RGB triples.
 *
 * Sixel places pixels rather than scaling into a cell box the way kitty and
 * iTerm2 do, so this is the step that has to happen before encoding it.
 */
export function resampleRGB(
  img: DecodedImage,
  width: number,
  height: number,
  background: RGB = DEFAULT_BACKGROUND
): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const [y0, y1] = span(y, height, img.height);
    for (let x = 0; x < width; x++) {
      const [x0, x1] = span(x, width, img.width);
      const c = averageBox(img, x0, x1, y0, y1, background);
      const o = (y * width + x) * 3;
      out[o] = c.r;
      out[o + 1] = c.g;
      out[o + 2] = c.b;
    }
  }
  return out;
}
