import { test, expect } from "bun:test";
import { toHalfBlocks, fitToCells, HALF_BLOCK } from "./halfblocks";
import type { DecodedImage } from "./png";

/** Builds an image from a row-major list of [r,g,b,a] tuples. */
function image(width: number, height: number, px: number[][]): DecodedImage {
  const pixels = new Uint8Array(width * height * 4);
  px.forEach((p, i) => pixels.set(p, i * 4));
  return { width, height, pixels };
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];

// THE property of this tier: one cell carries two vertically stacked pixels,
// the upper as the glyph's foreground and the lower as its background. Get
// that backwards and every image renders upside down in stripes.
test("one cell carries two pixels: upper as foreground, lower as background", () => {
  const img = image(1, 2, [RED, BLUE]);
  const grid = toHalfBlocks(img, 1, 1);
  expect(grid).toHaveLength(1);
  expect(grid[0]).toEqual([{ fg: "#ff0000", bg: "#0000ff", count: 1 }]);
});

test("a cell grid of W x H covers W x 2H pixels", () => {
  // Four pixel rows, alternating, into two cells stacked vertically.
  const img = image(1, 4, [RED, BLUE, BLUE, RED]);
  const grid = toHalfBlocks(img, 1, 2);
  expect(grid[0]).toEqual([{ fg: "#ff0000", bg: "#0000ff", count: 1 }]);
  expect(grid[1]).toEqual([{ fg: "#0000ff", bg: "#ff0000", count: 1 }]);
});

// A solid 80x24 pane is 1920 cells; without coalescing that is 1920 elements
// for Ink to measure.
test("adjacent cells sharing a colour pair collapse into one run", () => {
  const img = image(1, 2, [RED, BLUE]);
  const grid = toHalfBlocks(img, 40, 1);
  expect(grid[0]).toEqual([{ fg: "#ff0000", bg: "#0000ff", count: 40 }]);
});

test("a run breaks where the colour pair changes", () => {
  // Two columns, two rows: left column red/red, right column blue/blue.
  const img = image(2, 2, [RED, BLUE, RED, BLUE]);
  const grid = toHalfBlocks(img, 2, 1);
  expect(grid[0]).toEqual([
    { fg: "#ff0000", bg: "#ff0000", count: 1 },
    { fg: "#0000ff", bg: "#0000ff", count: 1 },
  ]);
});

// Box-averaged rather than sampled: a nearest-neighbour downscale of a
// screenshot drops whole rows of text, which is the content this tier
// exists to keep legible.
test("downscaling averages the source box instead of sampling one pixel", () => {
  // One pixel row of black and white, squeezed into a single cell column.
  const img = image(2, 2, [BLACK, WHITE, BLACK, WHITE]);
  const grid = toHalfBlocks(img, 1, 1);
  // Average of 0 and 255 is 128 (127.5 rounded), not 0 and not 255.
  expect(grid[0]).toEqual([{ fg: "#808080", bg: "#808080", count: 1 }]);
});

// Sabotage-checked on 2026-09-09: replacing the vertical loop with a single
// sampled row left every other test in this file green, because each of them
// happened to map exactly one source row per pixel row. This one downscales
// four source rows into two pixel rows, so a box that samples instead of
// averaging reports pure black where the average is grey.
test("downscaling averages DOWN the box, not just across it", () => {
  const img = image(1, 4, [BLACK, WHITE, BLACK, WHITE]);
  const grid = toHalfBlocks(img, 1, 1);
  // Top pixel averages rows 0-1 (black + white), bottom averages rows 2-3.
  expect(grid[0]).toEqual([{ fg: "#808080", bg: "#808080", count: 1 }]);
});

test("upscaling repeats a source pixel across the cells that cover it", () => {
  const img = image(1, 1, [RED]);
  const grid = toHalfBlocks(img, 4, 2);
  expect(grid).toHaveLength(2);
  for (const row of grid) {
    expect(row).toEqual([{ fg: "#ff0000", bg: "#ff0000", count: 4 }]);
  }
});

// A source extent that does not divide evenly must still give every target
// cell at least one source pixel -- an empty span would average nothing.
test("a source height that does not divide evenly leaves no empty span", () => {
  const img = image(1, 3, [RED, WHITE, BLUE]);
  const grid = toHalfBlocks(img, 1, 2);
  expect(grid).toHaveLength(2);
  for (const row of grid) {
    expect(row).toHaveLength(1);
    expect(row[0]!.fg).toMatch(/^#[0-9a-f]{6}$/);
    expect(row[0]!.bg).toMatch(/^#[0-9a-f]{6}$/);
  }
});

// A terminal cannot report its own background, so a transparent pixel has to
// resolve to something and the caller picks what.
test("alpha is composited over the background colour", () => {
  const halfRed = [255, 0, 0, 128];
  const img = image(1, 2, [halfRed, halfRed]);

  // Over black: red at 50% is a dark red.
  const overBlack = toHalfBlocks(img, 1, 1)[0]![0]!;
  expect(overBlack.fg).toBe("#800000");

  // Over white: the same pixel is a pink. 0x7f and not 0x80 because alpha is
  // 128/255, which is a hair over one half -- so the background's share is a
  // hair under, and the arithmetic is over the true 0..255 range rather than
  // a naive halving.
  const overWhite = toHalfBlocks(img, 1, 1, { r: 255, g: 255, b: 255 })[0]![0]!;
  expect(overWhite.fg).toBe("#ff7f7f");

  // Fully transparent resolves to the background exactly.
  const clear = image(1, 2, [[9, 9, 9, 0], [9, 9, 9, 0]]);
  expect(toHalfBlocks(clear, 1, 1, { r: 18, g: 52, b: 86 })[0]![0]!.fg).toBe("#123456");
});

test("the glyph is the upper half block", () => {
  expect(HALF_BLOCK).toBe("▀");
});

// --- fitToCells ----------------------------------------------------------

// A terminal cell is about twice as tall as it is wide, and a half-block
// cell holds two stacked pixels -- so a cell is roughly square in pixel
// terms and the height is halved exactly once, here.
test("a square image fits to a grid half as tall as it is wide", () => {
  expect(fitToCells(100, 100, 80, 40)).toEqual({ columns: 80, rows: 40 });
  expect(fitToCells(100, 100, 40, 40)).toEqual({ columns: 40, rows: 20 });
});

test("a wide image is bounded by the available columns", () => {
  // 200x50 in a 100-column pane: 100 columns, and 100*50/(200*2) = 12 rows.
  expect(fitToCells(200, 50, 100, 40)).toEqual({ columns: 100, rows: 13 });
});

test("a tall image is bounded by the available rows instead", () => {
  // 50x200 would want 100*200/(50*2) = 200 rows, far past the 10 available.
  const fit = fitToCells(50, 200, 100, 10);
  expect(fit.rows).toBe(10);
  // 10*2*50/200 = 5 columns.
  expect(fit.columns).toBe(5);
});

test("fitToCells never returns a zero or negative extent", () => {
  for (const args of [
    [0, 10, 80, 24],
    [10, 0, 80, 24],
    [10, 10, 0, 24],
    [10, 10, 80, 0],
    [1, 10_000, 80, 24],
    [10_000, 1, 80, 24],
  ] as const) {
    const fit = fitToCells(...(args as [number, number, number, number]));
    expect(fit.columns).toBeGreaterThan(0);
    expect(fit.rows).toBeGreaterThan(0);
  }
});
