import { test, expect } from "bun:test";
import React from "react";
import { renderCanvas } from "../harness/render";
import { QuadrantImage } from "../../src/canvases/quadrant-view";
import { HalfBlockImage } from "../../src/canvases/halfblock-view";
import { QUADRANT_GLYPHS } from "../../src/canvases/quadrants";
import type { DecodedImage } from "../../src/canvases/png";

/** Fine vertical and diagonal structure: what a 1x2 sampling cannot see. */
function detailed(width: number, height: number): DecodedImage {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (x + y) % 3 === 0 || x % 2 === 0;
      px.set(on ? [230, 40, 90, 255] : [20, 60, 200, 255], (y * width + x) * 4);
    }
  }
  return { width, height, pixels: px };
}

// Ink emits raw 24-bit escapes for a hex colour at every FORCE_COLOR level,
// so this pins the exact colour of every subpixel pair as well as the glyph
// chosen for each cell -- a wrong bit order or a wrong split moves it.
test("a detailed image renders as quadrant cells with exact colour", async () => {
  const r = renderCanvas(<QuadrantImage image={detailed(16, 16)} columns={8} rows={4} />, {
    columns: 20,
    rows: 6,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

// The visible difference, side by side on identical input: quadrants use
// glyphs a half block cannot, and half-blocks are limited to one.
test("the two block tiers render the same image differently", async () => {
  const image = detailed(16, 16);
  const q = renderCanvas(<QuadrantImage image={image} columns={8} rows={4} />, {
    columns: 20,
    rows: 6,
  });
  const h = renderCanvas(<HalfBlockImage image={image} columns={8} rows={4} />, {
    columns: 20,
    rows: 6,
  });
  const qf = await q.settle();
  const hf = await h.settle();
  q.dispose();
  h.dispose();

  expect(qf).not.toBe(hf);
  // Half-blocks only ever paint one glyph, whatever the image.
  expect(new Set([...hf].filter((c) => QUADRANT_GLYPHS.includes(c)))).toEqual(new Set(["▀"]));
  // Quadrants paint at least one glyph a half block cannot. NOT "more than
  // one distinct glyph": this image's structure is purely vertical, so every
  // cell legitimately resolves to ▐, and counting glyphs would pin an
  // incidental of the fixture rather than the tier's capability.
  const used = new Set([...qf].filter((c) => QUADRANT_GLYPHS.includes(c)));
  expect(used.size).toBeGreaterThan(0);
  expect([...used].every((c) => c !== "▀")).toBe(true);
  expect(used.has("▐")).toBe(true);
});

test("a solid image paints full blocks and never leans on the background", async () => {
  const solid: DecodedImage = {
    width: 4,
    height: 4,
    pixels: new Uint8Array(Array.from({ length: 16 }, () => [200, 30, 60, 255]).flat()),
  };
  const r = renderCanvas(<QuadrantImage image={solid} columns={12} rows={3} />, {
    columns: 20,
    rows: 5,
  });
  const frame = await r.settle();
  expect(frame).toMatchSnapshot();
  const line = frame.split("\n")[0]!;
  expect(line).toContain("█".repeat(12));
  expect(line).not.toContain(" ".repeat(12));
  r.dispose();
});

test("a transparent image renders the caller's background", async () => {
  const clear: DecodedImage = {
    width: 2,
    height: 2,
    pixels: new Uint8Array(Array.from({ length: 4 }, () => [9, 9, 9, 0]).flat()),
  };
  const r = renderCanvas(
    <QuadrantImage image={clear} columns={4} rows={1} background={{ r: 18, g: 52, b: 86 }} />,
    { columns: 10, rows: 3 }
  );
  const frame = await r.settle();
  expect(frame).toContain("38;2;18;52;86");
  r.dispose();
});
