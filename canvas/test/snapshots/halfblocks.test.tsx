import { test, expect } from "bun:test";
import React from "react";
import { renderCanvas } from "../harness/render";
import { HalfBlockImage } from "../../src/canvases/halfblock-view";
import { toHalfBlocks } from "../../src/canvases/halfblocks";
import type { DecodedImage } from "../../src/canvases/png";

/** A deterministic gradient: every cell a distinct colour pair. */
function gradient(width: number, height: number): DecodedImage {
  const px: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) px.push(20 + x * 17, 40 + y * 13, 90, 255);
  }
  return { width, height, pixels: new Uint8Array(px) };
}

// Measured on 2026-09-09: Ink 6 emits raw 24-bit `38;2;r;g;b` for a hex
// colour at EVERY FORCE_COLOR level, including "1" (which in chalk's own
// scale means 16 colours) -- it does not quantise to the level it detected.
// So this snapshot pins the exact averaged colour of every pixel, not just
// the layout, and a one-off error in the box average would move it.
test("a gradient renders as half-block cells with exact 24-bit colour", async () => {
  // 16x16 into 8x4 cells is 8x8 target pixels, so every target pixel is the
  // average of a 2x2 source box -- the snapshot exercises the downscale in
  // both axes rather than mapping one source pixel per target pixel.
  const r = renderCanvas(<HalfBlockImage image={gradient(16, 16)} columns={8} rows={4} />, {
    columns: 20,
    rows: 6,
  });
  expect(await r.settle()).toMatchSnapshot();
  r.dispose();
});

test("a solid image collapses to one escape pair per row", async () => {
  const solid: DecodedImage = {
    width: 4,
    height: 4,
    pixels: new Uint8Array(Array.from({ length: 16 }, () => [200, 30, 60, 255]).flat()),
  };
  const r = renderCanvas(<HalfBlockImage image={solid} columns={12} rows={3} />, {
    columns: 20,
    rows: 5,
  });
  const frame = await r.settle();
  expect(frame).toMatchSnapshot();
  // The point of run coalescing: twelve cells, one colour pair.
  const line = frame.split("\n")[0]!;
  expect(line.match(/38;2;/g)).toHaveLength(1);
  expect(line).toContain("▀".repeat(12));
  r.dispose();
});

// The renderer's contract is that the pure function's output is what reaches
// the escape codes. Assert the join rather than trusting it: an upper pixel
// must arrive as a foreground (38) and a lower one as a background (48).
test("the upper pixel becomes a foreground and the lower a background", async () => {
  const img: DecodedImage = {
    width: 1,
    height: 2,
    pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
  };
  const grid = toHalfBlocks(img, 1, 1);
  expect(grid[0]![0]).toEqual({ fg: "#ff0000", bg: "#0000ff", count: 1 });

  const r = renderCanvas(<HalfBlockImage image={img} columns={1} rows={1} />, {
    columns: 10,
    rows: 3,
  });
  const frame = await r.settle();
  expect(frame).toContain("38;2;255;0;0"); // red on top, as foreground
  expect(frame).toContain("48;2;0;0;255"); // blue below, as background
  r.dispose();
});

test("a transparent image renders the caller's background, not black", async () => {
  const clear: DecodedImage = {
    width: 2,
    height: 2,
    pixels: new Uint8Array(Array.from({ length: 4 }, () => [9, 9, 9, 0]).flat()),
  };
  const r = renderCanvas(
    <HalfBlockImage image={clear} columns={4} rows={1} background={{ r: 18, g: 52, b: 86 }} />,
    { columns: 10, rows: 3 }
  );
  const frame = await r.settle();
  expect(frame).toContain("38;2;18;52;86");
  expect(frame).toContain("48;2;18;52;86");
  r.dispose();
});
