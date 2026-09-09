import type { DecodedImage } from "./png";
import { span, averageBox, DEFAULT_BACKGROUND, type RGB } from "./graphics/resample";

// Re-exported because this module was where they lived first, and both the
// image canvas and its validator import them from here.
export { DEFAULT_BACKGROUND, type RGB };

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
