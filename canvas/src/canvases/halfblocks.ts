import type { DecodedImage } from "./png";

/**
 * One horizontal run of cells sharing a colour pair, so a row of 80
 * identical cells is one run rather than 80 React elements.
 *
 * A solid image would otherwise cost `columns * rows` `<Text>` elements --
 * 1920 for an 80x24 pane -- and Ink measures and lays out every one.
 */
export interface HalfBlockRun {
  /** Upper pixel: the `▀` glyph's foreground. Hex, e.g. "#1e2a34". */
  fg: string;
  /** Lower pixel: the cell's background. */
  bg: string;
  /** How many adjacent cells share this pair. */
  count: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** The colour transparent pixels are composited over. */
export const DEFAULT_BACKGROUND: RGB = { r: 0, g: 0, b: 0 };

function hex({ r, g, b }: RGB): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Cell grid for an image, preserving its aspect ratio.
 *
 * A terminal cell is about twice as tall as it is wide, and a half-block
 * cell carries two vertically stacked pixels -- so one cell is roughly
 * square in pixel terms, and a W x H cell grid represents W x 2H pixels
 * with square-ish pixels. That is why the height is halved here and not
 * anywhere else.
 */
export function fitToCells(
  imageWidth: number,
  imageHeight: number,
  maxColumns: number,
  maxRows: number
): { columns: number; rows: number } {
  if (imageWidth <= 0 || imageHeight <= 0 || maxColumns <= 0 || maxRows <= 0) {
    return { columns: 1, rows: 1 };
  }
  // Candidate 1: use the full width and let the height fall out.
  const byWidth = {
    columns: maxColumns,
    rows: Math.max(1, Math.round((maxColumns * imageHeight) / (imageWidth * 2))),
  };
  if (byWidth.rows <= maxRows) return byWidth;
  // Too tall: bound by height instead.
  return {
    rows: maxRows,
    columns: Math.max(1, Math.round((maxRows * 2 * imageWidth) / imageHeight)),
  };
}

/**
 * Averages the source pixels covering one cell of the target grid.
 *
 * Box-averaged rather than sampled: a nearest-neighbour downscale of a
 * screenshot drops entire rows of text, which is exactly the content this
 * tier exists to make legible. Alpha is composited over `background`,
 * because a terminal cannot tell us its own colour and a transparent pixel
 * has to resolve to something.
 */
function averageBox(
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

/** Maps a target index onto its source span, never empty. */
function span(index: number, targetExtent: number, sourceExtent: number): [number, number] {
  const start = Math.floor((index * sourceExtent) / targetExtent);
  const end = Math.floor(((index + 1) * sourceExtent) / targetExtent);
  return [start, Math.max(end, start + 1)];
}

/**
 * Renders an image as half-block cells: one row of runs per terminal row.
 *
 * `▀` painted with a foreground and a background colour puts two vertically
 * stacked pixels in one cell, so a W x H cell grid carries W x 2H pixels.
 * This is the baseline tier -- Apple Terminal ships as macOS's default with
 * no image protocol at all, and kitty, Ghostty and Alacritty all refuse
 * Sixel -- so it is the tier most users get, and the only one that is pure
 * ANSI text and therefore byte-snapshot-testable.
 */
export function toHalfBlocks(
  img: DecodedImage,
  columns: number,
  rows: number,
  background: RGB = DEFAULT_BACKGROUND
): HalfBlockRun[][] {
  const out: HalfBlockRun[][] = [];
  const pixelRows = rows * 2;

  for (let row = 0; row < rows; row++) {
    const [topY0, topY1] = span(row * 2, pixelRows, img.height);
    const [botY0, botY1] = span(row * 2 + 1, pixelRows, img.height);
    const runs: HalfBlockRun[] = [];

    for (let col = 0; col < columns; col++) {
      const [x0, x1] = span(col, columns, img.width);
      const fg = hex(averageBox(img, x0, x1, topY0, topY1, background));
      const bg = hex(averageBox(img, x0, x1, botY0, botY1, background));
      const last = runs[runs.length - 1];
      if (last !== undefined && last.fg === fg && last.bg === bg) last.count++;
      else runs.push({ fg, bg, count: 1 });
    }
    out.push(runs);
  }
  return out;
}

/** The glyph every half-block cell paints. */
export const HALF_BLOCK = "▀";
