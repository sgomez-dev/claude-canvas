import { test, expect } from "bun:test";
import { toQuadrants, QUADRANT_GLYPHS } from "./quadrants";
import { toHalfBlocks } from "./halfblocks";
import { resampleRGB } from "./graphics/resample";
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

// --- the glyph table ------------------------------------------------------

// Every bug in this renderer would come from a wrong bit order, so the whole
// table is pinned. Bit 0 top-left, 1 top-right, 2 bottom-left, 3
// bottom-right; a set bit is painted in the foreground.
test("all sixteen masks map to a distinct, correct glyph", () => {
  expect(QUADRANT_GLYPHS).toEqual([
    " ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█",
  ]);
  expect(new Set(QUADRANT_GLYPHS).size).toBe(16);
});

// Completeness is what makes the search exhaustive rather than approximate:
// there is no two-colour split it can find and then fail to draw.
test("the half-block glyph is one of the sixteen, at the mask that means it", () => {
  expect(QUADRANT_GLYPHS[0b0011]).toBe("▀");
  expect(QUADRANT_GLYPHS[0b1100]).toBe("▄");
  expect(QUADRANT_GLYPHS[0b0101]).toBe("▌");
  expect(QUADRANT_GLYPHS[0b1010]).toBe("▐");
});

// --- what this tier can represent and half-blocks cannot ------------------

// THE reason the tier exists. A vertical split is exact here and impossible
// with half-blocks, which have to average the two halves of each row into a
// single colour.
test("a left/right split is exact, where half-blocks blur it", () => {
  const img = image(2, 2, [RED, BLUE, RED, BLUE]);

  const quad = toQuadrants(img, 1, 1);
  expect(quad[0]).toEqual([{ glyph: "▐", fg: "#0000ff", bg: "#ff0000", count: 1 }]);

  // Half-blocks average red and blue into one colour per row, twice.
  const half = toHalfBlocks(img, 1, 1);
  expect(half[0]![0]!.fg).toBe("#800080");
  expect(half[0]![0]!.bg).toBe("#800080");
});

test("a diagonal split is exact, which no half-block can express", () => {
  // TL and BR red, TR and BL blue -> mask 0b1001, which is ▚. Its
  // complement 0b0110 (▞, colours swapped) is equally exact; the tie rule
  // takes the higher mask.
  const img = image(2, 2, [RED, BLUE, BLUE, RED]);
  expect(toQuadrants(img, 1, 1)[0]).toEqual([
    { glyph: "▚", fg: "#ff0000", bg: "#0000ff", count: 1 },
  ]);
});

test("a top/bottom split still renders exactly, as a half block would", () => {
  const img = image(2, 2, [RED, RED, BLUE, BLUE]);
  expect(toQuadrants(img, 1, 1)[0]).toEqual([
    { glyph: "▄", fg: "#0000ff", bg: "#ff0000", count: 1 },
  ]);
});

// A single differing quadrant has two equally exact renderings -- the mask
// and its complement, which swap foreground and background. The search
// prefers the higher mask, so this is ▟ on red rather than ▘ on blue. Both
// paint identical pixels; pinning one keeps the output deterministic.
test("a single odd quadrant renders as the complement, by the tie rule", () => {
  const img = image(2, 2, [RED, BLUE, BLUE, BLUE]);
  expect(toQuadrants(img, 1, 1)[0]).toEqual([
    { glyph: "▟", fg: "#0000ff", bg: "#ff0000", count: 1 },
  ]);
});

// Flat cells must not depend on a background colour: many terminals clear to
// end of line without preserving one, which would eat the right edge of an
// image whose last cells happen to be flat.
test("a flat cell is a full block with both colours equal, never a space", () => {
  const img = image(2, 2, [RED, RED, RED, RED]);
  const cell = toQuadrants(img, 1, 1)[0]![0]!;
  expect(cell.glyph).toBe("█");
  expect(cell.fg).toBe("#ff0000");
  expect(cell.bg).toBe("#ff0000");
});

test("a solid image never emits a space glyph anywhere", () => {
  const img = image(4, 4, Array.from({ length: 16 }, () => WHITE));
  for (const row of toQuadrants(img, 10, 3)) {
    for (const run of row) expect(run.glyph).not.toBe(" ");
  }
});

// The objective is squared error, and it is not interchangeable with
// absolute error: the mean of a group is the value that minimises its
// SQUARED error, so scoring a split any other way would pick colours
// inconsistent with the split they are scored against.
//
// Found by exhaustive search over grey quadruples: with subpixels 0, 0, 15
// and 35, squared error isolates the outlier (mask 0b1000, ▗, 35 on a
// background of 5) while absolute error groups the two dark-ish values
// (mask 0b1100, ▄, 25 on 0). Without this the two objectives were
// indistinguishable to every other test in this file.
test("the split minimises squared error, not absolute error", () => {
  const g = (v: number) => [v, v, v, 255];
  const img = image(2, 2, [g(0), g(0), g(15), g(35)]);
  expect(toQuadrants(img, 1, 1)[0]).toEqual([
    { glyph: "▗", fg: "#232323", bg: "#050505", count: 1 },
  ]);
});

// --- grid, runs and geometry ---------------------------------------------

test("a cell grid of W x H samples W*2 x H*2 pixels", () => {
  // Four columns of distinct colour across two cells: each cell must see two.
  const img = image(4, 2, [RED, BLUE, WHITE, BLACK, RED, BLUE, WHITE, BLACK]);
  const grid = toQuadrants(img, 2, 1);
  expect(grid[0]).toHaveLength(2);
  expect(grid[0]![0]!.glyph).toBe("▐");
  expect(grid[0]![1]!.glyph).toBe("▐");
  // Left cell resolves red|blue, right cell white|black -- not one average.
  expect(grid[0]![0]!.bg).toBe("#ff0000");
  expect(grid[0]![1]!.bg).toBe("#ffffff");
});

test("adjacent identical cells collapse into one run", () => {
  // The source has to be as wide as the sampling, or upscaling makes every
  // cell flat and the test proves nothing: 40 cells sample 80 columns, so
  // the source is 80 wide with alternating colours.
  const px: number[][] = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 80; x++) px.push(x % 2 === 0 ? RED : BLUE);
  expect(toQuadrants(image(80, 2, px), 40, 1)[0]).toEqual([
    { glyph: "▐", fg: "#0000ff", bg: "#ff0000", count: 40 },
  ]);
});

test("a run breaks when the glyph changes but the colours do not", () => {
  // Left cell split vertically, right cell flat: same palette, different glyph.
  const img = image(4, 2, [RED, BLUE, BLUE, BLUE, RED, BLUE, BLUE, BLUE]);
  const runs = toQuadrants(img, 2, 1)[0]!;
  expect(runs).toHaveLength(2);
  expect(runs[0]!.glyph).not.toBe(runs[1]!.glyph);
});

test("every row has as many cells as columns, whatever the source size", () => {
  for (const [w, h, c, r] of [[1, 1, 5, 3], [3, 7, 2, 2], [40, 40, 7, 5]] as const) {
    const px = Array.from({ length: w * h }, (_, i) => [i % 256, (i * 7) % 256, 0, 255]);
    const grid = toQuadrants(image(w, h, px), c, r);
    expect(grid).toHaveLength(r);
    for (const row of grid) {
      expect(row.reduce((n, run) => n + run.count, 0)).toBe(c);
    }
  }
});

// --- the claim the tier is justified by ----------------------------------

// The measured reason to prefer this tier, asserted rather than trusted:
// against a 2x2-per-cell reference, quadrants must beat half-blocks by a
// wide margin on a detailed image. Measured 61% on this repository's own
// screenshot; 40% is a floor that a real regression breaks.
test("quadrants cost far less error than half-blocks on detailed content", () => {
  const W = 120;
  const H = 120;
  // Fine vertical and diagonal structure -- exactly what a 1x2 sampling
  // cannot see and a 2x2 one can.
  const px = Array.from({ length: W * H }, (_, i) => {
    const x = i % W;
    const y = Math.floor(i / W);
    const on = (x + y) % 3 === 0 || x % 2 === 0;
    return on ? [230, 40, 90, 255] : [20, 60, 200, 255];
  });
  const img = image(W, H, px);
  const columns = 30;
  const rows = 15;

  const truth = resampleRGB(img, columns * 2, rows * 2);
  const at = (x: number, y: number) => {
    const o = (y * columns * 2 + x) * 3;
    return [truth[o]!, truth[o + 1]!, truth[o + 2]!];
  };
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const sse = (a: number[], b: number[]) =>
    (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

  // Half-blocks: one colour for the top half of each cell, one for the bottom.
  let halfError = 0;
  const half = toHalfBlocks(img, columns, rows);
  half.forEach((row, cy) => {
    let cx = 0;
    for (const run of row) {
      for (let k = 0; k < run.count; k++, cx++) {
        const top = parse(run.fg);
        const bot = parse(run.bg);
        halfError += sse(at(cx * 2, cy * 2), top) + sse(at(cx * 2 + 1, cy * 2), top);
        halfError += sse(at(cx * 2, cy * 2 + 1), bot) + sse(at(cx * 2 + 1, cy * 2 + 1), bot);
      }
    }
  });

  let quadError = 0;
  const quad = toQuadrants(img, columns, rows);
  quad.forEach((row, cy) => {
    let cx = 0;
    for (const run of row) {
      const mask = QUADRANT_GLYPHS.indexOf(run.glyph);
      expect(mask).toBeGreaterThanOrEqual(0);
      for (let k = 0; k < run.count; k++, cx++) {
        const fg = parse(run.fg);
        const bg = parse(run.bg);
        const corners = [
          at(cx * 2, cy * 2),
          at(cx * 2 + 1, cy * 2),
          at(cx * 2, cy * 2 + 1),
          at(cx * 2 + 1, cy * 2 + 1),
        ];
        for (let i = 0; i < 4; i++) {
          quadError += sse(corners[i]!, (mask & (1 << i)) !== 0 ? fg : bg);
        }
      }
    }
  });

  expect(quadError).toBeLessThan(halfError * 0.6);
});
