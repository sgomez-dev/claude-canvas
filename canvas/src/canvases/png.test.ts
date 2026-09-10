import { test, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, PngDecodeError } from "./png";
// The test-only PNG encoder lives in the harness, as its single home:
// test/snapshots/image.test.tsx and test/integration/image.test.tsx need
// the same fixtures, and a second copy of an encoder is a second thing to
// keep in step with the decoder it exists to test.
import { SIGNATURE, chunk, join, ihdr, encode, pattern } from "../../test/harness/png";


// --- round trips ---------------------------------------------------------

// Each filter type separately: the repository's real screenshot uses only
// filter 2, so nothing else would exercise Sub, Average or Paeth. Average
// and Paeth are where the arithmetic is easy to get subtly wrong -- both
// read the pixel above-left, and both have to treat out-of-bounds as zero.
for (const filter of [0, 1, 2, 3, 4]) {
  test(`round-trips RGBA through scanline filter ${filter}`, () => {
    const pixels = pattern(9, 7, 4);
    const decoded = decodePng(encode(9, 7, 4, pixels, filter));
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(7);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });
}

test("an RGB file is normalised to RGBA with opaque alpha", () => {
  const rgb = pattern(5, 4, 3);
  const decoded = decodePng(encode(5, 4, 3, rgb, 4));
  expect(decoded.pixels.byteLength).toBe(5 * 4 * 4);
  for (let p = 0, q = 0; p < rgb.byteLength; p += 3, q += 4) {
    expect(decoded.pixels[q]).toBe(rgb[p]);
    expect(decoded.pixels[q + 1]).toBe(rgb[p + 1]);
    expect(decoded.pixels[q + 2]).toBe(rgb[p + 2]);
    expect(decoded.pixels[q + 3]).toBe(255);
  }
});

test("a single-pixel image decodes, where every neighbour is out of bounds", () => {
  const one = new Uint8Array([10, 20, 30, 40]);
  for (const filter of [0, 1, 2, 3, 4]) {
    expect([...decodePng(encode(1, 1, 4, one, filter)).pixels]).toEqual([...one]);
  }
});

// --- a real file from a real encoder -------------------------------------

// The screenshot committed in this repository: 3384x2160, 8-bit RGBA,
// non-interlaced, and split across hundreds of 4096-byte IDAT chunks, which
// is what exercises the chunk joining. The expected values below were
// produced by an INDEPENDENT decoder (a Python implementation over zlib),
// not by this one -- a round trip against my own encoder cannot catch a
// decoder that is consistently wrong.
test("decodes a real multi-IDAT screenshot, matching an independent decoder", async () => {
  const bytes = new Uint8Array(await Bun.file("media/screenshot.png").arrayBuffer());
  const img = decodePng(bytes);

  expect(img.width).toBe(3384);
  expect(img.height).toBe(2160);
  expect(img.pixels.byteLength).toBe(3384 * 2160 * 4);

  const at = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]];
  };
  expect(at(0, 0)).toEqual([2, 30, 52, 255]);
  expect(at(1, 0)).toEqual([1, 29, 52, 255]);
  expect(at(0, 1)).toEqual([2, 30, 52, 255]);
  expect(at(1692, 1080)).toEqual([39, 43, 52, 255]);
  expect(at(3383, 2159)).toEqual([135, 30, 10, 255]);

  // Every byte, not just five pixels: a filter bug that only shows up in
  // one region would slip past sampled assertions.
  let sum = 0;
  for (const b of img.pixels) sum += b;
  expect(sum).toBe(2930253536);
});

// --- refusals ------------------------------------------------------------

test("rejects anything that is not a PNG", () => {
  expect(() => decodePng(new Uint8Array(0))).toThrow(PngDecodeError);
  expect(() => decodePng(new Uint8Array(64))).toThrow(/signature does not match/);
  expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
});

// The supported subset is stated rather than discovered, and each refusal
// names what the file actually is: a silent wrong render is worse than a
// refusal, and "unsupported" with no detail sends the caller guessing.
test("refuses colour types outside RGB and RGBA, naming them", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 3), ...body]))).toThrow(/palette/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 0), ...body]))).toThrow(/greyscale/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 4), ...body]))).toThrow(
    /greyscale with alpha/
  );
});

test("refuses 16-bit and interlaced files", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6, 16), ...body]))).toThrow(/bit depth 16/);
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6, 8, 1), ...body]))).toThrow(/interlaced/);
});

// Checked BEFORE allocating: a header is eight bytes that can claim any
// dimensions, so a malformed file could otherwise ask for tens of gigabytes.
test("refuses dimensions past the pixel ceiling without allocating them", () => {
  const body = [chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8)))), chunk("IEND", new Uint8Array(0))];
  expect(() => decodePng(join([SIGNATURE, ihdr(65535, 65535, 6), ...body]))).toThrow(
    /too large: 65535x65535/
  );
  expect(() => decodePng(join([SIGNATURE, ihdr(0, 4, 6), ...body]))).toThrow(/zero extent/);
});

test("refuses a structurally broken file rather than rendering garbage", () => {
  const idat = chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(8))));
  // No IHDR at all.
  expect(() => decodePng(join([SIGNATURE, idat, chunk("IEND", new Uint8Array(0))]))).toThrow(
    /IDAT before IHDR/
  );
  // Header but no image data.
  expect(() => decodePng(join([SIGNATURE, ihdr(2, 2, 6), chunk("IEND", new Uint8Array(0))]))).toThrow(
    /no image data/
  );
  // A chunk claiming more bytes than the file holds.
  const truncated = join([SIGNATURE, ihdr(2, 2, 6), idat]);
  const lied = truncated.slice(0, truncated.byteLength - 6);
  expect(() => decodePng(lied)).toThrow(/truncated PNG/);
});

test("refuses image data that is not a valid zlib stream", () => {
  const garbage = chunk("IDAT", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(() =>
    decodePng(join([SIGNATURE, ihdr(2, 2, 6), garbage, chunk("IEND", new Uint8Array(0))]))
  ).toThrow(/could not be decompressed/);
});

test("refuses an unrecognised scanline filter", () => {
  const stride = 2 * 4;
  const raw = new Uint8Array((stride + 1) * 2);
  raw[0] = 9; // no such filter
  const bad = join([
    SIGNATURE,
    ihdr(2, 2, 6),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
  expect(() => decodePng(bad)).toThrow(/unrecognised PNG scanline filter 9 on row 0/);
});

test("refuses image data shorter than the header's dimensions require", () => {
  const short = new Uint8Array(4); // nowhere near (2*4+1)*2
  const bad = join([
    SIGNATURE,
    ihdr(2, 2, 6),
    chunk("IDAT", new Uint8Array(deflateSync(short))),
    chunk("IEND", new Uint8Array(0)),
  ]);
  expect(() => decodePng(bad)).toThrow(/truncated PNG image data/);
});

// A "zlib bomb": a tiny compressed IDAT that inflates to far more than a
// 2x2 header could ever need. All-zero data compresses at roughly 1000:1,
// so 20 MB of zeros (a few KB compressed) is already ~1.1 million times more
// than the 18 bytes this header requires -- enough to prove the bound is
// enforced without needing gigabytes in a test run. Before the fix, this
// call to inflateSync had no maxOutputLength and would inflate the entire
// payload before the post-inflate size check ever ran.
test("refuses a compressed payload that would inflate to far more than the header requires, without allocating it", () => {
  const huge = deflateSync(new Uint8Array(20 * 1024 * 1024)); // 20 MB of zeros
  const bomb = join([
    SIGNATURE,
    ihdr(2, 2, 6),
    chunk("IDAT", new Uint8Array(huge)),
    chunk("IEND", new Uint8Array(0)),
  ]);
  const before = process.memoryUsage().rss;
  expect(() => decodePng(bomb)).toThrow(/could not be decompressed/);
  const after = process.memoryUsage().rss;
  // Generous margin -- this just proves the decoder didn't materialise the
  // full ~20 MB inflated buffer (let alone the 6 GB an unbounded version of
  // this attack was independently measured to allocate).
  expect(after - before).toBeLessThan(15 * 1024 * 1024);
});
