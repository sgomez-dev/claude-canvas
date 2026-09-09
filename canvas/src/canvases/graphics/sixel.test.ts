import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { encodeSixel, medianCut, resolveCellPixels, CELL_PIXELS } from "./sixel";
import { resampleRGB } from "./resample";
import { decodePng, type DecodedImage } from "../png";

function solid(width: number, height: number, r: number, g: number, b: number): DecodedImage {
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) px.set([r, g, b, 255], i * 4);
  return { width, height, pixels: px };
}

/** Deterministic gradient with far more colours than 256 registers. */
function gradient(width: number, height: number): DecodedImage {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px.set([(x * 255) / width, (y * 255) / height, ((x + y) * 255) / (width + height), 255], o);
    }
  }
  return { width, height, pixels: px };
}

const CELL = { width: 8, height: 16 };

// --- structure ------------------------------------------------------------

test("the output is one DCS with raster attributes and a terminator", () => {
  const [s] = encodeSixel(solid(4, 4, 10, 20, 30), { columns: 2, rows: 1 }, undefined, CELL);
  expect(s!.startsWith("\x1bP0;1;0q")).toBe(true);
  expect(s!.endsWith("\x1b\\")).toBe(true);
  // 2 columns x 8 px, 1 row x 16 px, aspect pinned 1:1.
  expect(s).toContain('"1;1;16;16');
});

// The classic Sixel mistake: components are PERCENTAGES, 0-100. Sending
// 0-255 clips everything to white.
test("colour components are percentages, not 0-255", () => {
  const [s] = encodeSixel(solid(2, 2, 255, 0, 0), { columns: 1, rows: 1 }, undefined, CELL);
  expect(s).toContain("#0;2;100;0;0");
  expect(s).not.toContain(";2;255;");
});

test("a mid grey lands halfway up the percentage scale", () => {
  const [s] = encodeSixel(solid(2, 2, 128, 128, 128), { columns: 1, rows: 1 }, undefined, CELL);
  expect(s).toContain("#0;2;50;50;50");
});

// `-` advances a band and `$` returns to the start of one. Confusing them
// either loses every colour after the first or stacks all bands on one.
test("bands are separated by newlines, one fewer than there are bands", () => {
  // 1 row of 16 px is ceil(16/6) = 3 bands.
  const [s] = encodeSixel(solid(4, 4, 1, 2, 3), { columns: 1, rows: 1 }, undefined, CELL);
  expect((s!.match(/-/g) ?? []).length).toBe(2);
});

test("a solid image run-length encodes instead of repeating characters", () => {
  const [s] = encodeSixel(solid(4, 4, 9, 9, 9), { columns: 20, rows: 1 }, undefined, CELL);
  // 20 columns x 8 px = 160 identical characters per band.
  expect(s).toContain("!160");
});

// --- the palette ----------------------------------------------------------

// The regression the independent oracle caught. A screenshot is mostly one
// background tone, and the pixel-weighted median puts everything on one side
// when the dominant colour also sorts last on the split channel. That used
// to abandon the whole splitting loop: measured on this repository's own
// screenshot, 7029 distinct colours collapsed to a palette of 4.
test("a dominant colour does not collapse the palette", () => {
  const width = 200;
  const height = 200;
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // 90% pure white -- which sorts LAST on every channel, the condition
    // that triggered the collapse -- and 10% spread widely enough to need
    // more than 256 registers.
    // Indexed by k, not i: i steps by 10, so any multiplier times it is
    // even and mod 256 yields only 128 distinct values -- not enough to
    // need 256 registers, which is the whole point of this fixture.
    const k = i / 10;
    if (i % 10 === 0) px.set([(k * 37) % 256, (k * 61) % 256, (k * 97) % 256, 255], i * 4);
    else px.set([255, 255, 255, 255], i * 4);
  }
  const rgb = resampleRGB({ width, height, pixels: px }, width, height);
  expect(medianCut(rgb, 256)).toHaveLength(256);
});

test("a gradient with more colours than registers fills the palette", () => {
  const rgb = resampleRGB(gradient(120, 120), 120, 120);
  expect(medianCut(rgb, 256)).toHaveLength(256);
  expect(medianCut(rgb, 16)).toHaveLength(16);
});

// Fewer distinct colours than registers must not invent entries: duplicated
// palette slots would waste registers and could exceed a terminal's limit
// for no gain.
test("an image with few colours yields a palette no larger than it needs", () => {
  const rgb = resampleRGB(solid(8, 8, 7, 7, 7), 8, 8);
  expect(medianCut(rgb, 256)).toHaveLength(1);
});

test("the palette entries are the average of the colours they cover", () => {
  // Two far-apart colours, equal counts: two registers, one each.
  const px = new Uint8Array(4 * 4);
  px.set([0, 0, 0, 255], 0);
  px.set([0, 0, 0, 255], 4);
  px.set([255, 255, 255, 255], 8);
  px.set([255, 255, 255, 255], 12);
  const rgb = resampleRGB({ width: 4, height: 1, pixels: px }, 4, 1);
  const palette = medianCut(rgb, 2);
  expect(palette).toHaveLength(2);
  const sorted = [...palette].sort((a, b) => a.r - b.r);
  expect(sorted[0]).toEqual({ r: 0, g: 0, b: 0 });
  expect(sorted[1]).toEqual({ r: 255, g: 255, b: 255 });
});

// --- the cell-size assumption --------------------------------------------

test("the assumed cell is small on purpose, and overridable", () => {
  expect(resolveCellPixels({} as never)).toEqual(CELL_PIXELS);
  expect(resolveCellPixels({ CANVAS_CELL_PIXELS: "10x20" } as never)).toEqual({
    width: 10,
    height: 20,
  });
  // Under-filling leaves a gap; overflowing pushes the footer off screen.
  expect(CELL_PIXELS.width).toBeLessThanOrEqual(10);
  expect(CELL_PIXELS.height).toBeLessThanOrEqual(20);
});

test("a malformed cell override is reported, not ignored", () => {
  for (const bad of ["10", "10x", "axb", "0x20", "10x0", "-4x8"]) {
    expect(() => resolveCellPixels({ CANVAS_CELL_PIXELS: bad } as never)).toThrow(
      /Invalid CANVAS_CELL_PIXELS/
    );
  }
});

// --- the independent oracle ----------------------------------------------

function sixel2png(): string | null {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const p = join(dir, "sixel2png");
    try {
      readFileSync(p);
      return p;
    } catch {
      // not there
    }
  }
  return Bun.which("sixel2png");
}

const ORACLE = sixel2png();

// Verified against libsixel, not against itself: a round trip through my own
// parser cannot catch an encoder that is consistently wrong, and this one
// WAS -- the palette collapse above was found exactly here. Skipped when
// libsixel is absent (CI has no `brew install libsixel`), which is why the
// structural tests above stand on their own.
test.skipIf(ORACLE === null)("libsixel decodes the output back to the source image", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-sixel-"));
  const img = gradient(160, 160);
  const placement = { columns: 20, rows: 6 };
  const width = placement.columns * CELL.width;
  const height = placement.rows * CELL.height;

  writeFileSync(join(dir, "a.sixel"), encodeSixel(img, placement, undefined, CELL)[0]!);
  const run = Bun.spawnSync([ORACLE!, "-i", join(dir, "a.sixel"), "-o", join(dir, "a.png")]);
  expect(run.exitCode).toBe(0);

  // sixel2png writes 8-bit RGB, which the production decoder reads. That
  // decoder is itself verified against a separate Python implementation, so
  // neither half of this comparison is checking its own work.
  const back = decodePng(new Uint8Array(readFileSync(join(dir, "a.png"))));
  expect(back.width).toBe(width);
  expect(back.height).toBe(height);

  const want = resampleRGB(img, width, height);
  let total = 0;
  for (let i = 0, o = 0; i < want.length; i += 3, o += 4) {
    total += Math.abs(back.pixels[o]! - want[i]!);
    total += Math.abs(back.pixels[o + 1]! - want[i + 1]!);
    total += Math.abs(back.pixels[o + 2]! - want[i + 2]!);
  }
  const mean = total / want.length;
  // Cannot be zero: Sixel quantises to 256 registers AND expresses each
  // component as a 0-100 percentage, so 255 -> 100 -> 255 loses precision.
  // Measured 1.21/255 on this repository's screenshot at 320x192; 6 is a
  // ceiling that a real regression breaks and normal quantisation does not.
  expect(mean).toBeLessThan(6);
  expect(mean).toBeGreaterThan(0);
});
